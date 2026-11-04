import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createAuth, parseCookies, sessionCookie } from './auth.ts'
import { createUsers, type Account } from './users.ts'
import { createHistory } from './history.ts'
import { loadJson, saveJson } from './store.ts'
import { icsEvent, postToDiscord } from './notify.ts'
import { createJellyfin, type Card, type Segment } from './jellyfin.ts'
import { createTmdb, type TmdbType } from './tmdb.ts'
import { activeStreams, proxyRequest, readBody, stopRoomStreams } from './proxy.ts'
import { apply, createRoom, currentPosition, describe, parseCommand, playNext, voteWinner, setWaiting, sweepRooms, type Room } from './room.ts'

/**
 * windowStart/count/strikes: websocket rate limit state, see overLimit. bufferingSince: 0 unless the client's player is loading.
 * speed: the viewer's measured download speed in Mbps, 0 until reported.
 */
type Client = { id: string; token: string | null; ws: WebSocket; name: string; lastReaction: number; lastChat: number; isHost: boolean; observer: boolean; windowStart: number; count: number; strikes: number; bufferingSince: number; lastBufferStart: number; lastBufferEnd: number; speed: number }

const alive = new WeakSet<WebSocket>()

const MAX_MESSAGES_PER_SECOND = 20
const MAX_STRIKES = 5
const REACTIONS = new Set(['😂', '😢', '😮', '😍', '👏', '😱', '🔥'])
const CHAT_GAP_MS = 500
const CHAT_HISTORY = 100
const MAX_CHAT_LENGTH = 500
/** GIFs are only ever shown from GIPHY's own media servers, so a message can't make viewers load any other URL. */
const GIPHY_MEDIA = /^https:\/\/media\d*\.giphy\.com\/media\/[\w./?=&-]+$/
const REACTION_GAP_MS = 300
const VOTE_MS = 60_000
const ITEM_ID = /^[0-9a-f-]{32,36}$/i
const MAX_SUGGESTIONS = 20
const MAX_CLIENTS_PER_ROOM = 50
/** A client this far behind on reading is dropped rather than buffering every state for it. */
const MAX_BUFFERED_BYTES = 1_000_000
const BROADCAST_DELAY_MS = 50
/** A viewer buffering longer than this no longer holds the room, so one bad connection can't stop everyone. */
const MAX_WAIT_MS = 15_000
const BUFFER_RESUME_MS = 3000
const WEB_DIR = join(import.meta.dirname, '..', 'web')
const HLS_JS = join(import.meta.dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js')
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
}

const PORT = Number(process.env.PORT ?? 8080)
// Coolify's SERVICE_FQDN_* may be a bare domain; it is served over https
const PUBLIC_URL = withScheme(process.env.PUBLIC_URL || `http://localhost:${PORT}`)
const PUBLIC_HOST = new URL(PUBLIC_URL).host
const jf = createJellyfin(required('JELLYFIN_URL').replace(/\/$/, ''), required('JELLYFIN_API_KEY'), process.env.JELLYFIN_USER_ID || undefined)
const SECURE = PUBLIC_URL.startsWith('https:')
const DATA_DIR = process.env.DATA_DIR || join(import.meta.dirname, '..', 'data')
const users = createUsers(DATA_DIR, SECURE, (name, password) => jf.authenticate(name, password))
const history = createHistory(DATA_DIR)
const STARTED_AT = Date.now()
/** Random bytes viewers download to measure their speed; random so no proxy can compress them. */
const SPEED_TEST = randomBytes(4_000_000)
const SPEED_TEST_REPEATS = 10
const LANGUAGE = /^[a-z]{3}$/
const tmdb = process.env.TMDB_API_KEY ? createTmdb(process.env.TMDB_API_KEY) : null
const GIPHY_API_KEY = process.env.GIPHY_API_KEY || ''
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ''
/** Room passwords, kept out of Room so they are never broadcast. */
const locks = new Map<string, { password: string; auth: ReturnType<typeof createAuth> }>()
/**
 * Invite keys, kept out of Room so they are never broadcast: a room's link carries its key, renewed every
 * INVITE_TTL_MS so old links stop letting new people in. previous still works for a short grace period.
 */
const invites = new Map<string, { key: string; at: number; previous: string | null }>()
const INVITE_TTL_MS = 24 * 3600_000
const INVITE_GRACE_MS = 3600_000

const rooms = new Map<string, Room>()
const clients = new Map<string, Set<Client>>()
const emptySince = new Map<string, number>()
/** Per room: who did what, newest last; only its host sees it. */
const logs = new Map<string, Array<{ at: number; name: string; text: string }>>()
const LOG_SIZE = 100
/** position: where the room was in itemId when it was sent, so viewers can jump back to it. */
type ChatMessage = { at: number; name: string; text: string; gif: { url: string; width: number; height: number } | null; itemId: string | null; position: number | null }
/** Per room: the latest chat messages, for viewers who join later. */
const chats = new Map<string, ChatMessage[]>()
const pendingBroadcasts = new Set<Room>()
let flushTimer: NodeJS.Timeout | undefined
let jellyfinError: string | null = 'Not checked yet'
let jellyfinInfo: { ServerName: string; Version: string } | null = null
let accounts: Account[] = [] // Jellyfin's enabled users
/** Per room: the host's item and position last saved to Jellyfin. */
const progress = new Map<string, { itemId: string; position: number; runtime: number }>()

function withScheme(url: string): string {
    return /^https?:\/\//.test(url) ? url : `https://${url}`
}

