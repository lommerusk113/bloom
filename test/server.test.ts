import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { request, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import WebSocket from 'ws'

const PORT = 18_000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < 50; i++) {
        try {
            const value = await probe()
            if (value !== undefined) {
                return value
            }
        } catch {
            // not ready yet
        }
        await sleep(100)
    }
    throw new Error('timed out')
}

before(async () => {
    server = spawn(process.execPath, ['src/server.ts'], {
        env: { ...process.env, PORT: String(PORT), JELLYFIN_URL: 'http://127.0.0.1:9', JELLYFIN_API_KEY: 'x', HOST_PASSWORD: 'pw', PUBLIC_URL: BASE },
        stdio: 'ignore',
    })
    await waitFor(async () => ((await fetch(`${BASE}/api/health`)).ok ? true : undefined))
})

after(() => {
    server.kill()
})

async function login(): Promise<string> {
    const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })
    assert.equal(res.status, 200)
    return res.headers.get('set-cookie')!.split(';')[0]
}

function openSocket(roomId: string, cookie?: string, origin?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${roomId}`, { headers: cookie ? { cookie } : {}, origin })
    const messages: Array<Record<string, any>> = []
    ws.on('message', data => messages.push(JSON.parse(String(data))))
    return {
        ready: once(ws, 'open'),
        send: (msg: unknown) => ws.send(JSON.stringify(msg)),
        messages,
        close: () => ws.close(),
        next: (match: (m: Record<string, any>) => boolean) => waitFor(async () => messages.find(match)),
    }
}

test('reports Jellyfin problems without crashing', async () => {
    const me = await waitFor(async () => {
        const body = (await (await fetch(`${BASE}/api/me`)).json()) as { host: boolean; jellyfinError?: string }
        return /Cannot reach Jellyfin/.test(body.jellyfinError ?? '') ? body : undefined
    })
    assert.equal(me.host, false)
})

test('host-only endpoints require login', async () => {
    assert.equal((await fetch(`${BASE}/api/rooms`, { method: 'POST' })).status, 403)
    const wrong = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
    assert.equal(wrong.status, 401)
})

test('serves pages and static files, never source', async () => {
    assert.equal((await fetch(`${BASE}/web/style.css`)).status, 200)
    // fetch normalizes '..' away, so send the raw paths
    for (const path of ['/web/../src/server.ts', '/web/..%2fsrc%2fserver.ts', '/web/..%2Fsrc%2Fserver.ts']) {
        const req = request({ host: '127.0.0.1', port: PORT, path })
        req.end()
        const [res] = (await once(req, 'response')) as [IncomingMessage]
        let body = ''
        for await (const chunk of res) {
            body += chunk
        }
        assert.notEqual(res.statusCode, 200, path)
        assert.ok(!body.includes('createServer'), path)
    }
})

test('room sockets share state and know who is host', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    assert.equal((await fetch(`${BASE}/r/${id}/jf/Videos/${'a'.repeat(32)}/master.m3u8`)).status, 404)

    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { origin: 'https://evil.example' })
    await assert.rejects(once(evil, 'open'))

    const proxied = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { origin: BASE, headers: { host: 'internal:8080' } })
    await once(proxied, 'open')
    proxied.close()

    const host = openSocket(id, cookie, BASE)
    const guest = openSocket(id)
    await Promise.all([host.ready, guest.ready])
    host.send({ type: 'hello', name: 'Host' })
    guest.send({ type: 'hello', name: 'Alice' })
    assert.equal((await host.next(m => m.type === 'welcome')).isHost, true)
    assert.equal((await guest.next(m => m.type === 'welcome')).isHost, false)

    guest.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    host.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    const state = await guest.next(m => m.type === 'state' && m.room.guestControl === false && m.viewers.includes('Alice'))
    assert.deepEqual([...state.viewers].sort(), ['Alice', 'Host'])

    host.send({ type: 'nativeAdd', sessionId: 'secret-session', label: 'bob – TV (Android TV)', device: 'TV (Android TV)', trusted: true })
    const hostView = await host.next(m => m.type === 'state' && m.room.nativeSessions.length > 0)
    assert.equal(hostView.room.nativeSessions[0].sessionId, 'secret-session')
    const guestView = await guest.next(m => m.type === 'state' && m.room.nativeSessions.length > 0)
    assert.deepEqual(Object.keys(guestView.room.nativeSessions[0]).sort(), ['label', 'status'])
    assert.equal(guestView.room.nativeSessions[0].label, 'TV (Android TV)')
    host.close()
    guest.close()
})

test('an oversized websocket frame drops only that client', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`)
    await once(ws, 'open')
    ws.send('x'.repeat(70_000))
    await once(ws, 'close')
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200)
})

test('a socket to an unknown room is closed with 4404', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/no-such-room`)
    const [code] = await once(ws, 'close')
    assert.equal(code, 4404)
})

test('only the host can end a room, which disconnects everyone with 4404', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const guest = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`)
    await once(guest, 'open')
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE' })).status, 403)
    const closed = once(guest, 'close')
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie } })).status, 200)
    assert.equal((await closed)[0], 4404)
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie } })).status, 404)
})

test('a malformed upgrade target does not crash the server', async () => {
    const socket = connect(PORT, '127.0.0.1')
    await once(socket, 'connect')
    socket.end('GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    await once(socket, 'close')
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200)
})

test('websocket messages beyond the rate limit are dropped', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const guest = openSocket(id)
    await guest.ready
    for (let i = 0; i < 200; i++) {
        guest.send({ type: 'hello', name: `G${i}` })
    }
    await guest.next(m => m.type === 'state' && m.viewers.includes('G19'))
    await sleep(300)
    // only the first 20 hellos (G0..G19) fit the 1s window; later names must never be applied
    const last = guest.messages.filter(m => m.type === 'state').at(-1)
    assert.deepEqual(last?.viewers, ['G19'])
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200)
    guest.close()
})

test('a room accepts at most 50 sockets', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const sockets = Array.from({ length: 50 }, () => new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`))
    await Promise.all(sockets.map(ws => once(ws, 'open')))
    const extra = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`)
    await assert.rejects(once(extra, 'open'))
    sockets.forEach(ws => ws.terminate())
})
