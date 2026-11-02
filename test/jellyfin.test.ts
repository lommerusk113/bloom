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

test('resolveUser picks the first administrator and passes it on', async (t) => {
    const urls: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        urls.push(url)
        if (url.endsWith('/Users')) {
            return Response.json([{ Id: 'u0', Name: 'kid', Policy: { IsAdministrator: false } }, { Id: 'admin', Name: 'me', Policy: { IsAdministrator: true } }])
        }
        return Response.json({ Items: [] })
    })
    const jf = createJellyfin('http://jf', 'key')
    await jf.resolveUser()
    assert.equal(jf.userId, 'admin')
    await jf.children('s1')
    const query = new URL(urls[1]).searchParams
    assert.equal(query.get('userId'), 'admin')
    assert.equal(query.get('ParentId'), 's1')
})

test('library pages through one item type and labels cards', async (t) => {
    const urls: string[] = []
    t.mock.method(globalThis, 'fetch', async (url: string) => {
        urls.push(url)
        return Response.json({ Items: [{ Id: 'e', Name: 'Pilot', Type: 'Episode', SeriesName: 'Show', ParentIndexNumber: 1, IndexNumber: 2 }], TotalRecordCount: 61 })
    })
    const page = await createJellyfin('http://jf', 'key', 'u1').library('Series', 60)
    const query = new URL(urls[0]).searchParams
    assert.equal(query.get('IncludeItemTypes'), 'Series')
    assert.equal(query.get('StartIndex'), '60')
    assert.equal(page.total, 61)
    assert.deepEqual(page.items[0], { id: 'e', name: 'Show S01E02 – Pilot', type: 'Episode', title: 'Pilot', subtitle: 'Show · S01E02' })
})

test('redact removes the api key from text', () => {
    assert.equal(createJellyfin('http://jf', 'k3y').redact('a?api_key=k3y&b=k3y'), 'a?api_key=&b=')
})
