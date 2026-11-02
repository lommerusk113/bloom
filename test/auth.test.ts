import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { createAuth } from '../src/auth.ts'

const withCookie = (cookie?: string) => ({ headers: { cookie } }) as unknown as IncomingMessage

test('correct password yields a token that identifies the host', () => {
    const auth = createAuth('secret', false)
    assert.equal(auth.login('wrong', '1.1.1.1'), null)
    const token = auth.login('secret', '1.1.1.1')
    assert.ok(token)
    assert.equal(auth.isHost(withCookie(`other=1; wp_host=${token}`)), true)
    assert.equal(auth.isHost(withCookie('wp_host=forged')), false)
    assert.equal(auth.isHost(withCookie()), false)
})

test('logins are blocked after 10 failures per ip for 15 minutes', () => {
    const auth = createAuth('secret', false)
    for (let i = 0; i < 10; i++) {
        auth.login('wrong', '2.2.2.2', 0)
    }
    assert.equal(auth.login('secret', '2.2.2.2', 1000), null)
    assert.ok(auth.login('secret', '3.3.3.3', 1000))
    assert.ok(auth.login('secret', '2.2.2.2', 15 * 60_000 + 1))
})

test('cookie is HttpOnly and SameSite=Strict, Secure on https', () => {
    assert.match(createAuth('x', true).cookie('t'), /HttpOnly; SameSite=Strict.*; Secure$/)
    assert.doesNotMatch(createAuth('x', false).cookie('t'), /Secure/)
})
