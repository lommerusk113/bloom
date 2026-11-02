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
})

test('stripApiKeys removes keys from playlist urls', () => {
    assert.equal(stripApiKeys('main.m3u8?api_key=SECRET&a=1'), 'main.m3u8?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&ApiKey=SECRET'), '0.mp4?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&api_key=S&b=2'), '0.mp4?a=1&b=2')
})

async function serve(room: Room, jf: Jellyfin) {
    const server = createServer((req, res) => {
        proxyRequest(req, res, room, req.url ?? '/', jf).catch(() => res.destroy())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { base, close: () => { server.closeAllConnections(); server.close() } }
}

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
    const calls: Array<[string, Headers]> = []
    const jf = {
        raw: async (path: string, init: RequestInit) => {
            calls.push([path, new Headers(init.headers)])
            return new Response('#EXTM3U\nmain.m3u8?api_key=SECRET&x=1\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
        },
    } as unknown as Jellyfin
    const { base, close } = await serve(room, jf)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8?DeviceId=d1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(await res.text(), '#EXTM3U\nmain.m3u8?x=1\n')
    assert.equal(calls[0][0], `/Videos/${ITEM}/master.m3u8?DeviceId=d1`)
    assert.equal(calls[0][1].get('accept-encoding'), 'identity')
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
    const paths: string[] = []
    const jf = {
        userId: 'me',
        raw: async (path: string) => {
            paths.push(path)
            return new Response('#EXTM3U\n')
        },
    } as unknown as Jellyfin
    const { base, close } = await serve(room, jf)
    await fetch(`${base}/Videos/${ITEM}/master.m3u8?userid=evil&a=1`)
    assert.equal(paths[0], `/Videos/${ITEM}/master.m3u8?a=1&UserId=me`)
    close()
})