function required(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Missing required env var ${name}`)
    }
    return value
}

// --- room state fan-out ---

function blockers(room: Room, now: number): Client[] {
    return [...(clients.get(room.id) ?? [])].filter(c => c.bufferingSince > 0 && now - c.bufferingSince < MAX_WAIT_MS)
}

/** Holds a playing room while a viewer buffers; broadcasts when that changes. */
function updateWaiting(room: Room, now = Date.now()): void {
    if (setWaiting(room, room.playing && blockers(room, now).length > 0, now)) {
        broadcast(room)
    }
}

function stateMessage(room: Room): string {
    const now = Date.now()
    const viewers = viewersOf(room).map(c => ({ id: c.id, name: c.name, host: c.isHost }))
    const waitingFor = room.waiting ? blockers(room, now).map(c => c.name) : []
    return JSON.stringify({ type: 'state', room, viewers, waitingFor, serverNow: now })
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

/** Adds to the room's activity log and sends the log to the host's pages. */
function logAction(room: Room, client: Client | 'Bloom', text: string): void {
    const log = logs.get(room.id) ?? []
    logs.set(room.id, log)
    const name = client === 'Bloom' ? 'Bloom' : client.isHost ? `${client.name} (host)` : client.name
    log.push({ at: Date.now(), name, text })
    log.splice(0, log.length - LOG_SIZE)
    sendLog(room)
}

function sendLog(room: Room, only?: Client): void {
    const message = JSON.stringify({ type: 'log', entries: logs.get(room.id) ?? [] })
    for (const client of only ? [only] : clients.get(room.id) ?? []) {
        if (client.isHost) {
            send(client, message)
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

const viewersOf = (room: Room): Client[] => [...(clients.get(room.id) ?? [])].filter(c => !c.observer)

function roomSummary(room: Room) {
    return { id: room.id, name: room.name, viewers: viewersOf(room).length, password: locks.get(room.id)?.password ?? '', link: inviteLink(room) }
}

/** The room's host, or a guest who came in through a current invite link (and gave the password, if it has one). */
function mayJoin(req: IncomingMessage, room: Room): boolean {
    if (isOwner(users.fromRequest(req), room)) {
        return true
    }
    const lock = locks.get(room.id)
    return admitted(req, room) && lock !== undefined && lock.auth.isLoggedIn(req)
}

// --- invite links: /r/<id>?i=<key>; whoever opens a current one gets a cookie that keeps them in the room ---

/** Signs admission cookies; kept in the data volume so guests stay admitted across restarts. */
const SECRET = (() => {
    const file = join(DATA_DIR, 'secret.json')
    const stored = loadJson<{ secret?: string }>(file, {})
    if (!stored.secret) {
        stored.secret = randomBytes(32).toString('base64url')
        saveJson(file, stored)
    }
    return stored.secret
})()

const admissionCookie = (room: Room) => `wp_in_${room.id}`
const admission = (room: Room) => createHmac('sha256', SECRET).update(`admit:${room.id}`).digest('base64url')

function admitted(req: IncomingMessage, room: Room): boolean {
    const presented = Buffer.from(parseCookies(req.headers.cookie).get(admissionCookie(room)) ?? '')
    const expected = Buffer.from(admission(room))
    return presented.length === expected.length && timingSafeEqual(presented, expected)
}

function invite(room: Room, now = Date.now()): { key: string; at: number; previous: string | null } {
    let current = invites.get(room.id)
    if (!current || now - current.at > INVITE_TTL_MS) {
        current = { key: randomBytes(12).toString('base64url'), at: now, previous: current?.key ?? null }
        invites.set(room.id, current)
        const message = JSON.stringify({ type: 'invite', link: `${PUBLIC_URL}/r/${room.id}?i=${current.key}` })
        for (const client of clients.get(room.id) ?? []) {
            if (client.isHost) {
                send(client, message) // the host's page shows the new link
            }
        }
    }
    return current
}

const inviteLink = (room: Room) => `${PUBLIC_URL}/r/${room.id}?i=${invite(room).key}`

function validInvite(room: Room, key: string, now = Date.now()): boolean {
    const current = invite(room, now)
    return key === current.key || (key === current.previous && now - current.at < INVITE_GRACE_MS)
}

/** Every room has a password; guests type it once, besides opening a current invite link. */
/**
 * Sets the room's password. Viewers connected right now stay in (their token carries over), so changing it
 * mid-film only keeps out people who aren't watching, like a guest who was just removed.
 */
function lock(roomId: string, password: string): void {
    const auth = createAuth(password, SECURE, `wp_room_${roomId}`)
    for (const client of clients.get(roomId) ?? []) {
        if (client.token) {
            auth.adopt(client.token)
        }
    }
    locks.set(roomId, { password, auth })
}

const PASSWORD_WORDS = ['otter', 'maple', 'comet', 'pixel', 'tiger', 'lemon', 'ember', 'river', 'cloud', 'cedar', 'falcon', 'velvet', 'mango', 'orbit', 'harbor', 'pepper', 'willow', 'nova', 'aurora', 'fjord']

/** Each host's room password, so a new room keeps the one they chose. */
const PASSWORDS_FILE = join(DATA_DIR, 'passwords.json')
const hostPasswords = loadJson<Record<string, string>>(PASSWORDS_FILE, {})

function rememberPassword(ownerId: string, password: string): void {
    if (hostPasswords[ownerId] !== password) {
        hostPasswords[ownerId] = password
        saveJson(PASSWORDS_FILE, hostPasswords)
    }
}

/** The host's remembered password, or a new one for their first room. */
function hostPassword(ownerId: string): string {
    if (!hostPasswords[ownerId]) {
        rememberPassword(ownerId, newPassword())
    }
    return hostPasswords[ownerId]
}

/** A password a host can read out loud, like "otter-maple-42". */
const newPassword = () => `${PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]}-${PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)]}-${randomInt(10, 100)}`

const isOwner = (user: Account | null, room: Room): boolean => user !== null && user.id === room.owner

/** Everything the admin dashboard shows. */
function overview() {
    const now = Date.now()
    const names = new Map(accounts.map(u => [u.id, u.name]))
    return {
        history: history.summary(now),
        server: { startedAt: STARTED_AT, now, jellyfin: { error: jellyfinError, name: jellyfinInfo?.ServerName ?? '', version: jellyfinInfo?.Version ?? '' }, tmdb: tmdb !== null },
        users: accounts.map(u => ({ ...u, lastLogin: users.lastLogin(u.id), rooms: [...rooms.values()].filter(r => r.owner === u.id).length })),
        rooms: [...rooms.values()].map(room => ({
            id: room.id,
            name: room.name,
            owner: names.get(room.owner) ?? '(unknown user)',
            playing: room.queue[room.index]?.name ?? '',
            state: !room.queue[room.index] ? 'idle' : room.waiting ? 'loading' : room.playing ? 'playing' : 'paused',
            streams: activeStreams(room, now),
            viewers: viewersOf(room).map(c => ({ name: c.name, host: c.isHost, speed: c.speed, buffering: c.bufferingSince > 0 })),
        })),
    }
}

/** Ends the user's rooms, e.g. when they are disabled or deleted in Jellyfin. */
async function endRoomsOf(userId: string): Promise<void> {
    await Promise.all([...rooms.values()].filter(r => r.owner === userId).map(endRoom))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'
    // a private site: keep it out of search results
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive')
    if (path === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /\n')
        return
    }

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

    const roomTool = /^\/r\/([\w-]+)\/(speedtest|subtitles|segments|poster|gifs|search)$/.exec(path)
    if (roomTool) {
        const room = rooms.get(roomTool[1])
        if (!room) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        if (!mayJoin(req, room)) {
            return sendJson(res, 401, { error: 'Room password required' })
        }
        if (roomTool[2] === 'speedtest') {
            // long enough that a burst into router/proxy buffers doesn't pass for the sustained speed
            res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SPEED_TEST.length * SPEED_TEST_REPEATS, 'cache-control': 'no-store' })
            for (let i = 0; i < SPEED_TEST_REPEATS && !res.destroyed; i++) {
                if (!res.write(SPEED_TEST)) {
                    await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve) })
                }
            }
            res.end()
            return
        }
        if (roomTool[2] === 'poster') {
            // the lock screen's artwork: guests can't use /api/image, which needs an account
            const item = room.queue[room.index]
            const image = item ? await jf.image(item.id) : null
            if (!image?.ok) {
                res.writeHead(404).end()
                return
            }
            res.writeHead(200, { 'content-type': image.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'private, max-age=300' })
            res.end(Buffer.from(await image.arrayBuffer()))
            return
        }
        if (roomTool[2] === 'search') {
            // guests suggest from TMDB's catalogue, so a link never reveals what the library holds
            const term = (url.searchParams.get('q') ?? '').trim().slice(0, 100)
            return sendJson(res, 200, term && tmdb ? await tmdb.search(term) : [])
        }
        if (roomTool[2] === 'gifs') {
            return sendJson(res, 200, await searchGifs(url.searchParams.get('q') ?? ''))
        }
        if (roomTool[2] === 'segments') {
            const item = room.queue[room.index]
            return sendJson(res, 200, item ? await jf.segments(item.id).catch(() => []) : [])
        }
        return subtitles(req, res, room, url)
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
        const asset = /^\/web\/([\w-]+\.(?:js|css|html|svg|png|webmanifest))$/.exec(path)
        if (asset) {
            return sendFile(res, join(WEB_DIR, asset[1]))
        }
        if (path === '/api/health') {
            return sendJson(res, 200, { ok: true })
        }
        if (path === '/admin') {
            return sendFile(res, join(WEB_DIR, 'admin.html'))
        }
        if (path === '/nights') {
            return sendFile(res, join(WEB_DIR, 'nights.html'))
        }
        if (path === '/api/me') {
            const user = users.fromRequest(req)
            return sendJson(res, 200, { user: user && { name: user.name, admin: user.admin }, jellyfinError, server: jellyfinInfo?.ServerName ?? '' })
        }
        if (path === '/api/backdrops') {
            // TMDB's public trending art, never the library's own: the login page shows it to anyone
            return sendJson(res, 200, tmdb ? await tmdb.backdrops().catch(() => []) : [])
        }
    }

    const roomAccess = /^\/api\/rooms\/([\w-]+)\/(access|join|invite)$/.exec(path)
    if (roomAccess) {
        const room = rooms.get(roomAccess[1])
        if (!room) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        if (method === 'GET' && roomAccess[2] === 'access') {
            return sendJson(res, 200, { locked: locks.has(room.id), allowed: mayJoin(req, room), invited: admitted(req, room) || isOwner(users.fromRequest(req), room) })
        }
        if (method === 'POST' && roomAccess[2] === 'invite') {
            if (!validInvite(room, String((await readJson(req)).key ?? ''))) {
                return sendJson(res, 403, { error: 'This invite link has expired. Ask the host for the current one.' })
            }
            res.setHeader('set-cookie', sessionCookie(admissionCookie(room), admission(room), SECURE))
            return sendJson(res, 200, { ok: true })
        }
        if (method === 'POST' && roomAccess[2] === 'join') {
            // only someone who opened a current invite link may try passwords: the room id alone isn't enough
            if (!admitted(req, room)) {
                return sendJson(res, 403, { error: 'This invite link has expired. Ask the host for the current one.' })
            }
            const lock = locks.get(room.id)!
            const token = lock.auth.login(String((await readJson(req)).password ?? ''), req.socket.remoteAddress ?? '')
            if (!token) {
                return sendJson(res, 401, { error: 'Wrong password' })
            }
            res.setHeader('set-cookie', lock.auth.cookie(token))
            return sendJson(res, 200, { ok: true })
        }
    }

    if (method === 'POST' && path === '/api/login') {
        const body = await readJson(req)
        const token = await users.login(String(body.username ?? ''), String(body.password ?? ''), req.socket.remoteAddress ?? '').catch(() => null)
        if (!token) {
            return sendJson(res, 401, { error: 'Wrong Jellyfin username or password, or too many attempts' })
        }
        res.setHeader('set-cookie', users.cookie(token))
        return sendJson(res, 200, { ok: true })
    }
    if (method === 'POST' && path === '/api/logout') {
        users.logout(req)
        res.setHeader('set-cookie', users.clearCookie())
        return sendJson(res, 200, { ok: true })
    }

    const user = users.fromRequest(req)
    if (!user) {
        return sendJson(res, 403, { error: 'Login required' })
    }

    if (path.startsWith('/api/admin/')) {
        if (!user.admin) {
            return sendJson(res, 403, { error: 'Admins only' })
        }
        return method === 'GET' && path === '/api/admin/overview' ? sendJson(res, 200, overview()) : sendJson(res, 404, { error: 'Not found' })
    }

    if (method === 'GET' && path === '/api/rooms') {
        return sendJson(res, 200, [...rooms.values()].filter(r => isOwner(user, r)).map(roomSummary))
    }
    if (method === 'POST' && path === '/api/rooms') {
        // one room per host: guests join it by link, so a second one has no use
        const existing = [...rooms.values()].find(r => isOwner(user, r))
        if (existing) {
            return sendJson(res, 200, { id: existing.id })
        }
        const id = randomBytes(16).toString('base64url')
        rooms.set(id, createRoom(id, Date.now(), user.id, `${user.name}'s room`))
        lock(id, hostPassword(user.id))
        return sendJson(res, 200, { id })
    }
    const setting = method === 'POST' ? /^\/api\/rooms\/([\w-]+)\/password$/.exec(path) : null
    if (setting) {
        const room = rooms.get(setting[1])
        if (!room || !isOwner(user, room)) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        const password = String((await readJson(req)).password ?? '').trim().slice(0, 100)
        if (password.length < 4) {
            return sendJson(res, 400, { error: 'A room always has a password: at least 4 characters' })
        }
        lock(room.id, password)
        rememberPassword(room.owner, password) // the host's next room starts with it too
        return sendJson(res, 200, { ok: true })
    }
    const ending = method === 'DELETE' ? /^\/api\/rooms\/([\w-]+)$/.exec(path) : null
    if (ending) {
        const room = rooms.get(ending[1])
        // only its host ends a room; admins can end any room from the dashboard
        if (!room || !(isOwner(user, room) || user.admin)) {
            return sendJson(res, 404, { error: 'Room not found' })
        }
        await endRoom(room)
        return sendJson(res, 200, { ok: true })
    }
    if (method === 'GET' && path === '/api/search') {
        return sendJson(res, 200, await jf.search(url.searchParams.get('q') ?? '', user.id))
    }
    const param = (name: string) => url.searchParams.get(name) ?? ''
    if (method === 'GET' && path === '/api/views') {
        return sendJson(res, 200, await jf.views(user.id))
    }
    if (method === 'GET' && path === '/api/library') {
        return sendJson(res, 200, await jf.library({ parent: param('parent'), genre: param('genre'), sort: param('sort'), start: Math.max(0, Number(param('start')) || 0) }, user.id))
    }
    if (method === 'GET' && path === '/api/latest') {
        return sendJson(res, 200, await jf.latest(param('parent'), user.id))
    }
    if (method === 'GET' && path === '/api/details') {
        const details = await jf.details(param('id'), user.id)
        return details ? sendJson(res, 200, details) : sendJson(res, 404, { error: 'Not found' })
    }
    if (method === 'GET' && path === '/api/discover') {
        return sendJson(res, 200, tmdb ? await discover(user.id) : { enabled: false, shelves: [] })
    }
    if (method === 'GET' && path === '/api/genres') {
        return sendJson(res, 200, await jf.genres(param('parent'), user.id))
    }
    if (method === 'GET' && path === '/api/image') {
        const id = url.searchParams.get('id') ?? ''
        if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
            return sendJson(res, 400, { error: 'Bad id' })
        }
        const image = await jf.image(id, param('kind') === 'backdrop')
        if (!image.ok || !image.body) {
            res.writeHead(404).end()
            return
        }
        res.writeHead(200, { 'content-type': image.headers.get('content-type') ?? 'image/jpeg', 'cache-control': 'private, max-age=86400' })
        res.end(Buffer.from(await image.arrayBuffer()))
        return
    }
    if (path === '/api/watchlist' || path.startsWith('/api/watchlist/')) {
        return watchlistApi(req, res, user, method, path)
    }
    if (method === 'GET' && path === '/api/nights') {
        return sendJson(res, 200, await upcomingNights(user))
    }
    const calendar = method === 'GET' ? /^\/api\/nights\/([\w-]+)\.ics$/.exec(path) : null
    if (calendar) {
        const night = (await upcomingNights(user)).find(n => n.id === calendar[1])
        if (!night) {
            return sendJson(res, 404, { error: 'No such movie night' })
        }
        res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="movie-night.ics"' })
        res.end(icsEvent({
            uid: night.id,
            start: night.startsAt,
            title: `Movie night: ${night.title}`,
            description: `Hosted by ${night.host} on Bloom. Ask them for the link and password.`,
        }))
        return
    }
    if (method === 'GET' && path === '/api/match') {
        // the library's item for a TMDB title, or null: for the host's view of guests' suggestions
        return sendJson(res, 200, (await jf.byTmdb(user.id)).get(`${url.searchParams.get('type') === 'Series' ? 'Series' : 'Movie'}:${url.searchParams.get('tmdb') ?? ''}`) ?? null)
    }
    if (method === 'GET' && path === '/api/resume') {
        return sendJson(res, 200, await jf.resume(user.id))
    }
    if (method === 'GET' && path === '/api/children') {
        return sendJson(res, 200, await jf.children(url.searchParams.get('id') ?? '', user.id))
    }

    return sendJson(res, 404, { error: 'Not found' })
}

