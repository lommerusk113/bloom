import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceIfEnded, apply, createRoom, currentPosition, parseCommand, sweepRooms, type QueueItem, type Room } from '../src/room.ts'

const A: QueueItem = { id: 'a'.repeat(32), name: 'A', runtime: 100 }
const B: QueueItem = { id: 'b'.repeat(32), name: 'B', runtime: 200 }
const C: QueueItem = { id: 'c'.repeat(32), name: 'C', runtime: 300 }

function roomWith(items: QueueItem[] = [A, B, C]): Room {
    const room = createRoom('r1', 0)
    apply(room, { type: 'queueAdd', items: items.map(i => ({ ...i })) }, true, 0)
    return room
}

test('position advances only while playing', () => {
    const room = roomWith()
    assert.equal(currentPosition(room, 5000), 0)
    apply(room, { type: 'play' }, true, 1000)
    assert.equal(currentPosition(room, 3000), 2)
    apply(room, { type: 'pause' }, true, 3000)
    assert.equal(currentPosition(room, 9000), 2)
})

test('seek clamps to the item runtime', () => {
    const room = roomWith()
    apply(room, { type: 'seek', position: 500 }, true, 0)
    assert.equal(room.position, 100)
    apply(room, { type: 'seek', position: -5 }, true, 0)
    assert.equal(room.position, 0)
})

test('guests never edit the queue and are blocked when guest control is off', () => {
    const room = roomWith()
    assert.equal(apply(room, { type: 'queueRemove', index: 0 }, false, 0), false)
    assert.equal(apply(room, { type: 'setGuestControl', value: false }, false, 0), false)
    assert.equal(apply(room, { type: 'play' }, false, 0), true)
    apply(room, { type: 'setGuestControl', value: false }, true, 0)
    assert.equal(apply(room, { type: 'pause' }, false, 0), false)
    assert.equal(room.playing, true)
    assert.equal(apply(room, { type: 'pause' }, true, 0), true)
})

test('next plays the following item and stops at the end of the last', () => {
    const room = roomWith([A, B])
    apply(room, { type: 'seek', position: 50 }, true, 0)
    apply(room, { type: 'next' }, true, 0)
    assert.deepEqual([room.index, room.position, room.playing], [1, 0, true])
    apply(room, { type: 'next' }, true, 0)
    assert.deepEqual([room.index, room.position, room.playing], [1, 200, false])
    assert.equal(apply(room, { type: 'jump', index: 5 }, true, 0), false)
})

test('next past a last item without runtime stops where it is', () => {
    const room = roomWith([{ ...A, runtime: 0 }])
    apply(room, { type: 'play' }, true, 0)
    apply(room, { type: 'next' }, true, 42_000)
    assert.deepEqual([room.index, room.position, room.playing], [0, 42, false])
})

test('removing items keeps the current item stable', () => {
    const room = roomWith()
    apply(room, { type: 'jump', index: 1 }, true, 0)
    apply(room, { type: 'queueRemove', index: 0 }, true, 0)
    assert.equal(room.queue[room.index].id, B.id)
    apply(room, { type: 'seek', position: 30 }, true, 0)
    apply(room, { type: 'queueRemove', index: room.index }, true, 0)
    assert.equal(room.queue[room.index].id, C.id)
    assert.equal(room.position, 0)
})

test('removing the playing last item stops instead of replaying the previous one', () => {
    const room = roomWith()
    apply(room, { type: 'jump', index: 2 }, true, 0)
    assert.equal(room.playing, true)
    apply(room, { type: 'queueRemove', index: 2 }, true, 0)
    assert.deepEqual([room.index, room.position, room.playing], [1, 200, false])
})

test('moving items follows the current item', () => {
    const room = roomWith()
    apply(room, { type: 'queueMove', from: 0, to: 2 }, true, 0)
    assert.deepEqual(room.queue.map(i => i.name), ['B', 'C', 'A'])
    assert.equal(room.index, 2)
})

test('advanceIfEnded moves on once the runtime is reached', () => {
    const room = roomWith([A, B])
    apply(room, { type: 'play' }, true, 0)
    assert.equal(advanceIfEnded(room, 99_000), false)
    assert.equal(advanceIfEnded(room, 100_000), true)
    assert.equal(room.index, 1)
})

test('parseCommand accepts valid wire commands only', () => {
    assert.deepEqual(parseCommand({ type: 'seek', position: 12.5 }), { type: 'seek', position: 12.5 })
    assert.deepEqual(parseCommand({ type: 'play', extra: 1 }), { type: 'play' })
    assert.equal(parseCommand({ type: 'seek', position: 'x' }), null)
    assert.equal(parseCommand({ type: 'jump', index: 1.5 }), null)
    assert.equal(parseCommand({ type: 'queueAdd', items: [] }), null)
    assert.equal(parseCommand(null), null)
})

test('sweepRooms deletes rooms idle past the TTL unless a viewer or syncing native keeps them', () => {
    const TTL = 30 * 60_000
    const native = { sessionId: 's', label: 'TV', device: 'TV', trusted: false, status: 'out-of-sync' as const }
    const rooms = new Map<string, Room>()
    const lonely = roomWith()
    lonely.id = 'lonely'
    lonely.nativeSessions.push({ ...native })
    const watched = roomWith()
    watched.id = 'watched'
    const synced = roomWith()
    synced.id = 'synced'
    synced.nativeSessions.push({ ...native, status: 'syncing' })
    for (const room of [lonely, watched, synced]) {
        rooms.set(room.id, room)
    }
    const emptySince = new Map<string, number>()
    let viewers = 0
    const viewerCount = (id: string) => (id === 'watched' ? viewers : 0)

    sweepRooms(rooms, viewerCount, emptySince, 0)
    viewers = 1
    sweepRooms(rooms, viewerCount, emptySince, TTL)
    viewers = 0
    assert.deepEqual(sweepRooms(rooms, viewerCount, emptySince, TTL + 1).deleted, ['lonely'])
    assert.deepEqual(sweepRooms(rooms, viewerCount, emptySince, 2 * TTL + 2).deleted, ['watched'])
    assert.deepEqual([...rooms.keys()], ['synced'])
})

test('sweepRooms reports rooms whose item ended', () => {
    const room = roomWith([A, B])
    apply(room, { type: 'play' }, true, 0)
    const { advanced } = sweepRooms(new Map([[room.id, room]]), () => 1, new Map(), 100_000)
    assert.deepEqual(advanced, [room])
    assert.equal(room.index, 1)
})

test('sweepRooms deletes an empty-queue room past the TTL even with a syncing native', () => {
    const TTL = 30 * 60_000
    const room = createRoom('r1', 0)
    room.nativeSessions.push({ sessionId: 's', label: 'TV', device: 'TV', trusted: false, status: 'syncing' })
    const rooms = new Map([[room.id, room]])
    const emptySince = new Map<string, number>()
    sweepRooms(rooms, () => 0, emptySince, 0)
    assert.deepEqual(sweepRooms(rooms, () => 0, emptySince, TTL + 1).deleted, ['r1'])
})
