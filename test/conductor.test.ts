import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adaptLead, createConductor, decide, newTrack, type Track } from '../src/conductor.ts'
import { TICKS_PER_SECOND, type Jellyfin, type JfSession } from '../src/jellyfin.ts'
import { createRoom, type Room } from '../src/room.ts'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const ITEM = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

function room(over: Partial<Room> = {}): Room {
    return { ...createRoom('r1', NOW), queue: [{ id: ITEM, name: 'A', runtime: 3600 }], playing: true, position: 100, updatedAt: NOW, ...over }
}

function session(position: number, over: { paused?: boolean; checkIn?: number; item?: string } = {}): JfSession {
    return {
        Id: 's1',
        DeviceName: 'TV',
        Client: 'Android TV',
        SupportsRemoteControl: true,
        NowPlayingItem: { Id: over.item ?? ITEM },
        PlayState: { PositionTicks: position * TICKS_PER_SECOND, IsPaused: over.paused ?? false },
        LastPlaybackCheckIn: new Date(over.checkIn ?? NOW).toISOString(),
    }
}

const track = (over: Partial<Track> = {}): Track => ({ ...newTrack(), ...over })

test('a missing session is lost', () => {
    assert.deepEqual(decide(undefined, room(), track(), NOW), { kind: 'lost' })
})

test('a session on the wrong item gets PlayNow', () => {
    assert.deepEqual(decide(session(0, { item: OTHER }), room(), track(), NOW), { kind: 'play' })
})

test('waits for a recent PlayNow to land', () => {
    const t = track({ lastCmdAt: NOW - 1000, lastKind: 'play' })
    assert.deepEqual(decide(session(0, { item: OTHER }), room({ updatedAt: NOW - 5000 }), t, NOW), { kind: 'wait' })
})

test('PlayNow is not re-sent within 15s', () => {
    const r = room({ updatedAt: NOW - 20_000 })
    const s = session(0, { item: OTHER })
    assert.deepEqual(decide(s, r, track({ lastCmdAt: NOW - 14_000, lastKind: 'play' }), NOW), { kind: 'wait' })
    assert.deepEqual(decide(s, r, track({ lastCmdAt: NOW - 16_000, lastKind: 'play' }), NOW), { kind: 'play' })
})

test('pause state mismatch is corrected', () => {
    assert.deepEqual(decide(session(100, { paused: true }), room(), track(), NOW), { kind: 'unpause' })
    assert.deepEqual(decide(session(100), room({ playing: false }), track(), NOW), { kind: 'pause' })
})

test('drift over 3s seeks to the room position', () => {
    assert.deepEqual(decide(session(104), room(), track(), NOW), { kind: 'seek', position: 100 })
})

test('drift under 3s is left alone', () => {
    assert.deepEqual(decide(session(102.5), room(), track(), NOW), { kind: 'none' })
})

test('seeks while playing include the learned lead', () => {
    assert.deepEqual(decide(session(110), room(), track({ lead: 2 }), NOW), { kind: 'seek', position: 102 })
    assert.deepEqual(decide(session(110, { paused: true }), room({ playing: false }), track({ lead: 2 }), NOW), { kind: 'seek', position: 100 })
})

test('adaptLead grows when seeks land behind and clamps to 0..5', () => {
    assert.equal(adaptLead(0, -2), 2)
    assert.equal(adaptLead(2, 0.5), 1.5)
    assert.equal(adaptLead(4, -3), 5)
    assert.equal(adaptLead(1, 3), 0)
})

test('repeated drift seeks are rate limited', () => {
    const t = track({ lastCmdAt: NOW - 5000, lastSeekAt: NOW - 5000, lastKind: 'seek' })
    assert.deepEqual(decide(session(110), room({ updatedAt: NOW - 20_000, position: 80 }), t, NOW), { kind: 'wait' })
})

test('room changes bypass the seek rate limit', () => {
    const t = track({ lastCmdAt: NOW - 5000, lastSeekAt: NOW - 5000, lastKind: 'seek' })
    assert.deepEqual(decide(session(110), room({ updatedAt: NOW - 1000, position: 100 }), t, NOW), { kind: 'seek', position: 101 })
})

test('a fresh report contradicting expectations is a user action', () => {
    const t = track({ expect: { position: 90, paused: false, at: NOW - 10_000 } })
    assert.deepEqual(decide(session(100, { paused: true }), room(), t, NOW), { kind: 'user', cmd: { type: 'pause' } })
    assert.deepEqual(decide(session(400), room(), t, NOW), { kind: 'user', cmd: { type: 'seek', position: 400 } })
})

test('an unconfirmed session ignores contradicting reports', () => {
    const t = track({ confirmed: false, expect: { position: 90, paused: false, at: NOW - 10_000 } })
    assert.deepEqual(decide(session(100, { paused: true }), room(), t, NOW), { kind: 'unpause' })
    assert.deepEqual(decide(session(400), room(), t, NOW), { kind: 'seek', position: 100 })
})

test('falling behind by buffering is not a user seek, a large backward jump is', () => {
    const t = track({ expect: { position: 100, paused: false, at: NOW - 10_000 } })
    assert.deepEqual(decide(session(100), room(), t, NOW), { kind: 'none' })
    assert.deepEqual(decide(session(50), room(), t, NOW), { kind: 'user', cmd: { type: 'seek', position: 50 } })
})

