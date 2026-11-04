export type QueueItem = { id: string; name: string; runtime: number }

export type Room = {
    id: string
    /** Shown instead of what's playing, e.g. "Joakim's room". */
    name: string
    /** User id of the account that created the room: its host. */
    owner: string
    queue: QueueItem[]
    index: number
    playing: boolean
    position: number
    updatedAt: number
    guestControl: boolean
    /** Playing, but held still until buffering viewers catch up. */
    waiting: boolean
    /** A poll on what to watch next; ballots map a viewer's connection id to the option they picked. */
    vote: Vote | null
    /** When the last episode of the queue nears its end, queue the show's next episode. */
    autoContinue: boolean
    /** Jump over intros (from Jellyfin's media segments) without anyone pressing Skip. */
    autoSkip: boolean
    /** A scheduled start: the room starts playing by itself then, and isn't closed while empty before it. */
    startsAt: number | null
    /** Post to the server's Discord channel when the room opens, is scheduled, and starts something. */
    announce: boolean
    /** Titles guests suggested from the player, newest last, for the host to queue, vote on or dismiss. */
    suggestions: Array<{ id: string; name: string; by: string }>
}

export type Vote = { options: Array<{ id: string; name: string }>; ballots: Record<string, number>; endsAt: number }

export type Command =
    | { type: 'play' }
    | { type: 'pause' }
    | { type: 'seek'; position: number }
    | { type: 'next' }
    | { type: 'jump'; index: number }
    | { type: 'queueAdd'; items: QueueItem[] }
    | { type: 'queueRemove'; index: number }
    | { type: 'queueMove'; from: number; to: number }
    | { type: 'setGuestControl'; value: boolean }
    | { type: 'setAutoContinue'; value: boolean }
    | { type: 'setAutoSkip'; value: boolean }
    | { type: 'setAnnounce'; value: boolean }
    | { type: 'schedule'; at: number | null }

export const ROOM_TTL_MS = 5 * 60_000
export const MAX_SCHEDULE_MS = 30 * 24 * 3600_000
/** How long a scheduled room waits for someone to show up past its start time before it gives up. */
export const SCHEDULE_GRACE_MS = 3600_000
const HOST_ONLY: ReadonlySet<Command['type']> = new Set(['queueAdd', 'queueRemove', 'queueMove', 'setGuestControl', 'setAutoContinue', 'setAutoSkip', 'setAnnounce', 'schedule'])

export function createRoom(id: string, now: number, owner = '', name = 'Room'): Room {
    return { id, name, owner, queue: [], index: 0, playing: false, position: 0, updatedAt: now, guestControl: true, waiting: false, vote: null, autoContinue: true, autoSkip: false, startsAt: null, announce: false, suggestions: [] }
}

export function currentPosition(room: Room, now: number): number {
    return room.position + (room.playing && !room.waiting ? (now - room.updatedAt) / 1000 : 0)
}

/** Holds or releases a playing room for buffering viewers; true when that changed. */
export function setWaiting(room: Room, waiting: boolean, now: number): boolean {
    if (room.waiting === waiting) {
        return false
    }
    room.position = currentPosition(room, now)
    room.updatedAt = now
    room.waiting = waiting
    return true
}

/** Applies a command if the sender may. Mutates the room; returns false when rejected or invalid. */
export function apply(room: Room, cmd: Command, isHost: boolean, now: number): boolean {

    if (!isHost && (HOST_ONLY.has(cmd.type) || !room.guestControl)) {
        return false
    }

    const position = currentPosition(room, now)
    switch (cmd.type) {
        case 'play':
            return setPlayback(room, true, position, now)
        case 'pause':
            return setPlayback(room, false, position, now)
        case 'seek':
            return setPlayback(room, room.playing, clamp(cmd.position, 0, runtimeOf(room)), now)
        case 'next':
            return jumpTo(room, room.index + 1, now)
        case 'jump':
            return jumpTo(room, cmd.index, now)
        case 'queueAdd':
            room.queue.push(...cmd.items)
            return cmd.items.length > 0
        case 'queueRemove':
            return removeAt(room, cmd.index, now)
        case 'queueMove':
            return move(room, cmd.from, cmd.to)
        case 'setGuestControl':
            room.guestControl = cmd.value
            return true
        case 'setAutoContinue':
            room.autoContinue = cmd.value
            return true
        case 'setAutoSkip':
            room.autoSkip = cmd.value
            return true
        case 'setAnnounce':
            room.announce = cmd.value
            return true
        case 'schedule':
            if (cmd.at !== null && (cmd.at <= now || cmd.at > now + MAX_SCHEDULE_MS)) {
                return false
            }
            room.startsAt = cmd.at
            return true
    }
}

