import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createAuth } from './auth.ts'
import { createJellyfin } from './jellyfin.ts'
import { proxyRequest, readBody, stopRoomStreams } from './proxy.ts'
import { apply, createRoom, parseCommand, sweepRooms, type Room } from './room.ts'

/** windowStart/count/strikes: websocket rate limit state, see overLimit. */
type Client = { ws: WebSocket; name: string; isHost: boolean; windowStart: number; count: number; strikes: number }

const alive = new WeakSet<WebSocket>()

const MAX_MESSAGES_PER_SECOND = 20
const MAX_STRIKES = 5
const MAX_CLIENTS_PER_ROOM = 50
/** A client this far behind on reading is dropped rather than buffering every state for it. */
const MAX_BUFFERED_BYTES = 1_000_000
const BROADCAST_DELAY_MS = 50
const WEB_DIR = join(import.meta.dirname, '..', 'web')
const HLS_JS = join(import.meta.dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js')
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
}

const PORT = Number(process.env.PORT ?? 8080)
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`
const PUBLIC_HOST = new URL(PUBLIC_URL).host
const jf = createJellyfin(required('JELLYFIN_URL').replace(/\/$/, ''), required('JELLYFIN_API_KEY'), process.env.JELLYFIN_USER_ID || undefined)
const SECURE = PUBLIC_URL.startsWith('https:')
const auth = createAuth(required('HOST_PASSWORD'), SECURE)
/** Room passwords, kept out of Room so they are never broadcast. */
const locks = new Map<string, { password: string; auth: ReturnType<typeof createAuth> }>()

const rooms = new Map<string, Room>()
const clients = new Map<string, Set<Client>>()
const emptySince = new Map<string, number>()
const pendingBroadcasts = new Set<Room>()
let flushTimer: NodeJS.Timeout | undefined
let jellyfinError: string | null = 'Not checked yet'

function required(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Missing required env var ${name}`)
    }
    return value
}

// --- room state fan-out ---

function stateMessage(room: Room): string {
    const viewers = [...(clients.get(room.id) ?? [])].map(c => c.name)
    return JSON.stringify({ type: 'state', room, viewers, serverNow: Date.now() })
}

/** Every websocket send goes through here so a client that stops reading is dropped, not buffered for. */
function send(client: Client, data: string): void {
    if (client.ws.readyState !== WebSocket.OPEN) {
        return
    }
    if (client.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        client.ws.terminate()
        return
    }
    client.ws.send(data)
}

/** Coalesces state fan-out: at most one broadcast per room per BROADCAST_DELAY_MS, however many changes. */
function broadcast(room: Room): void {
    pendingBroadcasts.add(room)
    flushTimer ??= setTimeout(flushBroadcasts, BROADCAST_DELAY_MS)
}

function flushBroadcasts(): void {
    flushTimer = undefined
    for (const room of pendingBroadcasts) {
        sendState(room)
    }
    pendingBroadcasts.clear()
}

function sendState(room: Room): void {
    const message = stateMessage(room)
    for (const client of clients.get(room.id) ?? []) {
        send(client, message)
    }
}

// --- http ---

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function sendFile(res: ServerResponse, path: string): Promise<void> {
    try {
        const body = await readFile(path)
        res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
    } catch {
        res.writeHead(404).end()
    }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    try {
        return JSON.parse(await readBody(req))
    } catch {
        return {}
    }
}

function roomSummary(room: Room) {
    return { id: room.id, title: room.queue[room.index]?.name ?? 'Empty room', viewers: clients.get(room.id)?.size ?? 0, password: locks.get(room.id)?.password ?? '' }
}

