import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Jellyfin } from '../src/jellyfin.ts'
import { allowedItemId, cleanVtt, proxyRequest, stopRoomStreams, stripApiKeys } from '../src/proxy.ts'
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

test('cleanVtt turns ASS codes into VTT tags and drops the rest', () => {
    assert.equal(cleanVtt('{\\i1}Sasuke !{\\i0}'), '<i>Sasuke !</i>')
    assert.equal(cleanVtt('{\\an8}{\\b1}Top{\\b0}\\Nline'), '<b>Top</b>\nline')
    assert.equal(cleanVtt('{\\pos(10,20)\\c&H00FF00&}plain'), 'plain')
})

test('stripApiKeys removes keys from playlist urls', () => {
    assert.equal(stripApiKeys('main.m3u8?api_key=SECRET&a=1'), 'main.m3u8?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&ApiKey=SECRET'), '0.mp4?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&api_key=S&b=2'), '0.mp4?a=1&b=2')
})

async function serve(t: TestContext, room: Room, jf: Jellyfin, clock = () => Date.now()) {
    const server = createServer((req, res) => {
        proxyRequest(req, res, room, req.url ?? '/', jf, clock()).catch(() => res.destroy())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
        server.closeAllConnections()
        server.close()
    })
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

/** A Jellyfin that hands out PlaySessionId p<n> per PlaybackInfo and answers everything else with a playlist. */
function fakeJellyfin(calls: Array<[string, RequestInit]> = [], extra = {}) {
    let n = 0
    return {
        redact: (text: string) => text,
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

test('proxy rejects items outside the queue', async (t) => {
    const jf = { raw: async () => { throw new Error('must not be called') } } as unknown as Jellyfin
    const base = await serve(t, createRoom('r', 0), jf)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8`)
    assert.equal(res.status, 404)
})

test('proxy forwards queued items, strips keys and adds CORS', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const base = await serve(t, room, fakeJellyfin(calls))
    await playbackInfo(base)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8?DeviceId=d1&PlaySessionId=p1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(await res.text(), '#EXTM3U\nmain.m3u8?x=1\n')
    assert.equal(calls[1][0], `/Videos/${ITEM}/master.m3u8?PlaySessionId=p1&DeviceId=p1`)
    assert.equal(new Headers(calls[1][1].headers).get('accept-encoding'), 'identity')
})

test('proxy strips api keys and paths from PlaybackInfo', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const jf = {
        redact: (text: string) => text,
        raw: async () => new Response(JSON.stringify({
            MediaSources: [{
                Id: 'm',
                Path: '/media/x.mkv',
                TranscodingUrl: '/videos/x/master.m3u8?DeviceId=d&ApiKey=SECRET&PlaySessionId=p',
                MediaStreams: [{ Type: 'Subtitle', Path: '/media/x.en.srt', DeliveryUrl: '/Videos/x/m/Subtitles/2/0/Stream.vtt?ApiKey=SECRET' }],
            }],
        }), { headers: { 'content-type': 'application/json' } }),
    } as unknown as Jellyfin
    const base = await serve(t, room, jf)
    const res = await fetch(`${base}/Items/${ITEM}/PlaybackInfo`, { method: 'POST', body: '{}' })
    const text = await res.text()
    assert.equal(res.status, 200)
    assert.ok(!text.includes('SECRET'))
    assert.ok(!text.includes('/media/x'))
    const source = JSON.parse(text).MediaSources[0]
    assert.equal(source.TranscodingUrl, '/videos/x/master.m3u8?DeviceId=d&PlaySessionId=p')
    assert.equal(source.MediaStreams[0].DeliveryUrl, '/Videos/x/m/Subtitles/2/0/Stream.vtt')
})

test('proxy redacts the literal api key from playlists and PlaybackInfo', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const jf = {
        redact: (text: string) => text.replaceAll('KEY123', ''),
        raw: async (path: string) => path.includes('/PlaybackInfo')
            ? Response.json({ PlaySessionId: 'p', ErrorCode: 'token KEY123', MediaSources: [] })
            : new Response('#EXTM3U\n#EXT-X-KEY:URI="k?token=KEY123"\n'),
    } as unknown as Jellyfin
    const base = await serve(t, room, jf)
    const info = await (await playbackInfo(base)).text()
    const playlist = await (await fetch(`${base}/Videos/${ITEM}/master.m3u8?PlaySessionId=p`)).text()
    for (const text of [info, playlist]) {
        assert.ok(text.length > 0)
        assert.ok(!text.includes('KEY123'), text)
    }
})

test('proxy returns 502 for non-JSON PlaybackInfo on success', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const jf = { redact: (text: string) => text, raw: async () => new Response('not json') } as unknown as Jellyfin
    const base = await serve(t, room, jf)
    const res = await fetch(`${base}/Items/${ITEM}/PlaybackInfo`, { method: 'POST', body: '{}' })
    assert.equal(res.status, 502)
})

test('proxy overwrites UserId when the server runs as a user', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const base = await serve(t, room, fakeJellyfin(calls, { userId: 'me' }))
    await fetch(`${base}/Items/${ITEM}/PlaybackInfo?userid=evil&a=1`, { method: 'POST', body: '{}' })
    assert.equal(calls[0][0], `/Items/${ITEM}/PlaybackInfo?a=1&UserId=me`)
})

test('proxy only serves HLS for play sessions started in the room', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const base = await serve(t, room, fakeJellyfin(calls))
    assert.equal((await fetch(`${base}/Videos/${ITEM}/master.m3u8`)).status, 403)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 403)
    await playbackInfo(base)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?playsessionid=p1`)).status, 200)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/hls1/main/0.mp4?PlaySessionId=p1`)).status, 200)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/hls1/main/0.mp4?PlaySessionId=p2`)).status, 403)
})

