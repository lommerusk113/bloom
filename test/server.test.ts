import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, request, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const PORT = 18_000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess
const MOVIE = 'a'.repeat(32)
/** Jellyfin accounts the fake accepts: name -> password. */
const ACCOUNTS: Record<string, string> = { admin: 'admin-pw', alice: 'secret1', bob: 'secret1' }
/** Fails /System/Info (so the startup check reports an error) but lists one movie, enough to queue it, and checks logins. */
const fakeJellyfin = createServer(async (req, res) => {
    if (req.url === '/Users/AuthenticateByName') {
        let raw = ''
        for await (const chunk of req) {
            raw += chunk
        }
        const { Username, Pw } = JSON.parse(raw)
        if (ACCOUNTS[Username] === undefined || ACCOUNTS[Username] !== Pw) {
            res.writeHead(401).end()
            return
        }
        const User = { Id: `id-${Username}`, Name: Username, Policy: { IsAdministrator: Username === 'admin', IsDisabled: false } }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ User, AccessToken: 'token' }))
        return
    }
    if (req.url?.startsWith('/Items?')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Items: [{ Id: MOVIE, Name: 'Movie', Type: 'Movie', RunTimeTicks: 36_000_000_000 }] }))
        return
    }
    res.writeHead(503).end()
})

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
    await new Promise<void>(resolve => fakeJellyfin.listen(0, '127.0.0.1', resolve))
    const jellyfinUrl = `http://127.0.0.1:${(fakeJellyfin.address() as AddressInfo).port}`
    server = spawn(process.execPath, ['src/server.ts'], {
        env: { ...process.env, PORT: String(PORT), JELLYFIN_URL: jellyfinUrl, JELLYFIN_API_KEY: 'x', PUBLIC_URL: BASE, DATA_DIR: mkdtempSync(join(tmpdir(), 'bloom-')) },
        stdio: 'ignore',
    })
    await waitFor(async () => ((await fetch(`${BASE}/api/health`)).ok ? true : undefined))
})

after(() => {
    server.kill()
    fakeJellyfin.close()
})

async function login(username = 'admin', password = 'admin-pw'): Promise<string> {
    const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) })
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
        const body = (await (await fetch(`${BASE}/api/me`)).json()) as { user: unknown; jellyfinError?: string }
        return /Cannot reach Jellyfin/.test(body.jellyfinError ?? '') ? body : undefined
    })
    assert.equal(me.user, null)
})

test('host-only endpoints require login', async () => {
    assert.equal((await fetch(`${BASE}/api/rooms`, { method: 'POST' })).status, 403)
    const wrong = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'nope' }) })
    assert.equal(wrong.status, 401)
})

test('users only see, host and end their own rooms', async () => {
    const alice = await login('alice', 'secret1')
    const bob = await login('bob', 'secret1')
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie: alice } })).json()) as { id: string }
    const list = async (cookie: string) => ((await (await fetch(`${BASE}/api/rooms`, { headers: { cookie } })).json()) as Array<{ id: string; name: string }>)
    assert.deepEqual((await list(alice)).map(r => r.name), ["alice's room"])
    assert.deepEqual(await list(bob), [])
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie: bob } })).status, 404)
    assert.equal((await fetch(`${BASE}/api/admin/overview`, { headers: { cookie: bob } })).status, 403)

    const asBob = openSocket(id, bob)
    const asAlice = openSocket(id, alice)
    assert.equal((await asBob.next(m => m.type === 'welcome')).isHost, false)
    assert.equal((await asAlice.next(m => m.type === 'welcome')).isHost, true)
    asBob.close()
    asAlice.close()

    const overview = (await (await fetch(`${BASE}/api/admin/overview`, { headers: { cookie: await login() } })).json()) as { rooms: Array<{ id: string; name: string }> }
    assert.equal(overview.rooms.find(r => r.id === id)?.name, "alice's room")
})

test('serves pages and static files, never source', async () => {
    assert.equal((await fetch(`${BASE}/web/style.css`)).status, 200)
    assert.equal((await fetch(`${BASE}/web/logo.svg`)).headers.get('content-type'), 'image/svg+xml')
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

test('a room password keeps out guests until they enter it', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const setPassword = (password: string, headers: Record<string, string> = { cookie }) =>
        fetch(`${BASE}/api/rooms/${id}/password`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    assert.equal((await setPassword('open sesame', {})).status, 403)
    assert.equal((await setPassword('open sesame')).status, 200)

    const access = async (headers = {}) => (await (await fetch(`${BASE}/api/rooms/${id}/access`, { headers })).json()) as { locked: boolean; allowed: boolean }
    assert.deepEqual(await access(), { locked: true, allowed: false })
    assert.deepEqual(await access({ cookie }), { locked: true, allowed: true })
    const locked = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`)
    assert.equal((await once(locked, 'close'))[0], 4401)
    const playbackInfo = (headers = {}) => fetch(`${BASE}/r/${id}/jf/Items/${'a'.repeat(32)}/PlaybackInfo`, { method: 'POST', headers })
    assert.equal((await playbackInfo()).status, 401)

    const join = (password: string) => fetch(`${BASE}/api/rooms/${id}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    assert.equal((await join('wrong')).status, 401)
    const ok = await join('open sesame')
    assert.equal(ok.status, 200)
    const guestCookie = ok.headers.get('set-cookie')!.split(';')[0]
    assert.deepEqual(await access({ cookie: guestCookie }), { locked: true, allowed: true })
    assert.equal((await playbackInfo({ cookie: guestCookie })).status, 404) // past the lock: item not in queue
    const guest = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: { cookie: guestCookie } })
    await once(guest, 'open')
    guest.close()

    const rooms = (await (await fetch(`${BASE}/api/rooms`, { headers: { cookie } })).json()) as Array<{ id: string; password: string }>
    assert.equal(rooms.find(r => r.id === id)?.password, 'open sesame')
    assert.equal((await setPassword('')).status, 200)
    assert.deepEqual(await access(), { locked: false, allowed: true })
})

test('a buffering viewer holds a playing room until it has loaded', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const host = openSocket(id, cookie)
    const guest = openSocket(id)
    await Promise.all([host.ready, guest.ready])
    guest.send({ type: 'hello', name: 'Slow' })
    host.send({ type: 'addItem', itemId: MOVIE })
    await host.next(m => m.type === 'state' && m.room.queue.length === 1)
    host.send({ type: 'cmd', cmd: { type: 'play' } })
    await host.next(m => m.type === 'state' && m.room.playing)
    guest.send({ type: 'buffering', value: true })
    const held = await host.next(m => m.type === 'state' && m.room.waiting)
    assert.deepEqual(held.waitingFor, ['Slow'])
    guest.send({ type: 'buffering', value: false })
    await host.next(m => m.type === 'state' && m.room.playing && !m.room.waiting && m.serverNow > held.serverNow)
    host.close()
    guest.close()
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
