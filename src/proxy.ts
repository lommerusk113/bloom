import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { normalizeId, type Jellyfin } from './jellyfin.ts'
import type { Room } from './room.ts'

const ID = '([0-9a-f]{32}|[0-9a-f-]{36})'
const ALLOWED: ReadonlyArray<[string, RegExp]> = [
    ['POST', new RegExp(`^/Items/${ID}/PlaybackInfo$`, 'i')],
    ['GET', new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`, 'i')],
    ['GET', new RegExp(`^/Videos/${ID}/hls1/[\\w-]+/-?\\d+\\.(ts|mp4|m4s)$`, 'i')],
    ['GET', new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d+/(\\d+/)?Stream\\.vtt$`, 'i')],
]
const PASSED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']
const MAX_BODY = 1_000_000
const MAX_SESSIONS = 24
/** Play sessions without HLS requests this long stop counting toward MAX_SESSIONS (paused players, crashed tabs); Jellyfin kills such idle transcodes too. */
const SESSION_IDLE_MS = 120_000
const MAX_ISSUED = 500
const HLS = /\.m3u8$|\/hls1\//i
const STOP = /^\/Videos\/ActiveEncodings$/i

/**
 * PlaySessionIds issued by each room's PlaybackInfo (HLS and stop requests must name one), with when each was last used.
 * An id stays usable until stopped, so a long pause can resume; only recently used ids count toward MAX_SESSIONS.
 */
const sessions = new WeakMap<Room, Map<string, number>>()

function playSessionId(params: URLSearchParams): string | undefined {
    for (const [name, value] of params) {
        if (name.toLowerCase() === 'playsessionid') {
            return value
        }
    }
    return undefined
}

/** The normalized item id an allowed path refers to, or null when the path is not allowed. */
export function allowedItemId(method: string, path: string): string | null {
    for (const [allowedMethod, pattern] of ALLOWED) {
        const match = method === allowedMethod ? pattern.exec(path) : null
        if (match) {
            return normalizeId(match[1])
        }
    }
    return null
}

