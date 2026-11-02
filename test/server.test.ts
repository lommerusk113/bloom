import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
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
    assert.notEqual((await fetch(`${BASE}/web/../src/server.ts`)).status, 200)
})

test('room sockets share state and know who is host', async () => {
    const cookie = await login()
    const { id } = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()) as { id: string }
    assert.equal((await fetch(`${BASE}/r/${id}/jf/Videos/${'a'.repeat(32)}/master.m3u8`)).status, 404)

    const evil = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${id}`, { origin: 'https://evil.example' })
    await assert.rejects(once(evil, 'open'))

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
