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