/** What a command did, for the host's activity log; read before applying it, while the queue still holds what it names. */
export function describe(room: Room, cmd: Command): string {
    const name = (index: number) => room.queue[index]?.name ?? 'an item'
    switch (cmd.type) {
        case 'play':
            return 'pressed play'
        case 'pause':
            return 'paused'
        case 'seek':
            return `jumped to ${clock(cmd.position)}`
        case 'next':
            return `skipped to ${name(room.index + 1)}`
        case 'jump':
            return `started ${name(cmd.index)}`
        case 'queueAdd':
            return `queued ${cmd.items[0]?.name ?? 'nothing'}${cmd.items.length > 1 ? ` and ${cmd.items.length - 1} more` : ''}`
        case 'queueRemove':
            return `removed ${name(cmd.index)} from the queue`
        case 'queueMove':
            return `moved ${name(cmd.from)} in the queue`
        case 'setGuestControl':
            return cmd.value ? 'let guests control playback' : 'took back control of playback'
        case 'setAutoContinue':
            return cmd.value ? 'turned on auto-continue' : 'turned off auto-continue'
        case 'setAutoSkip':
            return cmd.value ? 'turned on auto-skip intros' : 'turned off auto-skip intros'
        case 'setAnnounce':
            return cmd.value ? 'turned on Discord announcements' : 'turned off Discord announcements'
        case 'schedule':
            return cmd.at === null ? 'cancelled the scheduled start' : 'scheduled a start time'
    }
}

function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds))
    const pad = (n: number) => String(n).padStart(2, '0')
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

/** The option with the most ballots; a tie goes to the one listed first. */
export function voteWinner(vote: Vote): number {
    const counts = vote.options.map((_, i) => Object.values(vote.ballots).filter(b => b === i).length)
    return counts.indexOf(Math.max(...counts))
}

/** Queues items right after the current one; plays them now when nothing is on or the queue has run out. */
export function playNext(room: Room, items: QueueItem[], now: number): boolean {
    if (items.length === 0) {
        return false
    }
    const current = room.queue[room.index]
    const finished = !current || (!room.playing && current.runtime > 0 && room.position >= current.runtime)
    room.queue.splice(current ? room.index + 1 : room.queue.length, 0, ...items)
    if (finished) {
        jumpTo(room, current ? room.index + 1 : room.queue.length - items.length, now)
    }
    return true
}

/** Starts a scheduled room once its time has come; true when it started. */
export function startIfScheduled(room: Room, now: number): boolean {
    if (room.startsAt === null || now < room.startsAt) {
        return false
    }
    room.startsAt = null
    return setPlayback(room, true, currentPosition(room, now), now)
}

/** Moves to the next item once the current one has played to its runtime. */
export function advanceIfEnded(room: Room, now: number): boolean {

    const item = room.queue[room.index]
    if (!room.playing || !item || item.runtime <= 0 || currentPosition(room, now) < item.runtime) {
        return false
    }

    return jumpTo(room, room.index + 1, now)
}

/**
 * Advances rooms whose item ended and deletes rooms that have been empty for over ROOM_TTL_MS.
 * emptySince holds when each room became idle and is updated in place.
 */
