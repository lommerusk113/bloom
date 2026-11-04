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
const ACCOUNTS: Record<string, string> = { admin: 'admin-pw', alice: 'secret1', bob: 'secret1', carol: 'secret1' }
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


/** The cookies a guest gets by opening the room's current invite link and typing its password; only its host sees both. */
async function invited(roomId: string, hostCookie: string, withPassword = true): Promise<string> {
    const rooms = (await (await fetch(`${BASE}/api/rooms`, { headers: { cookie: hostCookie } })).json()) as Array<{ id: string; link: string; password: string }>
    const room = rooms.find(r => r.id === roomId)!
    const post = (path: string, body: unknown, cookie = '') => fetch(`${BASE}/api/rooms/${roomId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })
    const res = await post('invite', { key: new URL(room.link, BASE).searchParams.get('i') })
    assert.equal(res.status, 200)
    const admission = res.headers.get('set-cookie')!.split(';')[0]
    if (!withPassword) {
        return admission
    }
    const joined = await post('join', { password: room.password }, admission)
    assert.equal(joined.status, 200)
    return `${admission}; ${joined.headers.get('set-cookie')!.split(';')[0]}`
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
        onClose: (fn: (code: number) => void) => ws.on('close', fn),
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

test('a room is started on request, optionally scheduled, and its link works behind any address', async () => {
    const carol = await login('carol', 'secret1')
    const start = (body: unknown) => fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie: carol, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await start({ startsAt: Date.now() - 1000 })).status, 400)
    assert.equal((await start({ startsAt: 'soon' })).status, 400)
    const at = Date.now() + 3600_000
    const { id } = (await (await start({ startsAt: at })).json()) as { id: string }
    const [room] = (await (await fetch(`${BASE}/api/rooms`, { headers: { cookie: carol } })).json()) as Array<{ link: string }>
    assert.match(room.link, /^\/r\/[\w-]+\?i=/) // the page puts its own origin in front
    const nights = (await (await fetch(`${BASE}/api/nights`, { headers: { cookie: carol } })).json()) as Array<{ startsAt: number }>
    assert.ok(nights.some(n => n.startsAt === at))
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie: carol } })).status, 200)
    assert.deepEqual(await (await fetch(`${BASE}/api/rooms`, { headers: { cookie: carol } })).json(), []) // ended stays ended
})

test('users only see, host and end their own rooms', async () => {
    const alice = await login('alice', 'secret1')
    const bob = await login('bob', 'secret1')
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie: alice } })).json()) as { id: string }
    const list = async (cookie: string) => ((await (await fetch(`${BASE}/api/rooms`, { headers: { cookie } })).json()) as Array<{ id: string; name: string }>)
    assert.deepEqual((await list(alice)).map(r => r.name), ["alice's room"])
    const again = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie: alice } })).json()) as { id: string }
    assert.equal(again.id, id) // one room per host
    assert.deepEqual(await list(bob), [])
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie: bob } })).status, 404)
    assert.equal((await fetch(`${BASE}/api/admin/overview`, { headers: { cookie: bob } })).status, 403)

    assert.equal((await once(new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: { cookie: bob } }), 'close'))[0], 4401) // an account alone is no invite
    const asBob = openSocket(id, `${bob}; ${await invited(id, alice)}`)
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
    assert.equal((await fetch(`${BASE}/`)).headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
    assert.match(await (await fetch(`${BASE}/robots.txt`)).text(), /Disallow: \//)
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
    const guest = openSocket(id, await invited(id, cookie))
    await Promise.all([host.ready, guest.ready])
    host.send({ type: 'hello', name: 'Host' })
    guest.send({ type: 'hello', name: 'Alice' })
    assert.equal((await host.next(m => m.type === 'welcome')).isHost, true)
    assert.equal((await guest.next(m => m.type === 'welcome')).isHost, false)

    guest.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    host.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    const state = await guest.next(m => m.type === 'state' && m.room.guestControl === false && m.viewers.some((v: { name: string }) => v.name === 'Alice'))
    assert.deepEqual(state.viewers.map((v: { name: string }) => v.name).sort(), ['Alice', 'Host'])
    host.close()
    guest.close()
})

test('the host sees who did what, everyone sees reactions, and the host can remove a guest', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const host = openSocket(id, cookie, BASE)
    const guest = openSocket(id, await invited(id, cookie))
    await Promise.all([host.ready, guest.ready])
    host.send({ type: 'hello', name: 'Host' })
    guest.send({ type: 'hello', name: 'Alice' })
    await guest.next(m => m.type === 'state' && m.viewers.length === 2)

    guest.send({ type: 'cmd', cmd: { type: 'pause' } }) // nothing queued: rejected, so not logged
    guest.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: true } }) // host only: rejected
    host.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    const log = await host.next(m => m.type === 'log' && m.entries.length > 0)
    assert.deepEqual(log.entries.map((e: { name: string; text: string }) => `${e.name} ${e.text}`), ['Host (host) took back control of playback'])
    assert.equal(guest.messages.some(m => m.type === 'log'), false)

    guest.send({ type: 'react', emoji: '🔥' })
    guest.send({ type: 'react', emoji: '<script>' })
    assert.deepEqual(await host.next(m => m.type === 'reaction'), { type: 'reaction', emoji: '🔥', name: 'Alice' })

    guest.send({ type: 'chat', text: '  hi all  ', gif: { url: 'https://evil.example/track.gif' } })
    const chat = await host.next(m => m.type === 'chat')
    assert.deepEqual([chat.message.name, chat.message.text, chat.message.gif], ['Alice', 'hi all', null])
    const late = openSocket(id, await invited(id, cookie))
    assert.deepEqual((await late.next(m => m.type === 'welcome')).chat.map((m: { text: string }) => m.text), ['hi all'])
    late.close()

    const alice = (await host.next(m => m.type === 'state' && m.viewers.length === 2)).viewers.find((v: { name: string }) => v.name === 'Alice')
    const closed = new Promise<number>(resolve => guest.onClose(resolve))
    host.send({ type: 'kick', id: alice.id })
    assert.equal(await closed, 4403)
    host.close()
})

test('guest suggestions never search the library, and accounts share a watchlist', async () => {
    const cookie = await login('alice', 'secret1')
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const guest = { cookie: await invited(id, cookie) }
    // without TMDB there is nothing to suggest from; the library's titles are never offered instead
    assert.deepEqual(await (await fetch(`${BASE}/r/${id}/search?q=Movie`, { headers: guest })).json(), [])

    const json = { cookie, 'content-type': 'application/json' }
    await fetch(`${BASE}/api/watchlist`, { method: 'POST', headers: json, body: JSON.stringify({ id: MOVIE }) })
    await fetch(`${BASE}/api/watchlist`, { method: 'POST', headers: json, body: JSON.stringify({ id: MOVIE }) }) // once only
    const other = await login('bob', 'secret1')
    const list = (await (await fetch(`${BASE}/api/watchlist`, { headers: { cookie: other } })).json()) as Array<{ id: string; addedBy: string }>
    assert.deepEqual(list.map(e => [e.id, e.addedBy]), [[MOVIE, 'alice']])
    await fetch(`${BASE}/api/watchlist/${MOVIE}`, { method: 'DELETE', headers: { cookie: other } })
    assert.deepEqual(await (await fetch(`${BASE}/api/watchlist`, { headers: { cookie } })).json(), [])
    assert.equal((await fetch(`${BASE}/api/watchlist`)).status, 403)
})

test('scheduled movie nights are listed for every account, with a calendar file but no way in', async () => {
    const alice = await login('alice', 'secret1')
    const bob = await login('bob', 'secret1')
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie: alice } })).json()) as { id: string }
    const host = openSocket(id, alice)
    await host.ready
    const at = Date.now() + 3 * 3600_000
    host.send({ type: 'cmd', cmd: { type: 'schedule', at } })
    const nights = async (cookie: string) => (await (await fetch(`${BASE}/api/nights`, { headers: { cookie } })).json()) as Array<{ id: string; host: string; startsAt: number; link: string | null; mine: boolean }>
    const seen = await waitFor(async () => (await nights(bob)).find(n => n.startsAt === at))
    assert.deepEqual([seen.mine, seen.link, seen.id.includes(id)], [false, null, false]) // bob still needs alice's invite and password, and never learns the room's address
    assert.equal((await nights(alice)).find(n => n.startsAt === at)?.link, `/?room=${id}`)
    const ics = await (await fetch(`${BASE}/api/nights/${seen.id}.ics`, { headers: { cookie: bob } })).text()
    assert.match(ics, /BEGIN:VEVENT/)
    assert.doesNotMatch(ics, new RegExp(id)) // never the room's address
    assert.equal((await fetch(`${BASE}/api/nights`)).status, 403)
    host.send({ type: 'cmd', cmd: { type: 'schedule', at: null } })
    host.close()
})

test('an oversized websocket frame drops only that client', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: { cookie: await invited(id, cookie) } })
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
    const guest = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: { cookie: await invited(id, cookie) } })
    await once(guest, 'open')
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE' })).status, 403)
    const closed = once(guest, 'close')
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie } })).status, 200)
    assert.equal((await closed)[0], 4404)
    assert.equal((await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie } })).status, 404)
})

test('only a current invite link lets a guest in', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const access = async (headers = {}) => (await (await fetch(`${BASE}/api/rooms/${id}/access`, { headers })).json()) as { allowed: boolean; invited: boolean }
    assert.deepEqual(await access(), { locked: true, allowed: false, invited: false }) // the bare room link
    const stranger = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`)
    assert.equal((await once(stranger, 'close'))[0], 4401)
    const guess = await fetch(`${BASE}/api/rooms/${id}/invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'guessed' }) })
    assert.equal(guess.status, 403)
    assert.deepEqual(await access({ cookie: await invited(id, cookie, false) }), { locked: true, allowed: false, invited: true }) // the password still
    assert.deepEqual(await access({ cookie: await invited(id, cookie) }), { locked: true, allowed: true, invited: true })
})

test('every room has a password that keeps out guests until they enter it, and the host keeps theirs', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const setPassword = (password: string, headers: Record<string, string> = { cookie }) =>
        fetch(`${BASE}/api/rooms/${id}/password`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    assert.equal((await setPassword('open sesame', {})).status, 403)
    assert.equal((await setPassword('open sesame')).status, 200)

    const access = async (headers = {}) => (await (await fetch(`${BASE}/api/rooms/${id}/access`, { headers })).json()) as { locked: boolean; allowed: boolean; invited: boolean }
    const admission = await invited(id, cookie, false)
    assert.deepEqual(await access({ cookie: admission }), { locked: true, allowed: false, invited: true })
    assert.deepEqual(await access({ cookie }), { locked: true, allowed: true, invited: true })
    const locked = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: { cookie: admission } })
    assert.equal((await once(locked, 'close'))[0], 4401)
    const playbackInfo = (headers = {}) => fetch(`${BASE}/r/${id}/jf/Items/${'a'.repeat(32)}/PlaybackInfo`, { method: 'POST', headers })
    assert.equal((await playbackInfo()).status, 401)

    const join = (password: string, cookie = admission) => fetch(`${BASE}/api/rooms/${id}/join`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ password }) })
    assert.equal((await join('open sesame', '')).status, 403) // the room id alone doesn't let anyone try passwords
    assert.equal((await join('wrong')).status, 401)
    const ok = await join('open sesame')
    assert.equal(ok.status, 200)
    const guestCookie = `${admission}; ${ok.headers.get('set-cookie')!.split(';')[0]}`
    assert.deepEqual(await access({ cookie: guestCookie }), { locked: true, allowed: true, invited: true })
    assert.equal((await playbackInfo({ cookie: guestCookie })).status, 404) // past the lock: item not in queue
    const guest = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: { cookie: guestCookie } })
    await once(guest, 'open')
    guest.close()

    const rooms = (await (await fetch(`${BASE}/api/rooms`, { headers: { cookie } })).json()) as Array<{ id: string; password: string }>
    assert.equal(rooms.find(r => r.id === id)?.password, 'open sesame')
    assert.equal((await setPassword('')).status, 400) // it can be changed, not removed
    assert.equal((await setPassword('abc')).status, 400)
    await fetch(`${BASE}/api/rooms/${id}`, { method: 'DELETE', headers: { cookie } })
    const next = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const fresh = (await (await fetch(`${BASE}/api/rooms`, { headers: { cookie } })).json()) as Array<{ id: string; password: string }>
    assert.equal(fresh.find(r => r.id === next.id)?.password, 'open sesame') // remembered for the next room
})

test('changing the password keeps whoever is watching, and shuts out everyone else', async () => {
    const cookie = await login('bob', 'secret1')
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const watching = await invited(id, cookie)
    const away = await invited(id, cookie) // let in once, but not connected when the password changes
    const viewer = openSocket(id, watching)
    await viewer.ready
    await viewer.next(m => m.type === 'welcome')
    const change = await fetch(`${BASE}/api/rooms/${id}/password`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'brand new pw' }) })
    assert.equal(change.status, 200)
    const allowed = async (guest: string) => ((await (await fetch(`${BASE}/api/rooms/${id}/access`, { headers: { cookie: guest } })).json()) as { allowed: boolean }).allowed
    assert.equal(await allowed(watching), true)
    assert.equal(await allowed(away), false)
    viewer.close()
})

test('a buffering viewer holds a playing room until it has loaded', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const host = openSocket(id, cookie)
    const guest = openSocket(id, await invited(id, cookie))
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
    const guest = openSocket(id, await invited(id, cookie))
    await guest.ready
    for (let i = 0; i < 200; i++) {
        guest.send({ type: 'hello', name: `G${i}` })
    }
    await guest.next(m => m.type === 'state' && m.viewers.some((v: { name: string }) => v.name === 'G19'))
    await sleep(300)
    // only the first 20 hellos (G0..G19) fit the 1s window; later names must never be applied
    const last = guest.messages.filter(m => m.type === 'state').at(-1)
    assert.deepEqual(last?.viewers.map((v: { name: string }) => v.name), ['G19'])
    assert.equal((await fetch(`${BASE}/api/health`)).status, 200)
    guest.close()
})

test('a room accepts at most 50 sockets', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    const guest = { cookie: await invited(id, cookie) }
    const sockets = Array.from({ length: 50 }, () => new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: guest }))
    await Promise.all(sockets.map(ws => once(ws, 'open')))
    const extra = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { headers: guest })
    await assert.rejects(once(extra, 'open'))
    sockets.forEach(ws => ws.terminate())
})