/** The host, anyone in a room without a password, or a guest who entered it. */
function mayJoin(req: IncomingMessage, room: Room): boolean {
    const lock = locks.get(room.id)
    return !lock || auth.isLoggedIn(req) || lock.auth.isLoggedIn(req)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    const proxied = /^\/r\/([\w-]+)\/jf(\/.*)$/.exec(path)
    if (proxied) {
        const room = rooms.get(proxied[1])
        if (!room) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        // HLS and subtitles are fetched cookie-less by Chromecast; they are bound to play sessions PlaybackInfo issued
        if (/\/PlaybackInfo$/i.test(proxied[2]) && !mayJoin(req, room)) {
            return sendJson(res, 401, { error: 'Room password required' })
        }
        return proxyRequest(req, res, room, proxied[2] + url.search, jf)
    }

    if (method === 'GET') {
        if (path === '/') {
            return sendFile(res, join(WEB_DIR, 'host.html'))
        }
        if (/^\/r\/[\w-]+$/.test(path)) {
            return sendFile(res, join(WEB_DIR, 'room.html'))
        }
        if (path === '/vendor/hls.min.js') {
            return sendFile(res, HLS_JS)
        }
        const asset = /^\/web\/([\w-]+\.(?:js|css|html))$/.exec(path)
        if (asset) {
            return sendFile(res, join(WEB_DIR, asset[1]))
        }
        if (path === '/api/health') {
            return sendJson(res, 200, { ok: true })
        }
        if (path === '/api/me') {
            return sendJson(res, 200, { host: auth.isLoggedIn(req), jellyfinError })
        }
    }

    const roomAccess = /^\/api\/rooms\/([\w-]+)\/(access|join)$/.exec(path)
    if (roomAccess) {
        const room = rooms.get(roomAccess[1])
        if (!room) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        if (method === 'GET' && roomAccess[2] === 'access') {
            return sendJson(res, 200, { locked: locks.has(room.id), allowed: mayJoin(req, room) })
        }
        if (method === 'POST' && roomAccess[2] === 'join') {
            const lock = locks.get(room.id)
            const body = await readJson(req)
            const token = lock?.auth.login(String(body.password ?? ''), req.socket.remoteAddress ?? '')
            if (!lock) {
                return sendJson(res, 200, { ok: true })
            }
            if (!token) {
                return sendJson(res, 401, { error: 'Wrong password' })
            }
            res.setHeader('set-cookie', lock.auth.cookie(token))
            return sendJson(res, 200, { ok: true })
        }
    }

    if (method === 'POST' && path === '/api/login') {
        const body = await readJson(req)
        // ponytail: behind a reverse proxy all logins share the proxy's ip, making the limit global
        const token = auth.login(String(body.password ?? ''), req.socket.remoteAddress ?? '')
        if (!token) {
            return sendJson(res, 401, { error: 'Wrong password or too many attempts' })
        }
        res.setHeader('set-cookie', auth.cookie(token))
        return sendJson(res, 200, { ok: true })
    }

    if (!auth.isLoggedIn(req)) {
        return sendJson(res, 403, { error: 'Host login required' })
    }

    if (method === 'GET' && path === '/api/rooms') {
        return sendJson(res, 200, [...rooms.values()].map(roomSummary))
    }
    if (method === 'POST' && path === '/api/rooms') {
        const id = randomBytes(16).toString('base64url')
        rooms.set(id, createRoom(id, Date.now()))
        return sendJson(res, 200, { id })
    }
    const setting = method === 'POST' ? /^\/api\/rooms\/([\w-]+)\/password$/.exec(path) : null
    if (setting) {
        const room = rooms.get(setting[1])
        if (!room) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        const password = String((await readJson(req)).password ?? '').slice(0, 100)
        if (password) {
            locks.set(room.id, { password, auth: createAuth(password, SECURE, `wp_room_${room.id}`) })
        } else {
            locks.delete(room.id)
        }
        return sendJson(res, 200, { ok: true })
    }
    const ending = method === 'DELETE' ? /^\/api\/rooms\/([\w-]+)$/.exec(path) : null
    if (ending) {
        const room = rooms.get(ending[1])
        if (!room) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        await endRoom(room)
        return sendJson(res, 200, { ok: true })
    }
    if (method === 'GET' && path === '/api/search') {
        return sendJson(res, 200, await jf.search(url.searchParams.get('q') ?? ''))
    }
    if (method === 'GET' && path === '/api/library') {
        const type = url.searchParams.get('type') === 'Series' ? 'Series' : 'Movie'
        return sendJson(res, 200, await jf.library(type, Math.max(0, Number(url.searchParams.get('start')) || 0)))
    }
    if (method === 'GET' && path === '/api/image') {
        const id = url.searchParams.get('id') ?? ''
        if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
            return sendJson(res, 400, { error: 'Bad id' })
        }
        const image = await jf.image(id)
        if (!image.ok || !image.body) {
            res.writeHead(404).end()
            return
        }
        res.writeHead(200, { 'content-type': image.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'private, max-age=86400' })
        res.end(Buffer.from(await image.arrayBuffer()))
        return
    }
    if (method === 'GET' && path === '/api/children') {
        return sendJson(res, 200, await jf.children(url.searchParams.get('id') ?? ''))
    }

    return sendJson(res, 404, { error: 'Not found' })
}

const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
        if (err.name !== 'AbortError') {
            console.error(`${req.method} ${req.url} failed:`, err.message)
        }
        if (res.headersSent) {
            res.destroy()
        } else {
            sendJson(res, 502, { error: 'Upstream error' })
        }
    })
})

/** Host ends the room: everyone is disconnected as from a deleted room and its transcodes stop. */
async function endRoom(room: Room): Promise<void> {

    rooms.delete(room.id)
    emptySince.delete(room.id)
    locks.delete(room.id)
    for (const client of clients.get(room.id) ?? []) {
        client.ws.close(4404, 'Room ended')
    }
    clients.delete(room.id)
    await stopRoomStreams(room, jf)
}

// --- websockets ---

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

