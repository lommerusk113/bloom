import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, median, targetPosition } from '../web/sync.js'

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