async function subtitles(req: IncomingMessage, res: ServerResponse, room: Room, url: URL): Promise<void> {

    const item = room.queue[room.index]
    if (!item) {
        return sendJson(res, 404, { error: 'Nothing is playing' })
    }
    if (req.method === 'GET') {
        const lang = url.searchParams.get('lang') ?? ''
        if (!LANGUAGE.test(lang)) {
            return sendJson(res, 400, { error: 'Bad language' })
        }
        return sendJson(res, 200, await jf.remoteSubtitles(item.id, lang))
    }
    if (req.method !== 'POST') {
        return sendJson(res, 404, { error: 'Not found' })
    }

    const id = String((await readJson(req)).id ?? '')
    if (!id || id.length > 300) {
        return sendJson(res, 400, { error: 'Bad subtitle id' })
    }
    const before = new Set(await jf.subtitleIndexes(item.id))
    await jf.downloadSubtitle(item.id, id)
    // Jellyfin adds the file to the item in the background
    for (let i = 0; i < 15; i++) {
        const added = (await jf.subtitleIndexes(item.id)).find(index => !before.has(index))
        if (added !== undefined) {
            return sendJson(res, 200, { index: added })
        }
        await new Promise(resolve => setTimeout(resolve, 1000))
    }

    return sendJson(res, 504, { error: 'Downloaded, but Jellyfin hasn’t added it yet; try again in a minute' })
}

