import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJellyfin } from '../src/jellyfin.ts'

test('search and queueItems pass userId when set', async (t) => {
    const urls: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        urls.push(url)
        return Response.json({ Items: [{ Id: 'a', Name: 'A', Type: 'Movie' }] })
    })
    const jf = createJellyfin('http://jf', 'key', 'u1')
    assert.equal(jf.userId, 'u1')
    await jf.search('a')
    await jf.queueItems('a')
    assert.equal(urls.length, 2)
    for (const url of urls) {
        assert.equal(new URL(url).searchParams.get('userId'), 'u1')
    }
    await createJellyfin('http://jf', 'key').search('a')
    assert.equal(new URL(urls[2]).searchParams.get('userId'), null)
})