test('proxy stops only the room\'s transcodes, once', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const base = await serve(t, room, fakeJellyfin(calls))
    const stop = () => fetch(`${base}/Videos/ActiveEncodings?DeviceId=d&PlaySessionId=p1`, { method: 'DELETE' })
    assert.equal((await stop()).status, 403)
    await playbackInfo(base)
    assert.equal((await stop()).status, 204)
    assert.equal(calls[1][0], '/Videos/ActiveEncodings?PlaySessionId=p1&DeviceId=p1')
    assert.equal(calls[1][1].method, 'DELETE')
    assert.equal((await stop()).status, 403)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/master.m3u8?PlaySessionId=p1`)).status, 403)
})

test('stopRoomStreams stops the room\'s recent transcodes and revokes its play sessions', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const jf = fakeJellyfin(calls)
    const base = await serve(t, room, jf)
    await playbackInfo(base)
    await stopRoomStreams(room, jf)
    assert.deepEqual(calls.slice(1).map(([path, init]) => [path, init.method]), [['/Videos/ActiveEncodings?DeviceId=p1&PlaySessionId=p1', 'DELETE']])
    assert.equal((await fetch(`${base}/Videos/${ITEM}/master.m3u8?PlaySessionId=p1`)).status, 403)
})

test('proxy pins DeviceId to the PlaySessionId whatever the guest sends', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const base = await serve(t, room, fakeJellyfin(calls))
    await playbackInfo(base)
    await fetch(`${base}/Videos/${ITEM}/main.m3u8?deviceid=a&DEVICEID=b&PlaySessionId=p1`)
    await fetch(`${base}/Videos/${ITEM}/hls1/main/3.mp4?PlaySessionId=p1&DeviceId=c`)
    await fetch(`${base}/Videos/ActiveEncodings?PlaySessionId=p1&deviceId=d`, { method: 'DELETE' })
    for (const [path] of calls.slice(1)) {
        const params = new URL(path, 'http://x').searchParams
        assert.deepEqual([...params].filter(([name]) => name.toLowerCase() === 'deviceid'), [['DeviceId', 'p1']], path)
    }
    assert.equal(calls.length, 4)
})

test('proxy caps play sessions per room', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, RequestInit]> = []
    const base = await serve(t, room, fakeJellyfin(calls))
    for (let i = 0; i < 24; i++) {
        assert.equal((await playbackInfo(base)).status, 200)
    }
    const res = await playbackInfo(base)
    assert.equal(res.status, 429)
    assert.deepEqual(await res.json(), { error: 'Too many active streams in this room' })
    assert.equal(calls.length, 24)
})

test('idle play sessions keep access but stop counting toward the cap', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    let now = 0
    const base = await serve(t, room, fakeJellyfin(), () => now)
    for (let i = 0; i < 24; i++) {
        await playbackInfo(base)
    }
    assert.equal((await playbackInfo(base)).status, 429)
    now = 100_000
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 200)
    assert.equal((await playbackInfo(base)).status, 429)
    now = 200_000
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p2`)).status, 200)
    assert.equal((await playbackInfo(base)).status, 200)
})

test('proxy keeps at most 500 issued play sessions, dropping the least recently used', async (t) => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    let now = 0
    const base = await serve(t, room, fakeJellyfin(), () => now)
    await playbackInfo(base)
    await playbackInfo(base)
    now = 1
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 200)
    for (let i = 0; i < 499; i++) {
        now += 10_000
        assert.equal((await playbackInfo(base)).status, 200)
    }
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p2`)).status, 403)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p1`)).status, 200)
    assert.equal((await fetch(`${base}/Videos/${ITEM}/main.m3u8?PlaySessionId=p3`)).status, 200)
})
