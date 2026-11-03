import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUsers } from '../src/users.ts'

const withCookie = (token: string) => ({ headers: { cookie: `bloom_session=${token}` } }) as unknown as IncomingMessage

test('accounts and sessions survive a restart without storing passwords or tokens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bloom-users-'))
    const users = createUsers(dir, false)
    const alice = users.create('alice', 'hunter22', false)
    assert.throws(() => users.create('Alice', 'whatever1', false), /taken/)
    assert.throws(() => users.create('bob', 'short', false), /at least 6/)
    assert.equal(users.login('alice', 'wrong-pw', '1.1.1.1'), null)
    const token = users.login('ALICE', 'hunter22', '1.1.1.1')!

    const file = readFileSync(join(dir, 'users.json'), 'utf8')
    assert.ok(!file.includes('hunter22') && !file.includes(token))

    const restarted = createUsers(dir, false)
    assert.equal(restarted.fromRequest(withCookie(token))?.id, alice.id)
    restarted.update(alice.id, { disabled: true })
    assert.equal(restarted.fromRequest(withCookie(token)), null)
    assert.equal(restarted.login('alice', 'hunter22', '1.1.1.1'), null)
})