/** A night's public id: stable per room, but never its address. */
const nightId = (room: Room) => createHmac('sha256', SECRET).update(`night:${room.id}`).digest('hex').slice(0, 24)

type Night = { id: string; room: string; host: string; startsAt: number; title: string; itemId: string | null; viewers: number; mine: boolean; link: string | null }

/**
 * Scheduled rooms, soonest first, as one signed-in user may see them: what's on only when their own libraries have it,
 * and a link only to their own room (others need the host's invite and password, as always).
 */
async function upcomingNights(user: Account): Promise<Night[]> {

    const now = Date.now()
    const scheduled = [...rooms.values()].filter(r => r.startsAt !== null && r.startsAt > now - 3600_000).sort((a, b) => a.startsAt! - b.startsAt!)
    const visible = await jf.visible(scheduled.flatMap(r => r.queue[r.index] ? [r.queue[r.index].id] : []), user.id).catch(() => new Set<string>())

    return scheduled.map((r) => {
        const item = r.queue[r.index]
        const shown = item && visible.has(item.id) ? item : null
        return {
            id: nightId(r),
            room: r.name,
            host: accounts.find(a => a.id === r.owner)?.name ?? '',
            startsAt: r.startsAt!,
            title: shown?.name ?? (item ? 'Something from the host’s library' : 'To be decided'),
            itemId: shown?.id ?? null,
            viewers: viewersOf(r).length,
            mine: isOwner(user, r),
            link: isOwner(user, r) ? `/?room=${r.id}` : null,
        }
    })
}

