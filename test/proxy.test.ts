import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Jellyfin } from '../src/jellyfin.ts'
import { allowedItemId, proxyRequest, stripApiKeys } from '../src/proxy.ts'
import { createRoom, type Room } from '../src/room.ts'

const ITEM = '0123456789abcdef0123456789abcdef'

test('allowedItemId accepts streaming paths and rejects the rest', () => {
    assert.equal(allowedItemId('GET', `/videos/${ITEM}/master.m3u8`), ITEM)
    assert.equal(allowedItemId('GET', `/Videos/${ITEM}/hls1/main/-1.mp4`), ITEM)
    assert.equal(allowedItemId('GET', `/Videos/${ITEM}/${ITEM}/Subtitles/3/0/Stream.vtt`), ITEM)
    assert.equal(allowedItemId('POST', `/Items/${ITEM}/PlaybackInfo`), ITEM)
    assert.equal(allowedItemId('GET', '/Videos/01234567-89ab-cdef-0123-456789abcdef/master.m3u8'), ITEM)
    assert.equal(allowedItemId('GET', `/Items/${ITEM}/PlaybackInfo`), null)
    assert.equal(allowedItemId('DELETE', `/Videos/${ITEM}/master.m3u8`), null)
    assert.equal(allowedItemId('GET', '/Users'), null)
    assert.equal(allowedItemId('GET', `/Items/${ITEM}/Images/Primary`), null)
})

test('stripApiKeys removes keys from playlist urls', () => {
    assert.equal(stripApiKeys('main.m3u8?api_key=SECRET&a=1'), 'main.m3u8?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&ApiKey=SECRET'), '0.mp4?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&api_key=S&b=2'), '0.mp4?a=1&b=2')
})

async function serve(room: Room, jf: Jellyfin, clock = () => Date.now()) {
    const server = createServer((req, res) => {
        proxyRequest(req, res, room, req.url ?? '/', jf, clock()).catch(() => res.destroy())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { base, close: () => { server.closeAllConnections(); server.close() } }
}

/** A Jellyfin that hands out PlaySessionId p<n> per PlaybackInfo and answers everything else with a playlist. */
function fakeJellyfin(calls: Array<[string, RequestInit]> = [], extra = {}) {
    let n = 0
    return {
        ...extra,
        raw: async (path: string, init: RequestInit) => {
            calls.push([path, init])
            if (path.includes('/PlaybackInfo')) {
                n++
                return Response.json({ MediaSources: [{ Id: 'm', TranscodingUrl: `/videos/x/master.m3u8?PlaySessionId=p${n}` }] })
            }
            if (init.method === 'DELETE') {
                return new Response(null, { status: 204 })
            }
            return new Response('#EXTM3U\nmain.m3u8?api_key=SECRET&x=1\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
        },
    } as unknown as Jellyfin
}

const playbackInfo = (base: string) => fetch(`${base}/Items/${ITEM}/PlaybackInfo`, { method: 'POST', body: '{}' })

test('proxy rejects items outside the queue', async () => {
    const jf = { raw: async () => { throw new Error('must not be called') } } as unknown as Jellyfin
    const { base, close } = await serve(createRoom('r', 0), jf)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8`)
    assert.equal(res.status, 404)
    close()
})

test('proxy forwards queued items, strips keys and adds CORS', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const { base, close } = await serve(room, fakeJellyfin(calls))
    await playbackInfo(base)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8?DeviceId=d1&PlaySessionId=p1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(await res.text(), '#EXTM3U\nmain.m3u8?x=1\n')
    assert.equal(calls[1][0], `/Videos/${ITEM}/master.m3u8?DeviceId=d1&PlaySessionId=p1`)
    assert.equal(new Headers(calls[1][1].headers).get('accept-encoding'), 'identity')
    close()
})

test('proxy strips api keys and paths from PlaybackInfo', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const jf = {
        raw: async () => new Response(JSON.stringify({
            MediaSources: [{ Id: 'm', Path: '/media/x.mkv', TranscodingUrl: '/videos/x/master.m3u8?DeviceId=d&ApiKey=SECRET&PlaySessionId=p' }],
        }), { headers: { 'content-type': 'application/json' } }),
    } as unknown as Jellyfin
    const { base, close } = await serve(room, jf)
    const res = await fetch(`${base}/Items/${ITEM}/PlaybackInfo`, { method: 'POST', body: '{}' })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(!text.includes('SECRET'))
    assert.ok(!text.includes('/media/x.mkv'))
    assert.equal(JSON.parse(text).MediaSources[0].TranscodingUrl, '/videos/x/master.m3u8?DeviceId=d&PlaySessionId=p')
    close()
})

test('proxy returns 502 for non-JSON PlaybackInfo on success', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const jf = { raw: async () => new Response('not json') } as unknown as Jellyfin
    const { base, close } = await serve(room, jf)
    const res = await fetch(`${base}/Items/${ITEM}/PlaybackInfo`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 502)
    close()
})

test('proxy overwrites UserId when the server runs as a user', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const { base, close } = await serve(room, fakeJellyfin(calls, { userId: 'me' }))
    await fetch(`${base}/Items/${ITEM}/PlaybackInfo?userid=evil&a=1`, { method: 'POST', body: '{}' })
    assert.equal(calls[0][0], `/Items/${ITEM}/PlaybackInfo?a=1&UserId=me`)
    close()
})

test('proxy only serves HLS for play sessions started in the room', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const { base, close } = await serve(room, fakeJellyfin(calls))
    assert.equal((await fetch(`${base}/Videos/${ITEM}/master.m3u8`)).status, 403)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 403)
    await playbackInfo(base)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?playsessionid=p1`)).status, 200)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/hls1/main/0.mp4?PlaySessionId=p1`)).status, 200)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/hls1/main/0.mp4?PlaySessionId=p2`)).status, 403)
    close()
})

test('proxy stops only the room\'s transcodes, once', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const { base, close } = await serve(room, fakeJellyfin(calls))
    const stop = () => fetch(`${base}/Videos/ActiveEncodings?DeviceId=d&PlaySessionId=p1`, { method: 'DELETE' })
    assert.equal((await stop()).status, 403)
    await playbackInfo(base)
    assert.equal((await stop()).status, 204)
    assert.equal(calls[1][0], '/Videos/ActiveEncodings?DeviceId=d&PlaySessionId=p1')
    assert.equal(calls[1][1].method, 'DELETE')
    assert.equal((await stop()).status, 403)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/master.m3u8?PlaySessionId=p1`)).status, 403)
    close()
})

test('proxy caps play sessions per room', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const { base, close } = await serve(room, fakeJellyfin(calls))
    for (let i = 0; i < 24; i++) {
        assert.equal((await playbackInfo(base)).status, 200)
    }
    const res = await playbackInfo(base)
    assert.equal(res.status, 429)
    assert.deepEqual(await res.json(), { error: 'Too many active streams in this room' })
    assert.equal(calls.length, 24)
    close()
})

test('proxy forgets play sessions unused for two minutes', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    let now = 0
    const { base, close } = await serve(room, fakeJellyfin(), () => now)
    for (let i = 0; i < 24; i++) {
        await playbackInfo(base)
    }
    now = 100_000
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 200)
    now = 200_000
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 200)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p2`)).status, 403)
    assert.equal((await playbackInfo(base)).status, 200)
    close()
})
