export type QueueItem = { id: string; name: string; runtime: number }

export type NativeSession = {
    sessionId: string
    label: string
    trusted: boolean
    status: 'syncing' | 'out-of-sync'
}

export type Room = {
    id: string
    queue: QueueItem[]
    index: number
    playing: boolean
    position: number
    updatedAt: number
    guestControl: boolean
    nativeSessions: NativeSession[]
}

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

const HOST_ONLY: ReadonlySet<Command['type']> = new Set(['queueAdd', 'queueRemove', 'queueMove', 'setGuestControl'])

export function createRoom(id: string, now: number): Room {
    return { id, queue: [], index: 0, playing: false, position: 0, updatedAt: now, guestControl: true, nativeSessions: [] }
}

export function currentPosition(room: Room, now: number): number {
    return room.position + (room.playing ? (now - room.updatedAt) / 1000 : 0)
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
    }
}

/** Moves to the next item once the current one has played to its runtime. */
export function advanceIfEnded(room: Room, now: number): boolean {

    const item = room.queue[room.index]
    if (!room.playing || !item || item.runtime <= 0 || currentPosition(room, now) < item.runtime) {
        return false
    }

    return jumpTo(room, room.index + 1, now)
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
            return typeof c.value === 'boolean' ? { type: 'setGuestControl', value: c.value } : null
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
        // past the last item: stop on it
        room.playing = false
        room.position = 0
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
        room.index = Math.min(room.index, Math.max(room.queue.length - 1, 0))
        room.position = 0
        room.playing = room.playing && room.queue.length > 0
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