/** TMDB's trending and popular lists, narrowed to what the user's libraries have, movies and shows interleaved. */
async function discover(userId: string): Promise<{ enabled: true; shelves: Array<{ title: string; items: Card[] }> }> {

    const library = await jf.byTmdb(userId)
    const matched = async (list: (type: TmdbType) => Promise<string[]>) => {
        const [movies, shows] = await Promise.all([list('movie').catch(() => []), list('tv').catch(() => [])])
        const items: Card[] = []
        for (let i = 0; i < Math.max(movies.length, shows.length); i++) {
            const movie = library.get(`Movie:${movies[i]}`)
            const show = library.get(`Series:${shows[i]}`)
            items.push(...(movie ? [movie] : []), ...(show ? [show] : []))
        }
        return items
    }
    const [trending, popular] = await Promise.all([matched(tmdb!.trending), matched(tmdb!.popular)])

    return { enabled: true, shelves: [{ title: 'Trending this week', items: trending }, { title: 'Popular right now', items: popular }] }
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

    saveProgress(room, true)
    rooms.delete(room.id)
    for (const client of clients.get(room.id) ?? []) {
        client.ws.close(4404, 'Room ended')
    }
    forgetRoom(room.id)
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
        wss.handleUpgrade(req, socket, head, ws => onJoin(ws, room, isOwner(users.fromRequest(req), room), locks.get(room.id)?.auth.tokenOf(req) ?? null))
    } catch (err) {
        console.error('Upgrade failed:', (err as Error).message)
        socket.destroy()
    }
})

function onJoin(ws: WebSocket, room: Room, isHost: boolean, token: string | null): void {

    const client: Client = { id: randomBytes(8).toString('base64url'), token, lastReaction: 0, lastChat: 0, ws, name: 'Guest', isHost, observer: false, windowStart: 0, count: 0, strikes: 0, bufferingSince: 0, lastBufferStart: 0, lastBufferEnd: 0, speed: 0 }
    const set = clients.get(room.id) ?? new Set<Client>()
    clients.set(room.id, set)
    set.add(client)
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
    // oversized or malformed frames emit 'error'; unhandled it would crash the process
    ws.on('error', () => ws.terminate())
    send(client, JSON.stringify({ type: 'welcome', isHost, id: client.id, link: isHost ? inviteLink(room) : null, gifs: GIPHY_API_KEY !== '', suggest: tmdb !== null, discord: DISCORD_WEBHOOK_URL !== '', chat: chats.get(room.id) ?? [] }))
    sendLog(room, client)
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
        updateWaiting(room)
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
            // the host page watches the room without being a viewer in it
            const observer = msg.observer === true && client.isHost
            if (observer !== client.observer) {
                client.observer = observer
                broadcast(room)
            }
            const name = String(msg.name ?? '').trim().slice(0, 32) || 'Guest'
            if (name === client.name) {
                return
            }
            client.name = name
            break
        }
        case 'buffering': {
            const buffering = msg.value === true
            if (buffering === client.bufferingSince > 0) {
                return
            }
            if (buffering) {
                // buffering again within moments continues the same wait, so toggling can't hold the room past MAX_WAIT_MS
                client.bufferingSince = now - client.lastBufferEnd < BUFFER_RESUME_MS ? client.lastBufferStart : now
                client.lastBufferStart = client.bufferingSince
            } else {
                client.bufferingSince = 0
                client.lastBufferEnd = now
            }
            updateWaiting(room, now)
            if (room.waiting) {
                broadcast(room) // waitingFor changed
            }
            return
        }
        case 'speed': {
            const mbps = Number(msg.value)
            client.speed = Number.isFinite(mbps) ? Math.min(Math.max(mbps, 0), 100_000) : 0
            return
        }
        case 'ping':
            send(client, JSON.stringify({ type: 'pong', t0: Number(msg.t0) || 0, server: now }))
            return
        case 'cmd': {
            const cmd = parseCommand(msg.cmd)
            const text = cmd && describe(room, cmd)
            if (!cmd || !apply(room, cmd, client.isHost, now)) {
                send(client, stateMessage(room)) // rejected: resync the sender
                return
            }
            logAction(room, client, text!)
            if (cmd.type === 'setAnnounce' && cmd.value) {
                announceRoom(room)
            } else if (cmd.type === 'schedule' && cmd.at !== null) {
                announce(room, `📅 **${room.name}** starts <t:${Math.floor(cmd.at / 1000)}:F> (<t:${Math.floor(cmd.at / 1000)}:R>)`)
            }
            updateWaiting(room, now)
            break
        }
        case 'addItem':
            if (!client.isHost) {
                return
            }
            {
                const items = await jf.queueItems(String(msg.itemId), room.owner) // only what the host may see
                if (gone(room)) {
                    return
                }
                const first = room.queue.length // after the await: something else may have been queued meanwhile
                if (items.length) {
                    logAction(room, client, msg.playNow === true ? `started ${items[0].name}` : describe(room, { type: 'queueAdd', items }))
                }
                if (apply(room, { type: 'queueAdd', items }, true, now) && msg.playNow === true) {
                    apply(room, { type: 'jump', index: first }, true, Date.now()) // "Watch now": start what was just added
                    // a movie or episode the host is partway through picks up where they left off
                    const resumeAt = items.length === 1 ? await jf.resumePosition(room.owner, items[0].id).catch(() => 0) : 0
                    if (resumeAt > 0 && !gone(room) && room.queue[room.index] === items[0]) {
                        apply(room, { type: 'seek', position: resumeAt }, true, Date.now())
                    }
                }
            }
            updateWaiting(room)
            break
        case 'react': {
            const emoji = String(msg.emoji)
            if (!REACTIONS.has(emoji) || client.observer || now - client.lastReaction < REACTION_GAP_MS) {
                return
            }
            client.lastReaction = now
            const reaction = JSON.stringify({ type: 'reaction', emoji, name: client.name })
            for (const other of clients.get(room.id) ?? []) {
                send(other, reaction)
            }
            return
        }
        case 'chat': {
            const message = chatMessage(client, room, msg, now)
            if (!message) {
                return
            }
            postChat(room, message)
            return
        }
        case 'suggest': {
            const tmdbId = String(msg.tmdbId ?? '')
            const type = msg.kind === 'Series' ? 'Series' : 'Movie'
            if (!tmdb || client.observer || !/^\d{1,10}$/.test(tmdbId) || now - client.lastChat < CHAT_GAP_MS || room.suggestions.some(s => s.tmdbId === tmdbId)) {
                return
            }
            client.lastChat = now
            const found = await tmdb.title(type === 'Series' ? 'tv' : 'movie', tmdbId)
            if (gone(room) || room.suggestions.some(s => s.tmdbId === tmdbId)) {
                return // ended, or someone suggested it during the lookup
            }
            room.suggestions.push({ tmdbId, type, name: found.name, by: client.name })
            room.suggestions.splice(0, room.suggestions.length - MAX_SUGGESTIONS)
            postChat(room, { at: now, name: client.name, text: `💡 suggested ${found.name}`, gif: null, itemId: null, position: null })
            break
        }
        case 'dismissSuggestion':
            if (!client.isHost) {
                return
            }
            room.suggestions = room.suggestions.filter(s => s.tmdbId !== msg.tmdbId)
            break
        case 'voteStart': {
            if (!client.isHost) {
                return
            }
            const ids = Array.isArray(msg.itemIds) ? [...new Set(msg.itemIds.map(String))].filter(id => ITEM_ID.test(id)).slice(0, 4) : []
            const found = await Promise.all(ids.map(id => jf.details(id, room.owner).catch(() => null)))
            const options = found.filter(d => d !== null).map(d => ({ id: d.id, name: d.name }))
            if (gone(room)) {
                return
            }
            if (options.length < 2) {
                throw new Error('A vote needs at least two titles')
            }
            room.vote = { options, ballots: {}, endsAt: now + VOTE_MS }
            logAction(room, client, `started a vote: ${options.map(o => o.name).join(' / ')}`)
            break
        }
        case 'vote': {
            const choice = Number(msg.option)
            if (!room.vote || client.observer || !Number.isInteger(choice) || choice < 0 || choice >= room.vote.options.length) {
                return
            }
            room.vote.ballots[client.id] = choice
            if (viewersOf(room).every(c => c.id in room.vote!.ballots)) {
                await finishVote(room) // everyone has voted
                return
            }
            break
        }
        case 'kick': {
            const target = client.isHost ? viewersOf(room).find(c => c.id === msg.id && !c.isHost) : undefined
            if (!target) {
                return
            }
            logAction(room, client, `removed ${target.name} from the room`)
            target.ws.close(4403, 'Removed by the host')
            return
        }
        case 'voteEnd':
        case 'voteCancel':
            if (!client.isHost || !room.vote) {
                return
            }
            if (msg.type === 'voteEnd') {
                await finishVote(room)
                return
            }
            room.vote = null
            break
        default:
            return
    }

    broadcast(room)
}

