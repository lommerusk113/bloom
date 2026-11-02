import { normalizeId, TICKS_PER_SECOND, type Jellyfin, type JfSession } from './jellyfin.ts'
import { apply, currentPosition, type Command, type NativeSession, type Room } from './room.ts'

const COMMAND_COOLDOWN_MS = 3_000
const PLAY_COOLDOWN_MS = 15_000
const SEEK_COOLDOWN_MS = 10_000
const USER_GRACE_MS = 5_000
const SEEK_THRESHOLD = 3
const USER_JUMP = 5
const MAX_ATTEMPTS = 3
const MAX_LEAD = 5
const MAX_MISSES = 5

type Expectation = { position: number; paused: boolean; at: number }

export type NativeAction =
    | { kind: 'none' }
    | { kind: 'wait' }
    | { kind: 'lost' }
    | { kind: 'play' }
    | { kind: 'pause' }
    | { kind: 'unpause' }
    | { kind: 'seek'; position: number }
    | { kind: 'user'; cmd: Command }

type CommandAction = Extract<NativeAction, { kind: 'play' | 'pause' | 'unpause' | 'seek' }>

export type Track = {
    attempts: number
    lastCmdAt: number
    lastSeekAt: number
    lastKind: NativeAction['kind'] | null
    expect: Expectation | null
    /** Seconds added to native seeks while playing, learned from where the client lands. */
    lead: number
    pendingSeek: boolean
    /** False from our last command until the session is seen in sync. */
    confirmed: boolean
    /** Consecutive polls without the session, e.g. while the client reconnects. */
    misses: number
}

export const newTrack = (): Track => ({
    attempts: 0, lastCmdAt: 0, lastSeekAt: 0, lastKind: null, expect: null, lead: 0, pendingSeek: false, confirmed: true, misses: 0,
})

/** New seek lead after a seek landed `driftAfterSeek` seconds off the room (negative = behind). */
export const adaptLead = (lead: number, driftAfterSeek: number): number =>
    Math.min(MAX_LEAD, Math.max(0, lead - driftAfterSeek))

const isCommand = (a: NativeAction): a is CommandAction =>
    a.kind === 'play' || a.kind === 'pause' || a.kind === 'unpause' || a.kind === 'seek'
const reportedPosition = (s: JfSession): number => (s.PlayState?.PositionTicks ?? 0) / TICKS_PER_SECOND
const reportedPaused = (s: JfSession): boolean => s.PlayState?.IsPaused ?? false
const extrapolate = (position: number, paused: boolean, from: number, now: number): number =>
    position + (paused ? 0 : Math.max(0, now - from) / 1000)

/** Epoch ms of the session's last progress report; 0 when it never reported (Jellyfin sends year 0001). */
function checkInTime(s: JfSession): number {
    const time = Date.parse(s.LastPlaybackCheckIn ?? '')
    return time > 0 ? time : 0
}

/** Best guess of what the session is doing now: the newer of its last report and our last command. */
function believed(s: JfSession, t: Track, now: number): { position: number; paused: boolean } {
    const e = t.expect
    const checkIn = checkInTime(s)
    if (e && e.at > checkIn) {
        return { position: extrapolate(e.position, e.paused, e.at, now), paused: e.paused }
    }
    return { position: extrapolate(reportedPosition(s), reportedPaused(s) || !checkIn, checkIn, now), paused: reportedPaused(s) }
}

/** A fresh report contradicting our expectation, outside the grace period after our own commands. */
function detectUserAction(s: JfSession, t: Track, now: number): Command | null {

    const e = t.expect
    const checkIn = checkInTime(s)
    if (!t.confirmed || !e || checkIn <= e.at || checkIn <= t.lastCmdAt + USER_GRACE_MS) {
        return null
    }

    if (reportedPaused(s) !== e.paused) {
        return { type: reportedPaused(s) ? 'pause' : 'play' }
    }
    // falling behind by up to the time since the expectation (+2s) is buffering, not a user seek
    const drift = reportedPosition(s) - extrapolate(e.position, e.paused, e.at, checkIn)
    if (drift > USER_JUMP || -drift > Math.max(USER_JUMP, (checkIn - e.at) / 1000 + 2)) {
        return { type: 'seek', position: extrapolate(reportedPosition(s), false, checkIn, now) }
    }

    return null
}

