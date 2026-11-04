import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsers } from '../src/users.ts'
import { userData } from '../src/jellyfin.ts'

const withCookie = (token: string) => ({ headers: { cookie: `bloom_session=${token}` } }) as unknown as IncomingMessage
const alice = { id: 'a1', name: 'alice', admin: false }
const jellyfin = async (name: string, password: string) => (name === 'alice' && password === 'hunter22' ? alice : null)

test('Jellyfin logins survive a restart without storing tokens, and follow Jellyfin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bloom-users-'))
    const users = createUsers(dir, false, jellyfin)
    assert.equal(await users.login('alice', 'wrong-pw', '1.1.1.1'), null)
    const token = (await users.login(' alice ', 'hunter22', '1.1.1.1'))!
    assert.ok(!readFileSync(join(dir, 'sessions.json'), 'utf8').includes(token))

    const restarted = createUsers(dir, false, jellyfin)
    assert.deepEqual(restarted.fromRequest(withCookie(token)), alice)
    assert.deepEqual(restarted.refresh([{ ...alice, admin: true }]), [])
    assert.equal(restarted.fromRequest(withCookie(token))?.admin, true)
    assert.deepEqual(restarted.refresh([]), ['a1']) // disabled or deleted in Jellyfin
    assert.equal(restarted.fromRequest(withCookie(token)), null)
})

test('progress follows Jellyfin resume rules', () => {
    assert.equal(userData(60, 6000), null)
    assert.deepEqual(userData(3000, 6000), { PlaybackPositionTicks: 30_000_000_000 })
    assert.deepEqual(userData(5900, 6000), { PlaybackPositionTicks: 0, Played: true })
})

test('watch history skips short visits and sums the month', async () => {
    const { createHistory } = await import('../src/history.ts')
    const dir = mkdtempSync(join(tmpdir(), 'bloom-history-'))
    const history = createHistory(dir)
    const now = 100 * 24 * 3600_000
    history.add({ at: now - 60 * 24 * 3600_000, itemId: 'c', item: 'Cars', room: 'r', host: 'jo', viewers: ['jo'], seconds: 7200 }) // older than a month
    history.add({ at: now - 1000, itemId: 'a', item: 'Alien', room: 'r', host: 'jo', viewers: ['jo', 'kim'], seconds: 3600 })
    history.add({ at: now - 500, itemId: 'b', item: 'Brazil', room: 'r', host: 'jo', viewers: ['jo'], seconds: 30 }) // browsing
    const summary = createHistory(dir).summary(now)
    assert.deepEqual(summary.recent.map(e => e.item), ['Alien', 'Cars'])
    assert.deepEqual(summary.month, { hours: 1, items: 1, topTitles: [{ name: 'Alien', value: 1 }], topViewers: [{ name: 'jo', value: 1 }, { name: 'kim', value: 1 }] })
})