function postChat(room: Room, message: ChatMessage): void {
    const chat = chats.get(room.id) ?? []
    chats.set(room.id, chat)
    chat.push(message)
    chat.splice(0, chat.length - CHAT_HISTORY)
    const data = JSON.stringify({ type: 'chat', message })
    for (const client of clients.get(room.id) ?? []) {
        send(client, data)
    }
}

/** A validated chat message, or null for an empty, flooding or malformed one. */
function chatMessage(client: Client, room: Room, msg: Record<string, unknown>, now: number): ChatMessage | null {

    if (client.observer || now - client.lastChat < CHAT_GAP_MS) {
        return null
    }
    const text = String(msg.text ?? '').trim().slice(0, MAX_CHAT_LENGTH)
    const raw = msg.gif as { url?: unknown; width?: unknown; height?: unknown } | null | undefined
    const gif = raw && typeof raw.url === 'string' && GIPHY_MEDIA.test(raw.url)
        ? { url: raw.url, width: Math.min(Number(raw.width) || 200, 1000), height: Math.min(Number(raw.height) || 200, 1000) }
        : null
    if (!text && !gif) {
        return null
    }
    client.lastChat = now

    const item = room.queue[room.index]
    return { at: now, name: client.name, text, gif, itemId: item?.id ?? null, position: item ? Math.floor(currentPosition(room, now)) : null }
}