export function stripApiKeys(playlist: string): string {
    return playlist.replace(/([?&])(?:api_key|apikey)=[^&\s"]*(&?)/gi, (_, sep: string, amp: string) => (amp ? sep : ''))
}

/**
 * Removes the api key query params from each MediaSource.TranscodingUrl and MediaStream.DeliveryUrl
 * and drops the filesystem Paths.
 * Records the PlaySessionIds it finds in playSessions as seen at now.
 */
function sanitizePlaybackInfo(body: string, playSessions: Map<string, number>, now: number): string {
    const info = JSON.parse(body)
    if (typeof info?.PlaySessionId === 'string') {
        playSessions.set(info.PlaySessionId, now)
    }
    for (const source of info?.MediaSources ?? []) {
        delete source.Path
        for (const stream of source.MediaStreams ?? []) {
            delete stream.Path
            if (typeof stream.DeliveryUrl === 'string') {
                stream.DeliveryUrl = stripApiKeys(stream.DeliveryUrl)
            }
        }
        if (typeof source.TranscodingUrl === 'string') {
            const url = new URL(source.TranscodingUrl, 'http://proxy')
            for (const name of [...url.searchParams.keys()]) {
                if (/^(api_key|apikey)$/i.test(name)) {
                    url.searchParams.delete(name)
                }
            }
            source.TranscodingUrl = url.pathname + url.search
            const id = playSessionId(url.searchParams)
            if (id) {
                playSessions.set(id, now)
            }
        }
    }
    return JSON.stringify(info)
}

export async function readBody(req: IncomingMessage): Promise<string> {
    let body = ''
    for await (const chunk of req) {
        body += chunk
        if (body.length > MAX_BODY) {
            throw new Error('Request body too large')
        }
    }
    return body
}

/**
 * Forwards a guest request to Jellyfin with the server's API key.
 * Only streaming paths for items in the room's queue are allowed, HLS only for transcodes started in this room.
 */
// ponytail: query strings pass through untouched, so a guest who already knows another item's
// MediaSourceId could request it. Ids are unguessable GUIDs and are never listed to guests.
export async function proxyRequest(req: IncomingMessage, res: ServerResponse, room: Room, target: string, jf: Jellyfin, now = Date.now()): Promise<void> {

    const url = new URL(target, 'http://proxy')
    const method = req.method ?? 'GET'
    const playSessions = sessions.get(room) ?? new Map<string, number>()
    sessions.set(room, playSessions)
    const id = playSessionId(url.searchParams)
    const stop = method === 'DELETE' && STOP.test(url.pathname)
    if (!stop) {
        const itemId = allowedItemId(method, url.pathname)
        if (!itemId || !room.queue.some(item => normalizeId(item.id) === itemId)) {
            res.writeHead(404).end()
            return
        }
    }
    if ((stop || HLS.test(url.pathname)) && !(id && playSessions.has(id))) {
        res.writeHead(403).end()
        return
    }
    if (HLS.test(url.pathname)) {
        playSessions.set(id!, now)
    }
    if (stop || HLS.test(url.pathname)) {
        // Jellyfin keys transcode jobs on DeviceId+PlaySessionId: a guest-chosen DeviceId would start a new job per value
        for (const name of [...url.searchParams.keys()]) {
            if (name.toLowerCase() === 'deviceid') {
                url.searchParams.delete(name)
            }
        }
        url.searchParams.set('DeviceId', id!)
    }
    if (/\/PlaybackInfo$/i.test(url.pathname) && [...playSessions.values()].filter(seen => now - seen <= SESSION_IDLE_MS).length >= MAX_SESSIONS) {
        res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Too many active streams in this room' }))
        return
    }

    if (jf.userId) {
        for (const name of [...url.searchParams.keys()]) {
            if (name.toLowerCase() === 'userid') {
                url.searchParams.delete(name)
            }
        }
        url.searchParams.set('UserId', jf.userId)
    }

    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    if (req.headers.range) {
        headers.range = req.headers.range
    }
    if (method === 'POST') {
        headers['content-type'] = 'application/json'
    }
    const upstream = await jf.raw(url.pathname + url.search, {
        method,
        headers,
        body: method === 'POST' ? await readBody(req) : undefined,
        signal: abort.signal,
    })
    if (stop) {
        playSessions.delete(id!)
    }

    const out: Record<string, string> = { 'access-control-allow-origin': '*' }
    for (const name of PASSED_HEADERS) {
        const value = upstream.headers.get(name)
        if (value) {
            out[name] = value
        }
    }

    if (url.pathname.toLowerCase().endsWith('.m3u8')) {
        delete out['content-length']
        res.writeHead(upstream.status, out).end(jf.redact(stripApiKeys(await upstream.text())))
        return
    }

    if (/\/PlaybackInfo$/i.test(url.pathname)) {
        const text = await upstream.text()
        delete out['content-length']
        try {
            const clean = sanitizePlaybackInfo(text, playSessions, now)
            // ponytail: O(n) scan per eviction, fine at MAX_ISSUED
            while (playSessions.size > MAX_ISSUED) {
                const [oldest] = [...playSessions].reduce((a, b) => (b[1] < a[1] ? b : a))
                playSessions.delete(oldest)
            }
            res.writeHead(upstream.status, out).end(jf.redact(clean))
        } catch {
            const ok = upstream.status >= 200 && upstream.status < 300
            res.writeHead(ok ? 502 : upstream.status, out).end(ok ? undefined : jf.redact(text))
        }
        return
    }

    res.writeHead(upstream.status, out)
    if (!upstream.body) {
        res.end()
        return
    }
    Readable.fromWeb(upstream.body as ReadableStream).on('error', () => res.destroy()).pipe(res)
}