test('reports right after our own command are not user actions', () => {
    const t = track({ lastCmdAt: NOW - 4000, lastKind: 'pause', expect: { position: 100, paused: true, at: NOW - 4000 } })
    assert.deepEqual(decide(session(104), room({ playing: false, updatedAt: NOW - 5000 }), t, NOW), { kind: 'pause' })
})

test('our latest command beats an older report', () => {
    const t = track({ lastCmdAt: NOW - 4000, lastSeekAt: NOW - 4000, lastKind: 'seek', expect: { position: 96, paused: false, at: NOW - 4000 } })
    assert.deepEqual(decide(session(50, { checkIn: NOW - 20_000 }), room(), t, NOW), { kind: 'none' })
})

function setup(r: Room, getSession: () => JfSession | undefined) {
    r.nativeSessions.push({ sessionId: 's1', label: 'TV', device: 'TV', trusted: false, status: 'syncing' })
    const calls: string[] = []
    const jf = {
        sessions: async () => {
            const s = getSession()
            return s ? [s] : []
        },
        playNow: async (_id: string, item: string, position: number) => { calls.push(`play ${item} ${position}`) },
        pause: async () => { calls.push('pause') },
        unpause: async () => { calls.push('unpause') },
        seek: async (_id: string, position: number) => { calls.push(`seek ${position}`) },
    } as unknown as Jellyfin
    const changes: Room[] = []
    const conductor = createConductor(jf, new Map([[r.id, r]]), changed => changes.push(changed))
    return { conductor, calls, changes }
}

test('a session that ignores commands is marked out-of-sync after 3 attempts', async () => {
    const r = room()
    let clock = NOW
    const { conductor, calls, changes } = setup(r, () => session(100, { paused: true, checkIn: clock }))
    for (const offset of [0, 4000, 8000, 12_000]) {
        clock = NOW + offset
        await conductor.tick(clock)
    }
    assert.deepEqual(calls, ['unpause', 'unpause', 'unpause'])
    assert.equal(r.nativeSessions[0].status, 'out-of-sync')
    assert.equal(changes.length, 1)
})

test('mixed command kinds do not trip out-of-sync', async () => {
    const r = room()
    let current = session(0, { item: OTHER, checkIn: NOW })
    const { conductor, calls } = setup(r, () => current)
    const steps: [number, JfSession][] = [
        [0, current],
        [16_000, session(100, { paused: true, checkIn: NOW + 16_000 })],
        [20_000, session(50, { checkIn: NOW + 20_000 })],
        [24_000, session(124, { paused: true, checkIn: NOW + 24_000 })],
        [31_000, session(60, { checkIn: NOW + 31_000 })],
    ]
    for (const [offset, s] of steps) {
        current = s
        await conductor.tick(NOW + offset)
    }
    assert.deepEqual(calls, [`play ${ITEM} 100`, 'unpause', 'seek 120', 'unpause', 'seek 131'])
    assert.equal(r.nativeSessions[0].status, 'syncing')
})

test('forgetRoom drops sync history, so cooldowns no longer apply', async () => {
    const r = room()
    const { conductor, calls } = setup(r, () => session(100, { paused: true, checkIn: NOW }))
    await conductor.tick(NOW)
    await conductor.tick(NOW + 1000)
    assert.deepEqual(calls, ['unpause'])
    conductor.forgetRoom('r1')
    await conductor.tick(NOW + 2000)
    assert.deepEqual(calls, ['unpause', 'unpause'])
})

test('a user pause on a native app pauses the room', async () => {
    const r = room()
    let current = session(100, { checkIn: NOW })
    const { conductor, changes } = setup(r, () => current)
    await conductor.tick(NOW)
    current = session(110, { paused: true, checkIn: NOW + 10_000 })
    await conductor.tick(NOW + 10_000)
    assert.equal(r.playing, false)
    assert.equal(changes.length, 1)
})

test('with guest control off, a native user action is reverted', async () => {
    const r = room({ guestControl: false })
    let current = session(100, { checkIn: NOW })
    const { conductor, calls } = setup(r, () => current)
    await conductor.tick(NOW)
    current = session(110, { paused: true, checkIn: NOW + 10_000 })
    await conductor.tick(NOW + 10_000)
    await conductor.tick(NOW + 11_000)
    assert.equal(r.playing, true)
    assert.deepEqual(calls, ['unpause'])
})

test('none without a report newer than our command does not confirm', async () => {
    const r = room()
    let current = session(110, { checkIn: NOW - 1000 })
    const { conductor, calls, changes } = setup(r, () => current)
    await conductor.tick(NOW)
    await conductor.tick(NOW + 4000)
    // the seek was ignored: a later report is a rejection, not a user seek
    current = session(118, { checkIn: NOW + 7000 })
    await conductor.tick(NOW + 8000)
    assert.equal(changes.length, 0)
    await conductor.tick(NOW + 12_000)
    assert.deepEqual(calls, ['seek 100', 'seek 112'])
    assert.equal(r.position, 100)
})