server.on('upgrade', (req, socket, head) => {
    try {
        const match = /^\/ws\/([\w-]+)$/.exec(URL.parse(req.url ?? '/', 'http://localhost')?.pathname ?? '')
        const room = match ? rooms.get(match[1]) : undefined
        // cross-site websocket hijacking: browsers always send Origin, so a foreign one means another site's page
        const origin = req.headers.origin
        // a reverse proxy may rewrite Host, so PUBLIC_URL's host counts as same-site too
        const originHost = origin === undefined ? undefined : URL.parse(origin)?.host
        if (!match || (origin !== undefined && originHost !== req.headers.host && originHost !== PUBLIC_HOST)) {
            socket.destroy()
            return
        }
        if (!room) {
            // a close code, unlike a refused upgrade, tells clients of a deleted room to stop reconnecting
            wss.handleUpgrade(req, socket, head, ws => ws.close(4404, 'Room not found'))
            return
        }
        if (!mayJoin(req, room)) {
            wss.handleUpgrade(req, socket, head, ws => ws.close(4401, 'Room password required'))
            return
        }
        if ((clients.get(room.id)?.size ?? 0) >= MAX_CLIENTS_PER_ROOM) {
            socket.destroy()
            return
        }
        wss.handleUpgrade(req, socket, head, ws => onJoin(ws, room, auth.isLoggedIn(req)))
    } catch (err) {
        console.error('Upgrade failed:', (err as Error).message)
        socket.destroy()
    }
})

function onJoin(ws: WebSocket, room: Room, isHost: boolean): void {

    const client: Client = { ws, name: 'Guest', isHost, windowStart: 0, count: 0, strikes: 0 }
    const set = clients.get(room.id) ?? new Set<Client>()
    clients.set(room.id, set)
    set.add(client)
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    // oversized or malformed frames emit 'error'; unhandled it would crash the process
    ws.on('error', () => ws.terminate())
    send(client, JSON.stringify({ type: 'welcome', isHost }))
    broadcast(room)

    ws.on('message', data => {
        if (overLimit(client, Date.now())) {
            if (client.strikes >= MAX_STRIKES) {
                ws.terminate()
            }
            return
        }
        let msg: unknown
        try {
            msg = JSON.parse(String(data))
        } catch {
            return
        }
        if (typeof msg !== 'object' || msg === null) {
            return
        }
        onMessage(client, room, msg as Record<string, unknown>).catch((err: Error) => {
            console.error('Room message failed:', err.message)
            send(client, JSON.stringify({ type: 'error', message: err.message }))
        })
    })

    ws.on('close', () => {
        set.delete(client)
        broadcast(room)
    })
}

/**
 * Counts a message; true when it exceeds the per-second limit and must be dropped.
 * strikes counts consecutive seconds over the limit.
 */
// ponytail: fixed one-second windows rather than a sliding log; bursts across a window edge get up to 2x through
function overLimit(client: Client, now: number): boolean {

    const elapsed = now - client.windowStart
    if (elapsed >= 1000) {
        if (client.count <= MAX_MESSAGES_PER_SECOND || elapsed >= 2000) {
            client.strikes = 0
        }
        client.windowStart = now
        client.count = 0
    }

    client.count++
    if (client.count === MAX_MESSAGES_PER_SECOND + 1) {
        client.strikes++
    }

    return client.count > MAX_MESSAGES_PER_SECOND
}

async function onMessage(client: Client, room: Room, msg: Record<string, unknown>): Promise<void> {

    const now = Date.now()
    switch (msg.type) {
        case 'hello': {
            const name = String(msg.name ?? '').trim().slice(0, 32) || 'Guest'
            if (name === client.name) {
                return
            }
            client.name = name
            break
        }
        case 'ping':
            send(client, JSON.stringify({ type: 'pong', t0: Number(msg.t0) || 0, server: now }))
            return
        case 'cmd': {
            const cmd = parseCommand(msg.cmd)
            if (!cmd || !apply(room, cmd, client.isHost, now)) {
                send(client, stateMessage(room)) // rejected: resync the sender
                return
            }
            break
        }
        case 'addItem':
            if (!client.isHost) {
                return
            }
            apply(room, { type: 'queueAdd', items: await jf.queueItems(String(msg.itemId)) }, true, now)
            break
        default:
            return
    }

    broadcast(room)
}

// --- background loops ---

setInterval(() => {
    const { advanced, deleted } = sweepRooms(rooms, id => clients.get(id)?.size ?? 0, emptySince, Date.now())
    advanced.forEach(broadcast)
    for (const id of deleted) {
        clients.delete(id)
        locks.delete(id)
    }
}, 1000)

setInterval(() => {
    for (const ws of wss.clients) {
        if (!alive.delete(ws)) {
            ws.terminate()
            continue
        }
        ws.ping()
    }
}, 30_000)

async function checkJellyfin(): Promise<void> {
    const before = jellyfinError
    try {
        const info = await jf.systemInfo()
        await jf.resolveUser()
        jellyfinError = null
        if (before !== null) {
            console.log(`Connected to Jellyfin "${info.ServerName}" ${info.Version}`)
        }
    } catch (err) {
        jellyfinError = `Cannot reach Jellyfin: ${(err as Error).message}`
        if (before !== jellyfinError) {
            console.error(jellyfinError)
        }
    }
}

// rooms live in memory only: log a missed error path rather than lose every room
process.on('uncaughtException', err => console.error('Uncaught:', err))
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err))

checkJellyfin()
setInterval(checkJellyfin, 30_000)
server.listen(PORT, () => console.log(`Watchparty listening on :${PORT} (${PUBLIC_URL})`))