export function decide(s: JfSession | undefined, room: Room, t: Track, now: number): NativeAction {

    if (!s) {
        return { kind: 'lost' }
    }
    const item = room.queue[room.index]
    if (!item) {
        return { kind: 'none' }
    }

    const cooling = (ms: number): boolean => now - t.lastCmdAt < ms && room.updatedAt <= t.lastCmdAt
    if (normalizeId(s.NowPlayingItem?.Id ?? '') !== normalizeId(item.id)) {
        // the session finished the item the room is ending too; relaunching it would replay the last seconds
        if (item.runtime > 0 && currentPosition(room, now) >= item.runtime - SEEK_THRESHOLD) {
            return { kind: 'none' }
        }
        return cooling(t.lastKind === 'play' ? PLAY_COOLDOWN_MS : COMMAND_COOLDOWN_MS) ? { kind: 'wait' } : { kind: 'play' }
    }

    const userCmd = detectUserAction(s, t, now)
    if (userCmd) {
        return { kind: 'user', cmd: userCmd }
    }
    // once PlayNow landed, the long play cooldown is over: a paused room must not play on for 15s
    if (cooling(COMMAND_COOLDOWN_MS)) {
        return { kind: 'wait' }
    }

    const state = believed(s, t, now)
    if (state.paused === room.playing) {
        return { kind: room.playing ? 'unpause' : 'pause' }
    }

    const target = currentPosition(room, now)
    if (Math.abs(state.position - target) <= SEEK_THRESHOLD) {
        return { kind: 'none' }
    }
    const seekCooling = now - t.lastSeekAt < SEEK_COOLDOWN_MS && room.updatedAt <= t.lastSeekAt

    return seekCooling ? { kind: 'wait' } : { kind: 'seek', position: target + (room.playing ? t.lead : 0) }
}

function expectationAfter(action: CommandAction, room: Room, position: number, now: number): Expectation {
    switch (action.kind) {
        case 'play':
            return { position: currentPosition(room, now), paused: false, at: now }
        case 'pause':
            return { position, paused: true, at: now }
        case 'unpause':
            return { position, paused: false, at: now }
        case 'seek':
            return { position: action.position, paused: !room.playing, at: now }
    }
}

export function createConductor(jf: Jellyfin, rooms: Map<string, Room>, onChange: (room: Room) => void) {

    const tracks = new Map<string, Track>()
    let running = false

    async function tick(now = Date.now()): Promise<void> {

        const active = [...rooms.values()].filter(room => room.nativeSessions.some(n => n.status === 'syncing'))
        if (running || active.length === 0) {
            return
        }

        running = true
        try {
            const sessions = await jf.sessions()
            for (const room of active) {
                for (const ns of room.nativeSessions.filter(n => n.status === 'syncing')) {
                    await step(room, ns, sessions.find(s => s.Id === ns.sessionId), now)
                }
            }
        } finally {
            running = false
        }
    }

    async function step(room: Room, ns: NativeSession, s: JfSession | undefined, now: number): Promise<void> {

        const key = `${room.id}:${ns.sessionId}`
        const t = tracks.get(key) ?? newTrack()
        tracks.set(key, t)

        t.misses = s ? 0 : t.misses + 1
        if (t.misses > 0 && t.misses < MAX_MISSES) {
            return
        }

        if (t.pendingSeek && s && checkInTime(s) > t.lastSeekAt) {
            t.lead = adaptLead(t.lead, believed(s, t, now).position - currentPosition(room, now))
            t.pendingSeek = false
        }

        const action = decide(s, room, t, now)
        if (isCommand(action) && t.lastKind !== action.kind) {
            t.attempts = 0
        }
        if (action.kind === 'lost' || (isCommand(action) && t.attempts >= MAX_ATTEMPTS)) {
            ns.status = 'out-of-sync'
            tracks.delete(key)
            onChange(room)
            return
        }

        if (isCommand(action) && s) {
            const position = believed(s, t, now).position
            await send(ns.sessionId, action, room, now)
            t.attempts++
            t.lastCmdAt = now
            t.lastKind = action.kind
            t.confirmed = false
            if (action.kind === 'seek') {
                t.lastSeekAt = now
                t.pendingSeek = room.playing
            }
            t.expect = expectationAfter(action, room, position, now)
            return
        }

        if (action.kind === 'none' && s && checkInTime(s) > t.lastCmdAt) {
            t.attempts = 0
            t.confirmed = true
        }
        if (action.kind === 'user' && apply(room, action.cmd, ns.trusted, now)) {
            onChange(room)
        }
        if (s && (!t.expect || checkInTime(s) > t.expect.at)) {
            t.expect = { position: reportedPosition(s), paused: reportedPaused(s), at: checkInTime(s) }
        }
    }

    async function send(sessionId: string, action: CommandAction, room: Room, now: number): Promise<void> {
        try {
            switch (action.kind) {
                case 'play':
                    await jf.playNow(sessionId, room.queue[room.index].id, currentPosition(room, now))
                    break
                case 'pause':
                    await jf.pause(sessionId)
                    break
                case 'unpause':
                    await jf.unpause(sessionId)
                    break
                case 'seek':
                    await jf.seek(sessionId, action.position)
                    break
            }
        } catch (err) {
            // counted as an attempt; repeated failures end in out-of-sync
            console.error(`Command ${action.kind} to session ${sessionId} failed:`, (err as Error).message)
        }
    }

    return {
        tick,
        /** Forget sync history, e.g. when the host re-adds or removes a session. */
        reset(roomId: string, sessionId: string): void {
            tracks.delete(`${roomId}:${sessionId}`)
        },
        /** Drop all sync history of a deleted room. */
        forgetRoom(roomId: string): void {
            for (const key of tracks.keys()) {
                if (key.startsWith(`${roomId}:`)) {
                    tracks.delete(key)
                }
            }
        },
    }
}