/** GIPHY search, or what's trending for an empty term; [] without a GIPHY_API_KEY. */
async function searchGifs(term: string): Promise<Array<{ url: string; preview: string; width: number; height: number; title: string }>> {

    if (!GIPHY_API_KEY) {
        return []
    }
    const query = new URLSearchParams({ api_key: GIPHY_API_KEY, limit: '24', rating: 'pg-13' })
    if (term.trim()) {
        query.set('q', term.trim().slice(0, 50))
    }
    const res = await fetch(`https://api.giphy.com/v1/gifs/${term.trim() ? 'search' : 'trending'}?${query}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
        throw new Error(`GIPHY ${res.status}`)
    }
    type Image = { url: string; width: string; height: string }
    const { data } = await res.json() as { data: Array<{ title: string; images: { fixed_height: Image; fixed_height_small: Image } }> }

    return data.map(g => ({ url: g.images.fixed_height.url, preview: g.images.fixed_height_small.url, width: Number(g.images.fixed_height.width), height: Number(g.images.fixed_height.height), title: g.title }))
}

// --- the shared watchlist: one "we should watch this" list for everyone with an account ---

type WatchlistEntry = Card & { addedBy: string; at: number }
const WATCHLIST_FILE = join(DATA_DIR, 'watchlist.json')
const watchlist = loadJson<WatchlistEntry[]>(WATCHLIST_FILE, [])
const MAX_WATCHLIST = 500

async function watchlistApi(req: IncomingMessage, res: ServerResponse, user: Account, method: string, path: string): Promise<void> {

    if (method === 'GET' && path === '/api/watchlist') {
        // shared, but each user only sees what their own libraries hold
        const visible = await jf.visible(watchlist.map(e => e.id), user.id)
        return sendJson(res, 200, watchlist.filter(e => visible.has(e.id)).toReversed())
    }
    if (method === 'POST' && path === '/api/watchlist') {
        const id = String((await readJson(req)).id ?? '')
        const details = ITEM_ID.test(id) && !watchlist.some(e => e.id === id) ? await jf.details(id, user.id) : null
        if (details) {
            const { id: itemId, name, type, title, subtitle, rating } = details
            watchlist.push({ id: itemId, name, type, title, subtitle, rating, addedBy: user.name, at: Date.now() })
            watchlist.splice(0, watchlist.length - MAX_WATCHLIST)
            saveJson(WATCHLIST_FILE, watchlist)
        }
        return sendJson(res, 200, { ok: true })
    }
    const entry = /^\/api\/watchlist\/([\w-]+)$/.exec(path)
    if (method === 'DELETE' && entry) {
        const index = watchlist.findIndex(e => e.id === entry[1])
        // only what this user can see, i.e. what their own watchlist shows
        if (index >= 0 && (await jf.visible([entry[1]], user.id)).has(entry[1])) {
            watchlist.splice(index, 1)
            saveJson(WATCHLIST_FILE, watchlist)
        }
        return sendJson(res, 200, { ok: true })
    }

    return sendJson(res, 404, { error: 'Not found' })
}

/** The room ended while a handler awaited Jellyfin or TMDB: nothing may be written for it any more. */
const gone = (room: Room) => rooms.get(room.id) !== room

/** Closes the room's vote: the winner plays next, or right away when nothing is on. */
async function finishVote(room: Room): Promise<void> {

    const vote = room.vote
    if (!vote) {
        return
    }
    room.vote = null // before the await: a second finish must not queue the winner twice
    const winner = vote.options[voteWinner(vote)]
    playNext(room, await jf.queueItems(winner.id, room.owner).catch(() => []), Date.now())
    updateWaiting(room)
    broadcast(room)
}

// --- background loops ---

/** Per room: the item being watched, seconds it actually played and everyone who saw it, until it's saved to history. */
const watching = new Map<string, { itemId: string; item: string; room: string; host: string; startedAt: number; seconds: number; viewers: Set<string> }>()

/** Called every second: counts played seconds and saves the previous item to history when the item changes. */
function trackWatching(room: Room): void {
    const item = room.queue[room.index]
    if (watching.get(room.id)?.itemId !== item?.id) {
        saveWatched(room.id)
    }
    if (!item) {
        return
    }
    const entry = watching.get(room.id) ?? { itemId: item.id, item: item.name, room: room.name, host: accounts.find(a => a.id === room.owner)?.name ?? '', startedAt: Date.now(), seconds: 0, viewers: new Set<string>() }
    watching.set(room.id, entry)
    const viewers = viewersOf(room)
    if (room.playing && !room.waiting && viewers.length > 0) {
        entry.seconds++
        viewers.forEach(c => entry.viewers.add(c.name))
    }
}

function saveWatched(roomId: string): void {
    const entry = watching.get(roomId)
    watching.delete(roomId)
    if (entry) {
        history.add({ at: entry.startedAt, itemId: entry.itemId, item: entry.item, room: entry.room, host: entry.host, viewers: [...entry.viewers], seconds: entry.seconds })
    }
}

/** Items whose next episode was already looked up, so it's queued once. */
const continued = new Set<string>()
const CONTINUE_BEFORE_END_S = 90

/** Near the end of the queue's last item, queues the show's next episode: the up-next countdown then shows it. */
function continueShow(room: Room): void {
    const item = room.queue[room.index]
    const key = `${room.id}:${room.index}:${item?.id}`
    if (!room.autoContinue || !item || !room.playing || room.index !== room.queue.length - 1 || continued.has(key)
        || item.runtime - currentPosition(room, Date.now()) > CONTINUE_BEFORE_END_S) {
        return
    }
    continued.add(key)
    jf.nextEpisode(item.id, room.owner).then((next) => {
        if (next && rooms.get(room.id) === room && room.queue.length - 1 === room.index && room.queue[room.index] === item) {
            room.queue.push(next)
            logAction(room, 'Bloom', `queued the next episode, ${next.name}`)
            broadcast(room)
        }
    }).catch(err => console.error('Next episode lookup failed:', err.message))
}

// --- Discord: a webhook post when a room with announcements on opens, is scheduled, or starts something ---

const announced = new Map<string, string>() // room id -> item last announced as playing

/** Posts to the server's Discord channel when the room has announcements on, with its current invite link. */
function announce(room: Room, text: string): void {
    if (DISCORD_WEBHOOK_URL && room.announce) {
        postToDiscord(DISCORD_WEBHOOK_URL, `${text}\nJoin: ${inviteLink(room)}`)
    }
}

function announceRoom(room: Room): void {
    const item = room.queue[room.index]
    const lines = [`🎬 **${room.name}** is open${item ? ` · ${room.playing ? 'playing' : 'up first'}: **${item.name}**` : ''}`]
    if (room.startsAt) {
        lines.push(`Starts <t:${Math.floor(room.startsAt / 1000)}:F> (<t:${Math.floor(room.startsAt / 1000)}:R>)`)
    }
    announced.set(room.id, item?.id ?? '')
    announce(room, lines.join('\n'))
}

/** Each new item that starts playing, once. */
function announceNowPlaying(room: Room): void {
    const item = room.queue[room.index]
    if (!room.announce || !item || !room.playing || announced.get(room.id) === item.id) {
        return
    }
    announced.set(room.id, item.id)
    announce(room, `▶️ Now playing in **${room.name}**: **${item.name}**`)
}

/** Per room: since when it has been playing with nobody watching. */
const unwatchedSince = new Map<string, number>()
const UNWATCHED_PAUSE_MS = 30_000

/**
 * A room nobody watches pauses after a grace period for reconnects, and its transcodes stop:
 * nothing plays on, queues the next episode, or holds Jellyfin until the show is done.
 */
function pauseIfUnwatched(room: Room): void {
    const now = Date.now()
    if (!room.playing || viewersOf(room).length > 0) {
        unwatchedSince.delete(room.id)
        return
    }
    const since = unwatchedSince.get(room.id) ?? now
    unwatchedSince.set(room.id, since)
    if (now - since < UNWATCHED_PAUSE_MS) {
        return
    }
    unwatchedSince.delete(room.id)
    apply(room, { type: 'pause' }, true, now)
    logAction(room, 'Bloom', 'paused: nobody was watching')
    stopRoomStreams(room, jf).catch(() => {})
    broadcast(room)
}

// --- rooms survive restarts: a snapshot in the data volume ---

const ROOMS_FILE = join(DATA_DIR, 'rooms.json')
let savedRooms = ''

/** Writes the rooms and their passwords when they changed (always on shutdown); called every few seconds. */
function saveRooms(force = false): void {
    const snapshot = JSON.stringify({ rooms: [...rooms.values()], passwords: Object.fromEntries([...locks].map(([id, lock]) => [id, lock.password])), invites: Object.fromEntries(invites) })
    if (force || snapshot !== savedRooms) {
        saveJson(ROOMS_FILE, { ...JSON.parse(snapshot), savedAt: Date.now() })
        savedRooms = snapshot
    }
}

function loadRooms(): void {
    const now = Date.now()
    const saved = loadJson<{ rooms: Room[]; passwords: Record<string, string>; invites?: Record<string, { key: string; at: number; previous: string | null }>; savedAt: number }>(ROOMS_FILE, { rooms: [], passwords: {}, savedAt: now })
    for (const stored of saved.rooms) {
        // defaults first: a room saved by an older version gets newer fields
        const room = { ...createRoom(stored.id, now, stored.owner, stored.name), ...stored, vote: null, waiting: false, suggestions: (stored.suggestions ?? []).filter(s => s.tmdbId) }
        // pick up where it was when saved, not where the clock ran on to while the server was down
        room.position = Math.min(currentPosition(stored, saved.savedAt), room.queue[room.index]?.runtime || Infinity) // stored: held rooms didn't move
        room.updatedAt = now
        rooms.set(room.id, room)
        emptySince.set(room.id, now) // the usual 5 minutes for its viewers to reconnect
        announced.set(room.id, room.queue[room.index]?.id ?? '') // already announced before the restart
        lock(room.id, saved.passwords[room.id] || hostPassword(room.owner)) // a room from before passwords were required gets one
        if (saved.invites?.[room.id]) {
            invites.set(room.id, saved.invites[room.id])
        }
    }
    if (saved.rooms.length) {
        console.log(`Restored ${saved.rooms.length} room(s)`)
    }
}

loadRooms()
setInterval(saveRooms, 5000)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        saveRooms(true)
        for (const id of rooms.keys()) {
            saveWatched(id) // what's been watched so far, not lost to a redeploy
        }
        process.exit(0)
    })
}

/** Drops everything kept about a room that ended or expired; its watch time is saved first. */
function forgetRoom(roomId: string): void {
    saveWatched(roomId)
    for (const map of [emptySince, locks, invites, logs, chats, progress, unwatchedSince, announced, clients] as Array<Map<string, unknown>>) {
        map.delete(roomId)
    }
    for (const set of [continued, skipped]) {
        for (const key of set) {
            if (key.startsWith(`${roomId}:`)) {
                set.delete(key)
            }
        }
    }
}

/** Intro segments per item; null while being fetched. */
const segmentCache = new Map<string, Segment[] | null>()
const skipped = new Set<string>()

/** With auto-skip on, jumps over an intro once per item; seeking back into it afterwards is left alone. */
function skipIntro(room: Room): void {
    const item = room.queue[room.index]
    if (!room.autoSkip || !item || !room.playing || room.waiting) {
        return
    }
    if (!segmentCache.has(item.id)) {
        if (segmentCache.size > 200) {
            segmentCache.clear() // ponytail: crude bound; also picks up intros Intro Skipper found since
        }
        segmentCache.set(item.id, null)
        jf.segments(item.id).then(s => segmentCache.set(item.id, s), () => segmentCache.set(item.id, []))
        return
    }
    const position = currentPosition(room, Date.now())
    const intro = segmentCache.get(item.id)?.find(s => s.type === 'Intro' && position >= s.start && position < s.end - 2)
    const key = `${room.id}:${room.index}:${item.id}`
    if (!intro || skipped.has(key)) {
        return
    }
    skipped.add(key)
    apply(room, { type: 'seek', position: intro.end }, true, Date.now())
    logAction(room, 'Bloom', 'skipped the intro')
    broadcast(room)
}

setInterval(() => {
    const { advanced, deleted } = sweepRooms(rooms, id => clients.get(id)?.size ?? 0, emptySince, Date.now())
    advanced.forEach(broadcast)
    for (const room of rooms.values()) {
        updateWaiting(room) // releases rooms whose blockers hit MAX_WAIT_MS
        if (room.vote && Date.now() >= room.vote.endsAt) {
            finishVote(room).catch(err => console.error('Vote failed:', err.message))
        }
        invite(room) // renews an expired link and tells the host
        trackWatching(room)
        continueShow(room)
        skipIntro(room)
        pauseIfUnwatched(room)
        announceNowPlaying(room)
    }
    for (const id of deleted) {
        forgetRoom(id) // empty for 5 minutes: the host's progress was saved while they were there
    }
}, 1000)

/**
 * Saves the host's watch progress to their Jellyfin account while they are in the room: their own item, not guests'.
 * final: the room is ending, save what's known now.
 */
function saveProgress(room: Room, final = false): void {
    const last = progress.get(room.id)
    const item = room.queue[room.index]
    if (last && (final || last.itemId !== item?.id)) {
        jf.saveProgress(room.owner, last.itemId, last.position, last.runtime).catch(() => {})
        progress.delete(room.id)
    }
    if (final || !item || !viewersOf(room).some(c => c.isHost)) {
        return
    }
    const position = currentPosition(room, Date.now())
    if (last?.itemId === item.id && Math.abs(last.position - position) < 1) {
        return // paused: nothing new to save
    }
    progress.set(room.id, { itemId: item.id, position, runtime: item.runtime })
    jf.saveProgress(room.owner, item.id, position, item.runtime).catch(() => {})
}

setInterval(() => {
    for (const room of rooms.values()) {
        saveProgress(room)
    }
}, 10_000)

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
        accounts = await jf.accounts()
        for (const id of users.refresh(accounts)) {
            await endRoomsOf(id) // disabled or deleted in Jellyfin
        }
        jellyfinInfo = info
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
server.listen(PORT, () => console.log(`Bloom listening on :${PORT} (${PUBLIC_URL})`))
