import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createAuth } from './auth.ts'
import { createConductor } from './conductor.ts'
import { createJellyfin } from './jellyfin.ts'
import { proxyRequest, readBody } from './proxy.ts'
import { advanceIfEnded, apply, createRoom, parseCommand, type Room } from './room.ts'

/** windowStart/count/strikes: websocket rate limit state, see overLimit. */
type Client = { ws: WebSocket; name: string; isHost: boolean; windowStart: number; count: number; strikes: number }

const alive = new WeakSet<WebSocket>()

const ROOM_TTL_MS = 30 * 60_000
const MAX_MESSAGES_PER_SECOND = 20
const MAX_STRIKES = 5
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
const auth = createAuth(required('HOST_PASSWORD'), PUBLIC_URL.startsWith('https:'))

const rooms = new Map<string, Room>()
const clients = new Map<string, Set<Client>>()
const emptySince = new Map<string, number>()
const conductor = createConductor(jf, rooms, broadcast)
let jellyfinError: string | null = 'Not checked yet'

function required(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Missing required env var ${name}`)
    }
    return value
}

// --- room state fan-out ---

/** Guests see native players only by device and status, never Jellyfin session ids or usernames. */
function stateMessage(room: Room, isHost: boolean): string {
    const viewers = [...(clients.get(room.id) ?? [])].map(c => c.name)
    const visible = isHost ? room : { ...room, nativeSessions: room.nativeSessions.map(n => ({ label: n.device, status: n.status })) }
    return JSON.stringify({ type: 'state', room: visible, viewers, serverNow: Date.now() })
}

function broadcast(room: Room): void {
    const messages = { host: stateMessage(room, true), guest: stateMessage(room, false) }
    for (const client of clients.get(room.id) ?? []) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(client.isHost ? messages.host : messages.guest)
        }
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
    return { id: room.id, title: room.queue[room.index]?.name ?? 'Empty room', viewers: clients.get(room.id)?.size ?? 0 }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    const proxied = /^\/r\/([\w-]+)\/jf(\/.*)$/.exec(path)
    if (proxied) {
        const room = rooms.get(proxied[1])
        return room ? proxyRequest(req, res, room, proxied[2] + url.search, jf) : sendJson(res, 404, { error: 'Room not found' })
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
            return sendJson(res, 200, { host: auth.isHost(req), jellyfinError })
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

    if (!auth.isHost(req)) {
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
    if (method === 'GET' && path === '/api/search') {
        return sendJson(res, 200, await jf.search(url.searchParams.get('q') ?? ''))
    }
    if (method === 'GET' && path === '/api/sessions') {
        const sessions = (await jf.sessions()).filter(s => s.SupportsRemoteControl)
        return sendJson(res, 200, sessions.map(s => ({ id: s.Id, label: `${s.UserName ?? 'Unknown'} – ${s.DeviceName} (${s.Client})`, device: `${s.DeviceName} (${s.Client})` })))
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
        if (!room || (origin !== undefined && originHost !== req.headers.host && originHost !== PUBLIC_HOST)) {
            socket.destroy()
            return
        }
        wss.handleUpgrade(req, socket, head, ws => onJoin(ws, room, auth.isHost(req)))
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
    ws.send(JSON.stringify({ type: 'welcome', isHost }))
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
            ws.send(JSON.stringify({ type: 'error', message: err.message }))
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
        case 'hello':
            client.name = String(msg.name ?? '').trim().slice(0, 32) || 'Guest'
            break
        case 'ping':
            client.ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, server: now }))
            return
        case 'cmd': {
            const cmd = parseCommand(msg.cmd)
            if (!cmd || !apply(room, cmd, client.isHost, now)) {
                client.ws.send(stateMessage(room, client.isHost)) // rejected: resync the sender
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
        case 'nativeAdd': {
            if (!client.isHost) {
                return
            }
            const sessionId = String(msg.sessionId)
            const trusted = msg.trusted === true
            const device = String(msg.device ?? 'Device').slice(0, 80)
            const existing = room.nativeSessions.find(n => n.sessionId === sessionId)
            if (existing) {
                existing.status = 'syncing'
                existing.trusted = trusted
                existing.device = device
            } else {
                room.nativeSessions.push({ sessionId, label: String(msg.label ?? sessionId).slice(0, 80), device, trusted, status: 'syncing' })
            }
            conductor.reset(room.id, sessionId)
            break
        }
        case 'nativeRemove':
            if (!client.isHost) {
                return
            }
            room.nativeSessions = room.nativeSessions.filter(n => n.sessionId !== msg.sessionId)
            conductor.reset(room.id, String(msg.sessionId))
            break
        default:
            return
    }

    broadcast(room)
}

// --- background loops ---

setInterval(() => {
    const now = Date.now()
    for (const room of rooms.values()) {
        if (advanceIfEnded(room, now)) {
            broadcast(room)
        }
        const idle = (clients.get(room.id)?.size ?? 0) === 0 && !room.nativeSessions.some(n => n.status === 'syncing')
        if (!idle) {
            emptySince.delete(room.id)
            continue
        }
        const since = emptySince.get(room.id) ?? now
        emptySince.set(room.id, since)
        if (now - since > ROOM_TTL_MS) {
            rooms.delete(room.id)
            clients.delete(room.id)
            emptySince.delete(room.id)
            conductor.forgetRoom(room.id)
        }
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

setInterval(() => {
    conductor.tick().catch((err: Error) => console.error('Conductor:', err.message))
}, 1000)

async function checkJellyfin(): Promise<void> {
    const before = jellyfinError
    try {
        const info = await jf.systemInfo()
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
