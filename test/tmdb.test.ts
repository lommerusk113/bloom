import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTmdb } from '../src/tmdb.ts'

test('tmdb lists merge pages, dedupe, cache, and use a bearer for v4 tokens', async (t) => {
    const calls: Array<[string, RequestInit]> = []
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        calls.push([url, init])
        return Response.json({ results: [{ id: 1 }, { id: Number(new URL(url).searchParams.get('page')) + 1 }] })
    })
    const v3 = createTmdb('k'.repeat(32))
    assert.deepEqual(await v3.trending('movie'), ['1', '2', '3', '4', '5', '6'])
    assert.equal(new URL(calls[0][0]).searchParams.get('api_key'), 'k'.repeat(32))
    await v3.trending('movie')
    assert.equal(calls.length, 5) // cached
    await createTmdb('t'.repeat(200)).popular('tv')
    assert.match(calls[5][0], /\/tv\/popular\?page=1$/)
    assert.deepEqual(calls[5][1].headers, { authorization: `Bearer ${'t'.repeat(200)}` })
})
