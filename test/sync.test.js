import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adaptLead, decide, median, nextBackoff, targetPosition } from '../web/sync.js'

test('small drift is ignored', () => {
    assert.deepEqual(decide(0.2, true), { action: 'none' })
})

test('medium drift nudges playback rate the right way', () => {
    assert.deepEqual(decide(1, true), { action: 'rate', rate: 0.95 })
    assert.deepEqual(decide(-1, true), { action: 'rate', rate: 1.05 })
})

test('large drift seeks', () => {
    assert.deepEqual(decide(2.5, true), { action: 'seek' })
    assert.deepEqual(decide(-3, true), { action: 'seek' })
})

test('players without rate control only seek past 2s', () => {
    assert.deepEqual(decide(1, true, false), { action: 'none' })
    assert.deepEqual(decide(2.5, true, false), { action: 'seek' })
})

test('paused players seek on medium drift', () => {
    assert.deepEqual(decide(0.5, false), { action: 'seek' })
    assert.deepEqual(decide(0.2, false), { action: 'none' })
})

test('targetPosition extrapolates while playing', () => {
    const room = { position: 10, playing: true, updatedAt: 1000 }
    assert.equal(targetPosition(room, 3000), 12)
    assert.equal(targetPosition({ ...room, playing: false }, 3000), 10)
})

test('median', () => {
    assert.equal(median([5, 1, 3]), 3)
    assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('adaptLead grows when behind and shrinks when ahead', () => {
    assert.equal(adaptLead(1, -2), 3)
    assert.equal(adaptLead(3, 1.5), 1.5)
})

test('adaptLead is clamped to 0 and MAX_SEEK_LEAD', () => {
    assert.equal(adaptLead(1, 4), 0)
    assert.equal(adaptLead(4, -10), 5)
})

test('nextBackoff starts at min and doubles up to max', () => {
    assert.equal(nextBackoff(0, 5000, 60_000), 5000)
    assert.equal(nextBackoff(5000, 5000, 60_000), 10_000)
    assert.equal(nextBackoff(40_000, 5000, 60_000), 60_000)
})