export function sweepRooms(
    rooms: Map<string, Room>,
    viewerCount: (id: string) => number,
    emptySince: Map<string, number>,
    now: number
): { advanced: Room[]; deleted: string[] } {

    const advanced: Room[] = []
    const deleted: string[] = []
    for (const room of rooms.values()) {
        if (advanceIfEnded(room, now)) {
            advanced.push(room)
        }
        const present = viewerCount(room.id) > 0
        // a scheduled start only plays for someone: an empty room waits, then gives up
        if (present && startIfScheduled(room, now)) {
            advanced.push(room)
        } else if (room.startsAt !== null && now - room.startsAt > SCHEDULE_GRACE_MS) {
            room.startsAt = null
        }
        const idle = !present && room.startsAt === null
        if (!idle) {
            emptySince.delete(room.id)
            continue
        }
        const since = emptySince.get(room.id) ?? now
        emptySince.set(room.id, since)
        if (now - since > ROOM_TTL_MS) {
            rooms.delete(room.id)
            emptySince.delete(room.id)
            deleted.push(room.id)
        }
    }

    return { advanced, deleted }
}

/** Validates an untrusted websocket command. queueAdd is never accepted from the wire. */
export function parseCommand(input: unknown): Command | null {

    if (typeof input !== 'object' || input === null) {
        return null
    }

    const c = input as Record<string, unknown>
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
    switch (c.type) {
        case 'play':
        case 'pause':
        case 'next':
            return { type: c.type as 'play' | 'pause' | 'next' }
        case 'seek':
            return finite(c.position) ? { type: 'seek', position: c.position } : null
        case 'jump':
        case 'queueRemove':
            return Number.isInteger(c.index) ? { type: c.type as 'jump' | 'queueRemove', index: c.index as number } : null
        case 'queueMove':
            return Number.isInteger(c.from) && Number.isInteger(c.to)
                ? { type: 'queueMove', from: c.from as number, to: c.to as number }
                : null
        case 'setGuestControl':
        case 'setAutoContinue':
        case 'setAutoSkip':
        case 'setAnnounce':
            return typeof c.value === 'boolean' ? { type: c.type, value: c.value } : null
        case 'schedule':
            return c.at === null || finite(c.at) ? { type: 'schedule', at: c.at as number | null } : null
        default:
            return null
    }
}

function setPlayback(room: Room, playing: boolean, position: number, now: number): boolean {

    if (!room.queue[room.index]) {
        return false
    }

    room.playing = playing
    room.position = position
    room.updatedAt = now

    return true
}

function jumpTo(room: Room, index: number, now: number): boolean {

    if (index === room.queue.length && index > 0) {
        // past the last item: stop at its end (or where we are when the runtime is unknown)
        room.position = room.queue[room.index].runtime || currentPosition(room, now)
        room.playing = false
        room.updatedAt = now
        return true
    }
    if (index < 0 || index >= room.queue.length) {
        return false
    }

    room.index = index
    room.position = 0
    room.playing = true
    room.updatedAt = now

    return true
}

function removeAt(room: Room, index: number, now: number): boolean {

    if (index < 0 || index >= room.queue.length) {
        return false
    }

    room.queue.splice(index, 1)
    if (index < room.index) {
        room.index--
    } else if (index === room.index) {
        const removedLast = index === room.queue.length
        room.index = Math.min(room.index, Math.max(room.queue.length - 1, 0))
        // removing the last item ends the queue at the end of the previous one rather than replaying it
        room.position = removedLast ? (room.queue[room.index]?.runtime ?? 0) : 0
        room.playing = room.playing && !removedLast
        room.updatedAt = now
    }

    return true
}

function move(room: Room, from: number, to: number): boolean {

    const last = room.queue.length - 1
    if (from < 0 || from > last || to < 0 || to > last) {
        return false
    }

    const current = room.queue[room.index]
    const [item] = room.queue.splice(from, 1)
    room.queue.splice(to, 0, item)
    room.index = room.queue.indexOf(current)

    return true
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)
const runtimeOf = (room: Room): number => room.queue[room.index]?.runtime || Infinity
