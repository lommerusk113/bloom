# Watchparty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-hosted watch-together service for Jellyfin: guests join by link in a browser (or Chromecast), account holders can join from native Jellyfin apps, everyone stays in sync.

**Architecture:** One Node 24 service (TypeScript run directly via Node's type stripping, no build step). In-memory rooms, websocket sync for web clients, a guest proxy that forwards only queued items' HLS streams to Jellyfin with the server's API key, and a conductor that drives native Jellyfin sessions via the remote-control API. Watchparty never touches video data beyond relaying bytes — Jellyfin stays the only GPU user.

**Tech Stack:** Node 24 (`node:test`, `node:http`, global `fetch`), `ws`, `hls.js` (served from `node_modules`), Cast sender SDK, plain ES-module browser JS, Docker.

**Spec:** `docs/superpowers/specs/2026-11-02-watchparty-design.md`

**Conventions:** Commit messages are one-liners `## - <message>`. Always use braces for `if`/`for` in server code. Run all commands from the repo root `/Users/bruinen/IdeaProjects/Privat/claude`.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore` | Project config |
| `src/room.ts` | Room/queue types, pure state transitions, permission checks, wire-command validation |
| `src/jellyfin.ts` | Thin Jellyfin HTTP client (search, queue items, sessions, remote commands, raw fetch) |
| `src/proxy.ts` | Guest → Jellyfin proxy with path allowlist, queue check, API-key stripping, CORS |
| `src/auth.ts` | Host password login, session tokens, cookie, rate limit |
| `src/conductor.ts` | Native session sync: pure `decide()` + polling `tick()` |
| `src/server.ts` | Entry point: HTTP routes, websocket rooms, tickers, Jellyfin health check |
| `web/sync.js` | Pure browser sync math (drift decision, target position, median) |
| `web/ws.js` | Reconnecting room websocket + clock offset |
| `web/playback.js` | Device profile, PlaybackInfo via proxy, URL helpers |
| `web/host.html`, `web/host.js` | Host UI: login, rooms, queue, guest-control toggle, native sessions |
| `web/room.html`, `web/room.js` | Guest player: join, hls.js, custom controls, track pickers, sync loop |
| `web/cast.js` | Chromecast sender via Default Media Receiver |
| `web/style.css` | Shared styles |
| `test/*.test.ts`, `test/sync.test.js` | Tests (`node --test`) |
| `Dockerfile`, `docker-compose.example.yml`, `README.md` | Deployment |

---

### Task 0: Project scaffold

**Goal:** Git repo with Node 24 + TypeScript-check setup and dependencies installed.

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`

**Acceptance Criteria:**
- [ ] `node --version` ≥ 24
- [ ] `ws`, `hls.js` installed as dependencies; `typescript`, `@types/node`, `@types/ws` as devDependencies

**Verify:** `npm ls ws hls.js typescript @types/node @types/ws` → all five listed, no `missing`

**Steps:**

- [ ] **Step 1: Init repo and config files**

```bash
git init
```

`package.json`:

```json
{
  "name": "watchparty",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/server.ts",
    "test": "node --test \"test/**/*.test.*\"",
    "check": "tsc"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "lib": ["esnext"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
.idea/
```

`.dockerignore`:

```
node_modules
.git
.idea
docs
test
```

- [ ] **Step 2: Install dependencies**

```bash
npm install ws hls.js
npm install -D typescript @types/node@24 @types/ws
```

- [ ] **Step 3: Verify and commit**

Run: `node --version && npm ls ws hls.js typescript @types/node @types/ws`
Expected: `v24.x` and all packages listed.

```bash
git add package.json package-lock.json tsconfig.json .gitignore .dockerignore docs
git commit -m "## - Scaffold watchparty project with spec and plan"
```

---

### Task 1: Room state

**Goal:** Pure room model with play/pause/seek/queue transitions, guest-control permissions, auto-advance and wire-command validation.

**Files:**
- Create: `src/room.ts`
- Test: `test/room.test.ts`

**Acceptance Criteria:**
- [ ] Position extrapolates only while playing
- [ ] Seek clamps to `[0, runtime]`
- [ ] Guests rejected when `guestControl` is off; guests never run host-only commands
- [ ] `next` past the last item stops playback; queue remove/move keep the current item stable
- [ ] `advanceIfEnded` advances at runtime
- [ ] `parseCommand` rejects malformed input and `queueAdd`

**Verify:** `npm test` → all room tests pass

**Steps:**

- [ ] **Step 1: Write the failing test** — `test/room.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { advanceIfEnded, apply, createRoom, currentPosition, parseCommand, type QueueItem, type Room } from '../src/room.ts'

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

test('next plays the following item and stops after the last', () => {
    const room = roomWith([A, B])
    apply(room, { type: 'seek', position: 50 }, true, 0)
    apply(room, { type: 'next' }, true, 0)
    assert.deepEqual([room.index, room.position, room.playing], [1, 0, true])
    apply(room, { type: 'next' }, true, 0)
    assert.deepEqual([room.index, room.position, room.playing], [1, 0, false])
    assert.equal(apply(room, { type: 'jump', index: 5 }, true, 0), false)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '.../src/room.ts'`

- [ ] **Step 3: Implement** — `src/room.ts`

```ts
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
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npm run check`
Expected: all room tests PASS, `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/room.ts test/room.test.ts
git commit -m "## - Add in-memory room state with queue and guest-control permissions"
```

---

### Task 2: Browser sync math

**Goal:** Pure drift-correction logic shared by the web player and Cast sender.

**Files:**
- Create: `web/sync.js`
- Test: `test/sync.test.js`

**Acceptance Criteria:**
- [ ] |drift| < 0.3s → none; 0.3–2s → rate 0.95 (ahead) / 1.05 (behind); > 2s → seek
- [ ] Without rate control (Cast) only seek past 2s
- [ ] Paused players seek on drift > 0.3s
- [ ] `targetPosition` extrapolates only while playing; `median` correct for odd/even

**Verify:** `npm test` → sync tests pass

**Steps:**

- [ ] **Step 1: Write the failing test** — `test/sync.test.js`

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `web/sync.js`

- [ ] **Step 3: Implement** — `web/sync.js`

```js
// Pure sync math, shared by the player and the Cast sender.

export const RATE_THRESHOLD = 0.3
export const SEEK_THRESHOLD = 2

/** Room position in seconds at the given server time. */
export function targetPosition(room, serverNow) {
    return room.position + (room.playing ? (serverNow - room.updatedAt) / 1000 : 0)
}

/**
 * What a player should do about its drift (local - target, seconds).
 * canRate=false for players without playbackRate (Cast Default Receiver).
 */
export function decide(drift, playing, canRate = true) {
    const abs = Math.abs(drift)
    if (abs > SEEK_THRESHOLD || (!playing && abs > RATE_THRESHOLD)) {
        return { action: 'seek' }
    }
    if (playing && canRate && abs >= RATE_THRESHOLD) {
        return { action: 'rate', rate: drift > 0 ? 0.95 : 1.05 }
    }
    return { action: 'none' }
}

export function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/sync.js test/sync.test.js
git commit -m "## - Add browser drift-correction logic"
```

---

### Task 3: Jellyfin client and guest proxy

**Goal:** Thin Jellyfin API client plus a proxy that lets guests stream only items in their room's queue, without ever seeing the API key.

**Files:**
- Create: `src/jellyfin.ts`, `src/proxy.ts`
- Test: `test/proxy.test.ts`

**Acceptance Criteria:**
- [ ] Only allowlisted method+path combinations pass (`PlaybackInfo` POST, HLS playlists/segments, VTT subtitles, primary image)
- [ ] Items not in the room queue → 404, Jellyfin never called
- [ ] `.m3u8` bodies have `api_key`/`ApiKey` params stripped
- [ ] Responses carry `access-control-allow-origin: *` (Chromecast needs it)
- [ ] Upstream requested with `accept-encoding: identity` so forwarded `content-length` is correct

**Verify:** `npm test && npm run check` → proxy tests pass, no type errors

**Steps:**

- [ ] **Step 1: Write the Jellyfin client** — `src/jellyfin.ts` (no unit test: thin HTTP wrapper, exercised manually in Task 10)

```ts
import type { QueueItem } from './room.ts'

export const TICKS_PER_SECOND = 10_000_000

export type JfSession = {
    Id: string
    DeviceName: string
    Client: string
    UserName?: string
    SupportsRemoteControl: boolean
    LastPlaybackCheckIn?: string
    NowPlayingItem?: { Id: string; Name?: string }
    PlayState?: { PositionTicks?: number; IsPaused?: boolean }
}

type JfItem = {
    Id: string
    Name: string
    Type: string
    SeriesName?: string
    ParentIndexNumber?: number
    IndexNumber?: number
    RunTimeTicks?: number
    ProductionYear?: number
}

export type Jellyfin = ReturnType<typeof createJellyfin>

export const normalizeId = (id: string): string => id.replaceAll('-', '').toLowerCase()

/** Requires Jellyfin 10.9+ (user-less /Items with an API key). */
export function createJellyfin(baseUrl: string, apiKey: string) {

    const auth = `MediaBrowser Token="${apiKey}"`

    function raw(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set('Authorization', auth)
        return fetch(baseUrl + path, { ...init, headers })
    }

    async function json<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await raw(path, init)
        if (!res.ok) {
            throw new Error(`Jellyfin ${res.status} on ${path.split('?')[0]}`)
        }
        return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
    }

    async function post(path: string): Promise<void> {
        await json<void>(path, { method: 'POST' })
    }

    const session = (id: string) => `/Sessions/${encodeURIComponent(id)}/Playing`
    const ticks = (seconds: number) => String(Math.round(seconds * TICKS_PER_SECOND))

    return {
        raw,
        systemInfo: () => json<{ ServerName: string; Version: string }>('/System/Info'),

        async search(term: string): Promise<Array<{ id: string; name: string; type: string }>> {
            const query = new URLSearchParams({ searchTerm: term, IncludeItemTypes: 'Movie,Series,Season,Episode', Recursive: 'true', Limit: '25' })
            const res = await json<{ Items: JfItem[] }>(`/Items?${query}`)
            return res.Items.map(i => ({ id: i.Id, name: label(i), type: i.Type }))
        },

        /** Resolves a movie/episode to itself and a series/season to its episodes in order. */
        async queueItems(id: string): Promise<QueueItem[]> {
            const found = await json<{ Items: JfItem[] }>(`/Items?Ids=${encodeURIComponent(id)}`)
            const item = found.Items[0]
            if (!item) {
                return []
            }
            let items = [item]
            if (item.Type === 'Series' || item.Type === 'Season') {
                const query = new URLSearchParams({ ParentId: item.Id, IncludeItemTypes: 'Episode', Recursive: 'true', SortBy: 'ParentIndexNumber,IndexNumber' })
                items = (await json<{ Items: JfItem[] }>(`/Items?${query}`)).Items
            }
            return items.map(i => ({ id: i.Id, name: label(i), runtime: (i.RunTimeTicks ?? 0) / TICKS_PER_SECOND }))
        },

        sessions: () => json<JfSession[]>('/Sessions'),
        playNow: (sessionId: string, itemId: string, position: number) =>
            post(`${session(sessionId)}?${new URLSearchParams({ playCommand: 'PlayNow', itemIds: itemId, startPositionTicks: ticks(position) })}`),
        pause: (sessionId: string) => post(`${session(sessionId)}/Pause`),
        unpause: (sessionId: string) => post(`${session(sessionId)}/Unpause`),
        seek: (sessionId: string, position: number) => post(`${session(sessionId)}/Seek?seekPositionTicks=${ticks(position)}`),
    }
}

function label(i: JfItem): string {
    const pad = (n?: number) => String(n ?? 0).padStart(2, '0')
    if (i.Type === 'Episode') {
        return `${i.SeriesName} S${pad(i.ParentIndexNumber)}E${pad(i.IndexNumber)} – ${i.Name}`
    }
    if (i.Type === 'Season') {
        return `${i.SeriesName} – ${i.Name}`
    }
    return i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name
}
```

- [ ] **Step 2: Write the failing proxy test** — `test/proxy.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Jellyfin } from '../src/jellyfin.ts'
import { allowedItemId, proxyRequest, stripApiKeys } from '../src/proxy.ts'
import { createRoom, type Room } from '../src/room.ts'

const ITEM = '0123456789abcdef0123456789abcdef'

test('allowedItemId accepts streaming paths and rejects the rest', () => {
    assert.equal(allowedItemId('GET', `/videos/${ITEM}/master.m3u8`), ITEM)
    assert.equal(allowedItemId('GET', `/Videos/${ITEM}/hls1/main/-1.mp4`), ITEM)
    assert.equal(allowedItemId('GET', `/Videos/${ITEM}/${ITEM}/Subtitles/3/0/Stream.vtt`), ITEM)
    assert.equal(allowedItemId('POST', `/Items/${ITEM}/PlaybackInfo`), ITEM)
    assert.equal(allowedItemId('GET', '/Videos/01234567-89ab-cdef-0123-456789abcdef/master.m3u8'), ITEM)
    assert.equal(allowedItemId('GET', `/Items/${ITEM}/PlaybackInfo`), null)
    assert.equal(allowedItemId('DELETE', `/Videos/${ITEM}/master.m3u8`), null)
    assert.equal(allowedItemId('GET', '/Users'), null)
})

test('stripApiKeys removes keys from playlist urls', () => {
    assert.equal(stripApiKeys('main.m3u8?api_key=SECRET&a=1'), 'main.m3u8?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&ApiKey=SECRET'), '0.mp4?a=1')
    assert.equal(stripApiKeys('0.mp4?a=1&api_key=S&b=2'), '0.mp4?a=1&b=2')
})

async function serve(room: Room, jf: Jellyfin) {
    const server = createServer((req, res) => {
        proxyRequest(req, res, room, req.url ?? '/', jf).catch(() => res.destroy())
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    return { base, close: () => { server.closeAllConnections(); server.close() } }
}

test('proxy rejects items outside the queue', async () => {
    const jf = { raw: async () => { throw new Error('must not be called') } } as unknown as Jellyfin
    const { base, close } = await serve(createRoom('r', 0), jf)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8`)
    assert.equal(res.status, 404)
    close()
})

test('proxy forwards queued items, strips keys and adds CORS', async () => {
    const room = createRoom('r', 0)
    room.queue.push({ id: ITEM, name: 'X', runtime: 10 })
    const calls: Array<[string, Headers]> = []
    const jf = {
        raw: async (path: string, init: RequestInit) => {
            calls.push([path, new Headers(init.headers)])
            return new Response('#EXTM3U\nmain.m3u8?api_key=SECRET&x=1\n', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } })
        },
    } as unknown as Jellyfin
    const { base, close } = await serve(room, jf)
    const res = await fetch(`${base}/Videos/${ITEM}/master.m3u8?DeviceId=d1`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    assert.equal(await res.text(), '#EXTM3U\nmain.m3u8?x=1\n')
    assert.equal(calls[0][0], `/Videos/${ITEM}/master.m3u8?DeviceId=d1`)
    assert.equal(calls[0][1].get('accept-encoding'), 'identity')
    close()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `src/proxy.ts`

- [ ] **Step 4: Implement** — `src/proxy.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ReadableStream } from 'node:stream/web'
import { normalizeId, type Jellyfin } from './jellyfin.ts'
import type { Room } from './room.ts'

const ID = '([0-9a-f]{32}|[0-9a-f-]{36})'
const ALLOWED: ReadonlyArray<[string, RegExp]> = [
    ['POST', new RegExp(`^/Items/${ID}/PlaybackInfo$`, 'i')],
    ['GET', new RegExp(`^/Videos/${ID}/(master|main)\\.m3u8$`, 'i')],
    ['GET', new RegExp(`^/Videos/${ID}/hls1/[\\w-]+/-?\\d+\\.(ts|mp4|m4s)$`, 'i')],
    ['GET', new RegExp(`^/Videos/${ID}/${ID}/Subtitles/\\d+/(\\d+/)?Stream\\.vtt$`, 'i')],
    ['GET', new RegExp(`^/Items/${ID}/Images/Primary$`, 'i')],
]
const PASSED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']
const MAX_BODY = 1_000_000

/** The normalized item id an allowed path refers to, or null when the path is not allowed. */
export function allowedItemId(method: string, path: string): string | null {
    for (const [allowedMethod, pattern] of ALLOWED) {
        const match = method === allowedMethod ? pattern.exec(path) : null
        if (match) {
            return normalizeId(match[1])
        }
    }
    return null
}

export function stripApiKeys(playlist: string): string {
    return playlist.replace(/([?&])(?:api_key|apikey)=[^&\s"]*(&?)/gi, (_, sep: string, amp: string) => (amp ? sep : ''))
}

export async function readBody(req: IncomingMessage): Promise<string> {
    let body = ''
    for await (const chunk of req) {
        body += chunk
        if (body.length > MAX_BODY) {
            throw new Error('Request body too large')
        }
    }
    return body
}

/**
 * Forwards a guest request to Jellyfin with the server's API key.
 * Only streaming paths for items in the room's queue are allowed.
 */
// ponytail: query strings pass through untouched, so a guest who already knows another item's
// MediaSourceId could request it. Ids are unguessable GUIDs and are never listed to guests.
export async function proxyRequest(req: IncomingMessage, res: ServerResponse, room: Room, target: string, jf: Jellyfin): Promise<void> {

    const url = new URL(target, 'http://proxy')
    const method = req.method ?? 'GET'
    const itemId = allowedItemId(method, url.pathname)
    if (!itemId || !room.queue.some(item => normalizeId(item.id) === itemId)) {
        res.writeHead(404).end()
        return
    }

    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
    if (req.headers.range) {
        headers.range = req.headers.range
    }
    if (method === 'POST') {
        headers['content-type'] = 'application/json'
    }
    const upstream = await jf.raw(url.pathname + url.search, {
        method,
        headers,
        body: method === 'POST' ? await readBody(req) : undefined,
        signal: abort.signal,
    })

    const out: Record<string, string> = { 'access-control-allow-origin': '*' }
    for (const name of PASSED_HEADERS) {
        const value = upstream.headers.get(name)
        if (value) {
            out[name] = value
        }
    }

    if (url.pathname.toLowerCase().endsWith('.m3u8')) {
        delete out['content-length']
        res.writeHead(upstream.status, out).end(stripApiKeys(await upstream.text()))
        return
    }

    res.writeHead(upstream.status, out)
    if (!upstream.body) {
        res.end()
        return
    }
    Readable.fromWeb(upstream.body as ReadableStream).on('error', () => res.destroy()).pipe(res)
}
```

- [ ] **Step 5: Run tests and type check**

Run: `npm test && npm run check`
Expected: PASS, no type errors. If `tsc` rejects the `as ReadableStream` cast, use `as unknown as ReadableStream`.

- [ ] **Step 6: Commit**

```bash
git add src/jellyfin.ts src/proxy.ts test/proxy.test.ts
git commit -m "## - Add Jellyfin client and queue-restricted guest proxy"
```

---

### Task 4: Host auth

**Goal:** Password login producing an HttpOnly session cookie, with per-IP rate limiting.

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Acceptance Criteria:**
- [ ] Right password → token; `isHost` true only with a valid `wp_host` cookie
- [ ] 10 failures per IP block that IP for 15 minutes; other IPs unaffected
- [ ] Cookie is `HttpOnly; SameSite=Strict`, plus `Secure` when `PUBLIC_URL` is https
- [ ] Password compared in constant time

**Verify:** `npm test` → auth tests pass

**Steps:**

- [ ] **Step 1: Write the failing test** — `test/auth.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { createAuth } from '../src/auth.ts'

const withCookie = (cookie?: string) => ({ headers: { cookie } }) as unknown as IncomingMessage

test('correct password yields a token that identifies the host', () => {
    const auth = createAuth('secret', false)
    assert.equal(auth.login('wrong', '1.1.1.1'), null)
    const token = auth.login('secret', '1.1.1.1')
    assert.ok(token)
    assert.equal(auth.isHost(withCookie(`other=1; wp_host=${token}`)), true)
    assert.equal(auth.isHost(withCookie('wp_host=forged')), false)
    assert.equal(auth.isHost(withCookie()), false)
})

test('logins are blocked after 10 failures per ip for 15 minutes', () => {
    const auth = createAuth('secret', false)
    for (let i = 0; i < 10; i++) {
        auth.login('wrong', '2.2.2.2', 0)
    }
    assert.equal(auth.login('secret', '2.2.2.2', 1000), null)
    assert.ok(auth.login('secret', '3.3.3.3', 1000))
    assert.ok(auth.login('secret', '2.2.2.2', 15 * 60_000 + 1))
})

test('cookie is HttpOnly and SameSite=Strict, Secure on https', () => {
    assert.match(createAuth('x', true).cookie('t'), /HttpOnly; SameSite=Strict.*; Secure$/)
    assert.doesNotMatch(createAuth('x', false).cookie('t'), /Secure/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `src/auth.ts`

- [ ] **Step 3: Implement** — `src/auth.ts`

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const COOKIE = 'wp_host'
const MAX_AGE_S = 30 * 24 * 3600
const MAX_FAILURES = 10
const WINDOW_MS = 15 * 60_000

// ponytail: tokens live in memory, so a restart logs the host out. Fine for one host.
export function createAuth(password: string, secure: boolean) {

    const expected = digest(password)
    const tokens = new Set<string>()
    const failures = new Map<string, { count: number; since: number }>()

    return {
        /** A new session token, or null when the password is wrong or the ip is rate limited. */
        login(attempt: string, ip: string, now = Date.now()): string | null {

            const previous = failures.get(ip)
            const current = previous && now - previous.since <= WINDOW_MS ? previous : undefined
            if (current && current.count >= MAX_FAILURES) {
                return null
            }

            if (!timingSafeEqual(digest(attempt), expected)) {
                failures.set(ip, { count: (current?.count ?? 0) + 1, since: current?.since ?? now })
                return null
            }

            const token = randomBytes(32).toString('base64url')
            tokens.add(token)

            return token
        },

        isHost(req: IncomingMessage): boolean {
            const token = parseCookies(req.headers.cookie).get(COOKIE)
            return token !== undefined && tokens.has(token)
        },

        cookie(token: string): string {
            return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`
        },
    }
}

function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest()
}

function parseCookies(header = ''): Map<string, string> {
    const cookies = new Map<string, string>()
    for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0) {
            cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
        }
    }
    return cookies
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts test/auth.test.ts
git commit -m "## - Add host password login with rate limiting"
```

---

### Task 5: Native conductor

**Goal:** Keep native Jellyfin sessions in sync with the room via remote control, detect user actions on native remotes, and flag sessions that ignore commands.

**Files:**
- Create: `src/conductor.ts`
- Test: `test/conductor.test.ts`

**Design notes (read before coding):**
- Native clients report progress infrequently, so the conductor keeps an *expectation* per session: the newer of the last report and the last command it sent. `believed()` uses whichever is newer.
- A *fresh* report (check-in newer than the expectation) that contradicts it — different pause state, or position off by > 5s — is a user action, unless it arrives within 5s of our own last command (grace period).
- Corrections: wrong item → `PlayNow`; pause mismatch → `Pause`/`Unpause`; drift > 2s → `Seek`. Cooldowns: 3s between commands (4s after `PlayNow`), 10s between drift seeks. A room change (`room.updatedAt` newer than the last command) skips the cooldowns.
- At most 3 consecutive corrections; the 4th needed correction marks the session `out-of-sync`. A tick where nothing needs correcting resets the counter.
- Native user actions use `apply(room, cmd, ns.trusted)`: trusted devices (the host's own) always control; others follow `guestControl`. A rejected action is reverted by normal correction.

**Acceptance Criteria:**
- [ ] `decide()` covers lost / play / wait / pause / unpause / seek / none / user as tested below
- [ ] `tick()` marks a session that ignores commands `out-of-sync` after 3 attempts and calls `onChange` once
- [ ] A native user pause pauses the room when allowed; is reverted when guest control is off

**Verify:** `npm test && npm run check` → conductor tests pass

**Steps:**

- [ ] **Step 1: Write the failing test** — `test/conductor.test.ts`

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConductor, decide, newTrack, type Track } from '../src/conductor.ts'
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

test('pause state mismatch is corrected', () => {
    assert.deepEqual(decide(session(100, { paused: true }), room(), track(), NOW), { kind: 'unpause' })
    assert.deepEqual(decide(session(100), room({ playing: false }), track(), NOW), { kind: 'pause' })
})

test('drift over 2s seeks to the room position', () => {
    assert.deepEqual(decide(session(103), room(), track(), NOW), { kind: 'seek', position: 100 })
})

test('drift under 2s is left alone', () => {
    assert.deepEqual(decide(session(101.5), room(), track(), NOW), { kind: 'none' })
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

test('reports right after our own command are not user actions', () => {
    const t = track({ lastCmdAt: NOW - 4000, lastKind: 'pause', expect: { position: 100, paused: true, at: NOW - 4000 } })
    assert.deepEqual(decide(session(104), room({ playing: false, updatedAt: NOW - 5000 }), t, NOW), { kind: 'pause' })
})

test('our latest command beats an older report', () => {
    const t = track({ lastCmdAt: NOW - 4000, lastSeekAt: NOW - 4000, lastKind: 'seek', expect: { position: 96, paused: false, at: NOW - 4000 } })
    assert.deepEqual(decide(session(50, { checkIn: NOW - 20_000 }), room(), t, NOW), { kind: 'none' })
})

function setup(r: Room, getSession: () => JfSession | undefined) {
    r.nativeSessions.push({ sessionId: 's1', label: 'TV', trusted: false, status: 'syncing' })
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot find `src/conductor.ts`

- [ ] **Step 3: Implement** — `src/conductor.ts`

```ts
import { normalizeId, TICKS_PER_SECOND, type Jellyfin, type JfSession } from './jellyfin.ts'
import { apply, currentPosition, type Command, type NativeSession, type Room } from './room.ts'

const COMMAND_COOLDOWN_MS = 3_000
const PLAY_COOLDOWN_MS = 4_000
const SEEK_COOLDOWN_MS = 10_000
const USER_GRACE_MS = 5_000
const SEEK_THRESHOLD = 2
const USER_JUMP = 5
const MAX_ATTEMPTS = 3

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
}

export const newTrack = (): Track => ({ attempts: 0, lastCmdAt: 0, lastSeekAt: 0, lastKind: null, expect: null })

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
    if (!e || checkIn <= e.at || checkIn <= t.lastCmdAt + USER_GRACE_MS) {
        return null
    }

    if (reportedPaused(s) !== e.paused) {
        return { type: reportedPaused(s) ? 'pause' : 'play' }
    }
    if (Math.abs(reportedPosition(s) - extrapolate(e.position, e.paused, e.at, checkIn)) > USER_JUMP) {
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

    const cooldown = t.lastKind === 'play' ? PLAY_COOLDOWN_MS : COMMAND_COOLDOWN_MS
    const cooling = now - t.lastCmdAt < cooldown && room.updatedAt <= t.lastCmdAt
    if (normalizeId(s.NowPlayingItem?.Id ?? '') !== normalizeId(item.id)) {
        return cooling ? { kind: 'wait' } : { kind: 'play' }
    }

    const userCmd = detectUserAction(s, t, now)
    if (userCmd) {
        return { kind: 'user', cmd: userCmd }
    }
    if (cooling) {
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

    return seekCooling ? { kind: 'wait' } : { kind: 'seek', position: target }
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

        const action = decide(s, room, t, now)
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
            if (action.kind === 'seek') {
                t.lastSeekAt = now
            }
            t.expect = expectationAfter(action, room, position, now)
            return
        }

        if (action.kind === 'none') {
            t.attempts = 0
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
    }
}
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npm run check`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/conductor.ts test/conductor.test.ts
git commit -m "## - Add native Jellyfin session conductor"
```

---

### Task 6: Server wiring

**Goal:** Runnable service: HTTP routes, host API, websocket rooms, auto-advance and cleanup tickers, conductor loop, Jellyfin health check.

**Files:**
- Create: `src/server.ts`, `web/style.css` (placeholder needed by the smoke test; real styles in Task 7)
- Test: `test/server.test.ts`

**Routes:**

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/` | all | `web/host.html` |
| GET | `/r/:id` | all | `web/room.html` |
| GET/POST | `/r/:id/jf/*` | all | guest proxy |
| GET | `/web/<name>.(js\|css\|html)` | all | static files |
| GET | `/vendor/hls.min.js` | all | hls.js from `node_modules` |
| GET | `/api/health`, `/api/me` | all | liveness; `{ host, jellyfinError }` |
| POST | `/api/login` | all | `{ password }` → cookie |
| GET/POST | `/api/rooms` | host | list / create rooms |
| GET | `/api/search?q=` | host | library search |
| GET | `/api/sessions` | host | remote-controllable Jellyfin sessions |
| WS | `/ws/:id` | all | room socket |

**Websocket messages** — client → server: `hello {name}`, `ping {t0}`, `cmd {cmd}`, host only: `addItem {itemId}`, `nativeAdd {sessionId, label, trusted}`, `nativeRemove {sessionId}`. Server → client: `welcome {isHost}`, `pong {t0, server}`, `state {room, viewers, serverNow}`, `error {message}`.

**Acceptance Criteria:**
- [ ] Starts without Jellyfin; `/api/me` reports `jellyfinError`
- [ ] Host-only endpoints return 403 without the cookie; wrong password → 401
- [ ] Sockets get `welcome` with the right `isHost`, and a shared `state` with viewer names
- [ ] Guest proxy returns 404 for items not in the queue
- [ ] Rooms with no sockets and no syncing native sessions are deleted after 30 min

**Verify:** `npm test && npm run check` → smoke tests pass

**Steps:**

- [ ] **Step 1: Write the failing smoke test** — `test/server.test.ts`

```ts
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'

const PORT = 18_000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
let server: ChildProcess

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor<T>(probe: () => Promise<T | undefined>): Promise<T> {
    for (let i = 0; i < 50; i++) {
        try {
            const value = await probe()
            if (value !== undefined) {
                return value
            }
        } catch {
            // not ready yet
        }
        await sleep(100)
    }
    throw new Error('timed out')
}

before(async () => {
    server = spawn(process.execPath, ['src/server.ts'], {
        env: { ...process.env, PORT: String(PORT), JELLYFIN_URL: 'http://127.0.0.1:9', JELLYFIN_API_KEY: 'x', HOST_PASSWORD: 'pw', PUBLIC_URL: BASE },
        stdio: 'ignore',
    })
    await waitFor(async () => ((await fetch(`${BASE}/api/health`)).ok ? true : undefined))
})

after(() => {
    server.kill()
})

async function login(): Promise<string> {
    const res = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })
    assert.equal(res.status, 200)
    return res.headers.get('set-cookie')!.split(';')[0]
}

function openSocket(roomId: string, cookie?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${roomId}`, { headers: cookie ? { cookie } : {} })
    const messages: Array<Record<string, any>> = []
    ws.on('message', data => messages.push(JSON.parse(String(data))))
    return {
        ready: once(ws, 'open'),
        send: (msg: unknown) => ws.send(JSON.stringify(msg)),
        close: () => ws.close(),
        next: (match: (m: Record<string, any>) => boolean) => waitFor(async () => messages.find(match)),
    }
}

test('reports Jellyfin problems without crashing', async () => {
    const me = await waitFor(async () => {
        const body = await (await fetch(`${BASE}/api/me`)).json()
        return /Cannot reach Jellyfin/.test(body.jellyfinError ?? '') ? body : undefined
    })
    assert.equal(me.host, false)
})

test('host-only endpoints require login', async () => {
    assert.equal((await fetch(`${BASE}/api/rooms`, { method: 'POST' })).status, 403)
    const wrong = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }) })
    assert.equal(wrong.status, 401)
})

test('serves pages and static files, never source', async () => {
    assert.equal((await fetch(`${BASE}/web/style.css`)).status, 200)
    assert.notEqual((await fetch(`${BASE}/web/../src/server.ts`)).status, 200)
})

test('room sockets share state and know who is host', async () => {
    const cookie = await login()
    const { id } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { cookie } })).json()
    assert.equal((await fetch(`${BASE}/r/${id}/jf/Videos/${'a'.repeat(32)}/master.m3u8`)).status, 404)

    const host = openSocket(id, cookie)
    const guest = openSocket(id)
    await Promise.all([host.ready, guest.ready])
    host.send({ type: 'hello', name: 'Host' })
    guest.send({ type: 'hello', name: 'Alice' })
    assert.equal((await host.next(m => m.type === 'welcome')).isHost, true)
    assert.equal((await guest.next(m => m.type === 'welcome')).isHost, false)

    guest.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    host.send({ type: 'cmd', cmd: { type: 'setGuestControl', value: false } })
    const state = await guest.next(m => m.type === 'state' && m.room.guestControl === false && m.viewers.includes('Alice'))
    assert.deepEqual([...state.viewers].sort(), ['Alice', 'Host'])
    host.close()
    guest.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
printf '/* styles in Task 7 */\n' > web/style.css
npm test
```

Expected: FAIL — `before` hook times out (no `src/server.ts`).

- [ ] **Step 3: Implement** — `src/server.ts`

```ts
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { createAuth } from './auth.ts'
import { createConductor } from './conductor.ts'
import { createJellyfin } from './jellyfin.ts'
import { proxyRequest, readBody } from './proxy.ts'
import { advanceIfEnded, apply, createRoom, parseCommand, type Room } from './room.ts'

type Client = { ws: WebSocket; name: string; isHost: boolean }

const ROOM_TTL_MS = 30 * 60_000
const WEB_DIR = join(import.meta.dirname, '..', 'web')
const HLS_JS = join(import.meta.dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js')
const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
}

const PORT = Number(process.env.PORT ?? 8080)
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`
const jf = createJellyfin(required('JELLYFIN_URL').replace(/\/$/, ''), required('JELLYFIN_API_KEY'))
const auth = createAuth(required('HOST_PASSWORD'), PUBLIC_URL.startsWith('https:'))

const rooms = new Map<string, Room>()
const clients = new Map<string, Set<Client>>()
const emptySince = new Map<string, number>()
const conductor = createConductor(jf, rooms, broadcast)
let jellyfinError: string | null = 'Not checked yet'

function required(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Missing required env var ${name}`)
    }
    return value
}

// --- room state fan-out ---

function stateMessage(room: Room): string {
    const viewers = [...(clients.get(room.id) ?? [])].map(c => c.name)
    return JSON.stringify({ type: 'state', room, viewers, serverNow: Date.now() })
}

function broadcast(room: Room): void {
    const msg = stateMessage(room)
    for (const client of clients.get(room.id) ?? []) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg)
        }
    }
}

// --- http ---

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function sendFile(res: ServerResponse, path: string): Promise<void> {
    try {
        const body = await readFile(path)
        res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
    } catch {
        res.writeHead(404).end()
    }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    try {
        return JSON.parse(await readBody(req))
    } catch {
        return {}
    }
}

function roomSummary(room: Room) {
    return { id: room.id, title: room.queue[room.index]?.name ?? 'Empty room', viewers: clients.get(room.id)?.size ?? 0 }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {

    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    const proxied = /^\/r\/([\w-]+)\/jf(\/.*)$/.exec(path)
    if (proxied) {
        const room = rooms.get(proxied[1])
        return room ? proxyRequest(req, res, room, proxied[2] + url.search, jf) : sendJson(res, 404, { error: 'Room not found' })
    }

    if (method === 'GET') {
        if (path === '/') {
            return sendFile(res, join(WEB_DIR, 'host.html'))
        }
        if (/^\/r\/[\w-]+$/.test(path)) {
            return sendFile(res, join(WEB_DIR, 'room.html'))
        }
        if (path === '/vendor/hls.min.js') {
            return sendFile(res, HLS_JS)
        }
        const asset = /^\/web\/([\w-]+\.(?:js|css|html))$/.exec(path)
        if (asset) {
            return sendFile(res, join(WEB_DIR, asset[1]))
        }
        if (path === '/api/health') {
            return sendJson(res, 200, { ok: true })
        }
        if (path === '/api/me') {
            return sendJson(res, 200, { host: auth.isHost(req), jellyfinError })
        }
    }

    if (method === 'POST' && path === '/api/login') {
        const body = await readJson(req)
        // ponytail: behind a reverse proxy all logins share the proxy's ip, making the limit global
        const token = auth.login(String(body.password ?? ''), req.socket.remoteAddress ?? '')
        if (!token) {
            return sendJson(res, 401, { error: 'Wrong password or too many attempts' })
        }
        res.setHeader('set-cookie', auth.cookie(token))
        return sendJson(res, 200, { ok: true })
    }

    if (!auth.isHost(req)) {
        return sendJson(res, 403, { error: 'Host login required' })
    }

    if (method === 'GET' && path === '/api/rooms') {
        return sendJson(res, 200, [...rooms.values()].map(roomSummary))
    }
    if (method === 'POST' && path === '/api/rooms') {
        const id = randomBytes(16).toString('base64url')
        rooms.set(id, createRoom(id, Date.now()))
        return sendJson(res, 200, { id })
    }
    if (method === 'GET' && path === '/api/search') {
        return sendJson(res, 200, await jf.search(url.searchParams.get('q') ?? ''))
    }
    if (method === 'GET' && path === '/api/sessions') {
        const sessions = (await jf.sessions()).filter(s => s.SupportsRemoteControl)
        return sendJson(res, 200, sessions.map(s => ({ id: s.Id, label: `${s.UserName ?? 'Unknown'} – ${s.DeviceName} (${s.Client})` })))
    }

    return sendJson(res, 404, { error: 'Not found' })
}

const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
        if (err.name !== 'AbortError') {
            console.error(`${req.method} ${req.url} failed:`, err.message)
        }
        if (res.headersSent) {
            res.destroy()
        } else {
            sendJson(res, 502, { error: 'Upstream error' })
        }
    })
})

// --- websockets ---

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })

server.on('upgrade', (req, socket, head) => {
    const match = /^\/ws\/([\w-]+)$/.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
    const room = match ? rooms.get(match[1]) : undefined
    if (!room) {
        socket.destroy()
        return
    }
    wss.handleUpgrade(req, socket, head, ws => onJoin(ws, room, auth.isHost(req)))
})

function onJoin(ws: WebSocket, room: Room, isHost: boolean): void {

    const client: Client = { ws, name: 'Guest', isHost }
    const set = clients.get(room.id) ?? new Set<Client>()
    clients.set(room.id, set)
    set.add(client)
    ws.send(JSON.stringify({ type: 'welcome', isHost }))
    broadcast(room)

    ws.on('message', data => {
        let msg: unknown
        try {
            msg = JSON.parse(String(data))
        } catch {
            return
        }
        if (typeof msg !== 'object' || msg === null) {
            return
        }
        onMessage(client, room, msg as Record<string, unknown>).catch((err: Error) => {
            console.error('Room message failed:', err.message)
            ws.send(JSON.stringify({ type: 'error', message: err.message }))
        })
    })

    ws.on('close', () => {
        set.delete(client)
        broadcast(room)
    })
}

async function onMessage(client: Client, room: Room, msg: Record<string, unknown>): Promise<void> {

    const now = Date.now()
    switch (msg.type) {
        case 'hello':
            client.name = String(msg.name ?? '').trim().slice(0, 32) || 'Guest'
            break
        case 'ping':
            client.ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, server: now }))
            return
        case 'cmd': {
            const cmd = parseCommand(msg.cmd)
            if (!cmd || !apply(room, cmd, client.isHost, now)) {
                client.ws.send(stateMessage(room)) // rejected: resync the sender
                return
            }
            break
        }
        case 'addItem':
            if (!client.isHost) {
                return
            }
            apply(room, { type: 'queueAdd', items: await jf.queueItems(String(msg.itemId)) }, true, now)
            break
        case 'nativeAdd': {
            if (!client.isHost) {
                return
            }
            const sessionId = String(msg.sessionId)
            const trusted = msg.trusted === true
            const existing = room.nativeSessions.find(n => n.sessionId === sessionId)
            if (existing) {
                existing.status = 'syncing'
                existing.trusted = trusted
            } else {
                room.nativeSessions.push({ sessionId, label: String(msg.label ?? sessionId).slice(0, 80), trusted, status: 'syncing' })
            }
            conductor.reset(room.id, sessionId)
            break
        }
        case 'nativeRemove':
            if (!client.isHost) {
                return
            }
            room.nativeSessions = room.nativeSessions.filter(n => n.sessionId !== msg.sessionId)
            conductor.reset(room.id, String(msg.sessionId))
            break
        default:
            return
    }

    broadcast(room)
}

// --- background loops ---

setInterval(() => {
    const now = Date.now()
    for (const room of rooms.values()) {
        if (advanceIfEnded(room, now)) {
            broadcast(room)
        }
        const idle = (clients.get(room.id)?.size ?? 0) === 0 && !room.nativeSessions.some(n => n.status === 'syncing')
        if (!idle) {
            emptySince.delete(room.id)
            continue
        }
        const since = emptySince.get(room.id) ?? now
        emptySince.set(room.id, since)
        if (now - since > ROOM_TTL_MS) {
            rooms.delete(room.id)
            clients.delete(room.id)
            emptySince.delete(room.id)
        }
    }
}, 1000)

setInterval(() => {
    conductor.tick().catch((err: Error) => console.error('Conductor:', err.message))
}, 1000)

async function checkJellyfin(): Promise<void> {
    const before = jellyfinError
    try {
        const info = await jf.systemInfo()
        jellyfinError = null
        if (before !== null) {
            console.log(`Connected to Jellyfin "${info.ServerName}" ${info.Version}`)
        }
    } catch (err) {
        jellyfinError = `Cannot reach Jellyfin: ${(err as Error).message}`
        if (before !== jellyfinError) {
            console.error(jellyfinError)
        }
    }
}

checkJellyfin()
setInterval(checkJellyfin, 30_000)
server.listen(PORT, () => console.log(`Watchparty listening on :${PORT} (${PUBLIC_URL})`))
```

- [ ] **Step 4: Run tests and type check**

Run: `npm test && npm run check`
Expected: all tests PASS (including the 4 smoke tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts web/style.css test/server.test.ts
git commit -m "## - Add HTTP and websocket server wiring"
```

---

### Task 7: Shared web modules and host UI

**Goal:** Host can log in, create/reopen rooms, search and queue items, toggle guest control, and add native Jellyfin sessions.

**Files:**
- Create: `web/ws.js`, `web/playback.js`, `web/host.html`, `web/host.js`
- Modify: `web/style.css` (replace placeholder)

**Acceptance Criteria:**
- [ ] Unauthenticated visit to `/` shows login; wrong password shows the error
- [ ] Logged-in host sees rooms, can create one and lands on `/?room=<id>`
- [ ] Search → Add puts items (series expand to episodes) into the queue; Play/↑/↓/✕ work
- [ ] Guest-control checkbox reflects and changes room state
- [ ] Native session dropdown lists remote-controllable Jellyfin sessions; Add/Retry/Remove work
- [ ] Jellyfin errors are shown at the top
- [ ] Usable at 375px width

**Verify:** Manual — `JELLYFIN_URL=… JELLYFIN_API_KEY=… HOST_PASSWORD=pw npm start`, open `http://localhost:8080`, walk through the criteria above.

**Steps:**

- [ ] **Step 1: Reconnecting socket** — `web/ws.js`

```js
import { median } from './sync.js'

/** Reconnecting websocket to a room. onMessage gets every server message except clock pongs. */
export function connectRoom(roomId, name, onMessage) {
    const samples = []
    let ws = null
    let retries = 0

    const socket = {
        offset: 0,
        serverNow: () => Date.now() + socket.offset,
        send(msg) {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg))
            }
        },
    }
    const ping = () => socket.send({ type: 'ping', t0: Date.now() })

    function open() {
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`)
        ws.onopen = () => {
            retries = 0
            socket.send({ type: 'hello', name })
            for (let i = 0; i < 5; i++) {
                setTimeout(ping, i * 200)
            }
        }
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data)
            if (msg.type !== 'pong') {
                onMessage(msg)
                return
            }
            samples.push(msg.server - (msg.t0 + Date.now()) / 2)
            if (samples.length > 5) {
                samples.shift()
            }
            socket.offset = median(samples)
        }
        ws.onclose = () => {
            onMessage({ type: 'error', message: 'Connection lost – reconnecting…' })
            setTimeout(open, Math.min(1000 * 2 ** retries++, 15_000))
        }
    }

    open()
    setInterval(ping, 30_000)
    return socket
}
```

- [ ] **Step 2: Playback helpers** — `web/playback.js`

```js
// Talking to Jellyfin through the room's proxy.

export const proxied = (roomId, path) => `/r/${roomId}/jf${path}`

export const subtitlePath = (itemId, sourceId, index) => `/Videos/${itemId}/${sourceId}/Subtitles/${index}/0/Stream.vtt`

/** Gives each viewer its own Jellyfin transcode job (all proxied requests share one API key). */
export function withDevice(url, deviceId) {
    const u = new URL(url, location.origin)
    u.searchParams.set('DeviceId', deviceId)
    return u.pathname + u.search
}

/**
 * Everything is served as HLS so the proxy only needs streaming paths.
 * Video is copied (remux) whenever the browser can decode it; Jellyfin transcodes only what it must.
 * castSafe: H.264/AAC only, for the Chromecast Default Receiver.
 */
export function deviceProfile(video, castSafe = false) {
    const can = (type) => !castSafe && Boolean(
        window.MediaSource?.isTypeSupported(type) || window.ManagedMediaSource?.isTypeSupported(type) || video?.canPlayType(type),
    )
    const videoCodecs = ['h264']
    if (can('video/mp4; codecs="hvc1.1.6.L120.90"')) {
        videoCodecs.push('hevc')
    }
    if (can('video/mp4; codecs="av01.0.08M.08"')) {
        videoCodecs.push('av1')
    }
    const audioCodecs = ['aac', 'mp3']
    if (can('audio/mp4; codecs="ac-3"')) {
        audioCodecs.push('ac3')
    }
    if (can('audio/mp4; codecs="ec-3"')) {
        audioCodecs.push('eac3')
    }
    const textSubs = ['vtt', 'srt', 'subrip', 'ass', 'ssa'].map(Format => ({ Format, Method: 'External' }))
    return {
        MaxStreamingBitrate: 120_000_000,
        DirectPlayProfiles: [],
        TranscodingProfiles: [{
            Type: 'Video',
            Container: 'mp4',
            Protocol: 'hls',
            Context: 'Streaming',
            VideoCodec: videoCodecs.join(','),
            AudioCodec: audioCodecs.join(','),
            MaxAudioChannels: '6',
            BreakOnNonKeyFrames: true,
            MinSegments: 1,
        }],
        SubtitleProfiles: [...textSubs, { Format: 'pgssub', Method: 'Encode' }, { Format: 'dvdsub', Method: 'Encode' }],
        CodecProfiles: [],
        ContainerProfiles: [],
        ResponseProfiles: [],
    }
}

/** Returns the media source with a TranscodingUrl. subs: stream index to burn in, -1 for none, null for Jellyfin's default. */
export async function playbackInfo(roomId, itemId, profile, { deviceId, audio = null, subs = null, bitrate = null }) {
    const query = new URLSearchParams({
        DeviceId: deviceId,
        MaxStreamingBitrate: String(bitrate ?? 120_000_000),
        EnableDirectPlay: 'false',
        EnableDirectStream: 'false',
        EnableTranscoding: 'true',
        AllowVideoStreamCopy: 'true',
        AllowAudioStreamCopy: 'true',
        AutoOpenLiveStream: 'false',
    })
    if (audio !== null) {
        query.set('AudioStreamIndex', String(audio))
    }
    if (subs !== null) {
        query.set('SubtitleStreamIndex', String(subs))
    }
    const res = await fetch(`${proxied(roomId, `/Items/${itemId}/PlaybackInfo`)}?${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ DeviceProfile: profile }),
    })
    if (!res.ok) {
        throw new Error(`Server unavailable (${res.status})`)
    }
    const source = (await res.json()).MediaSources?.[0]
    if (!source?.TranscodingUrl) {
        throw new Error('Jellyfin offered no stream for this item')
    }
    return source
}
```

- [ ] **Step 3: Styles** — `web/style.css` (replace the placeholder)

```css
:root {
    color-scheme: dark;
    --bg: #111;
    --panel: #1c1c1e;
    --border: #333;
    --text: #eee;
    --muted: #999;
    --accent: #8b7bff;
    --error: #ff6b6b;
}
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: var(--bg); color: var(--text); }
button, input, select { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; }
button { cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
a { color: var(--accent); }
h1 { font-size: 1.4em; margin: 0; }
h2 { font-size: 1.1em; margin: 24px 0 8px; }
[hidden] { display: none !important; }
.card { max-width: 360px; margin: 15vh auto; padding: 24px; background: var(--panel); border-radius: 12px; display: grid; gap: 12px; }
.error { color: var(--error); }
.muted { color: var(--muted); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.row input:not([type=checkbox]) { flex: 1; min-width: 0; }

.host { max-width: 720px; margin: 0 auto; padding: 16px; }
.host ul, .host ol { padding-left: 20px; }
.host li { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0; }
.host li > span { flex: 1; min-width: 160px; }

#player { display: flex; flex-direction: column; min-height: 100vh; }
.stage { position: relative; background: #000; }
video { width: 100%; max-height: 80vh; display: block; }
#player:fullscreen .stage { flex: 1; display: flex; }
#player:fullscreen video { max-height: none; }
#tap { position: absolute; inset: 0; margin: auto; width: max-content; height: max-content; font-size: 1.3em; padding: 12px 24px; }
#status { position: absolute; left: 12px; top: 8px; margin: 0; color: var(--muted); text-shadow: 0 0 4px #000; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 16px; }
#seek { flex: 1; min-width: 140px; padding: 0; }
#time { font-variant-numeric: tabular-nums; color: var(--muted); }
google-cast-launcher { display: inline-block; width: 28px; height: 28px; cursor: pointer; --connected-color: var(--accent); --disconnected-color: var(--text); }
#info { padding: 0 16px; color: var(--muted); }
```

- [ ] **Step 4: Host page** — `web/host.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watchparty Host</title>
<link rel="stylesheet" href="/web/style.css">
</head>
<body>
<main class="host">
    <p id="jfError" class="error"></p>

    <section id="login" class="card" hidden>
        <h1>Watchparty host</h1>
        <form id="loginForm" class="row">
            <input id="password" type="password" placeholder="Host password" required autofocus>
            <button>Log in</button>
        </form>
        <p id="loginError" class="error"></p>
    </section>

    <section id="lobby" hidden>
        <h1>Rooms</h1>
        <ul id="rooms"></ul>
        <button id="newRoom">New room</button>
    </section>

    <section id="manage" hidden>
        <p><a href="/">← Rooms</a></p>
        <p id="status" class="error"></p>
        <div class="row">
            <input id="link" readonly aria-label="Guest link">
            <button id="copy">Copy link</button>
            <a id="open" target="_blank" rel="noopener">Open player</a>
        </div>
        <p><label><input id="guestControl" type="checkbox"> Guests can control playback</label></p>

        <h2>Queue</h2>
        <ol id="queue"></ol>
        <form id="searchForm" class="row">
            <input id="q" placeholder="Search movies, shows, episodes" required>
            <button>Search</button>
        </form>
        <ul id="results"></ul>

        <h2>Native Jellyfin devices</h2>
        <p class="muted">Open the Jellyfin app on the device first, then add it here.</p>
        <ul id="natives"></ul>
        <div class="row">
            <select id="sessions" aria-label="Jellyfin session"></select>
            <button id="refreshSessions" aria-label="Refresh sessions">↻</button>
            <label><input id="trusted" type="checkbox" checked> My device (always allowed to control)</label>
            <button id="addNative">Add</button>
        </div>

        <h2>Connected</h2>
        <p id="viewers"></p>
    </section>
</main>
<script type="module" src="/web/host.js"></script>
</body>
</html>
```

- [ ] **Step 5: Host logic** — `web/host.js`

```js
import { connectRoom } from './ws.js'

const $ = (id) => document.getElementById(id)
const roomId = new URLSearchParams(location.search).get('room')
let socket = null

async function api(path, init) {
    const res = await fetch(path, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
        throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    return body
}

const postJson = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
const command = (cmd) => socket.send({ type: 'cmd', cmd })

function li(text, ...children) {
    const item = document.createElement('li')
    const span = document.createElement('span')
    span.textContent = text
    item.append(span, ...children)
    return item
}

function button(label, onClick, disabled = false) {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = onClick
    b.disabled = disabled
    return b
}

$('loginForm').onsubmit = async (event) => {
    event.preventDefault()
    try {
        await postJson('/api/login', { password: $('password').value })
        location.reload()
    } catch (err) {
        $('loginError').textContent = err.message
    }
}

async function start() {
    const me = await api('/api/me')
    $('jfError').textContent = me.jellyfinError ?? ''
    if (!me.host) {
        $('login').hidden = false
        return
    }
    const rooms = await api('/api/rooms')
    if (roomId && rooms.some(r => r.id === roomId)) {
        manage()
    } else {
        lobby(rooms)
    }
}

function lobby(rooms) {
    $('lobby').hidden = false
    $('rooms').replaceChildren(...rooms.map((r) => {
        const a = document.createElement('a')
        a.href = `/?room=${r.id}`
        a.textContent = `${r.title} (${r.viewers} connected)`
        const item = document.createElement('li')
        item.append(a)
        return item
    }))
    $('newRoom').onclick = async () => {
        const { id } = await api('/api/rooms', { method: 'POST' })
        location.search = `?room=${id}`
    }
}

function manage() {
    $('manage').hidden = false
    const url = `${location.origin}/r/${roomId}`
    $('link').value = url
    $('open').href = url
    $('copy').onclick = () => navigator.clipboard.writeText(url)

    socket = connectRoom(roomId, 'Host', (msg) => {
        if (msg.type === 'welcome') {
            $('status').textContent = ''
        } else if (msg.type === 'error') {
            $('status').textContent = msg.message
        } else if (msg.type === 'state') {
            render(msg)
        }
    })

    $('guestControl').onchange = () => command({ type: 'setGuestControl', value: $('guestControl').checked })
    $('searchForm').onsubmit = async (event) => {
        event.preventDefault()
        try {
            const items = await api(`/api/search?q=${encodeURIComponent($('q').value)}`)
            $('results').replaceChildren(...items.map(i => li(`${i.name} · ${i.type}`, button('Add', () => socket.send({ type: 'addItem', itemId: i.id })))))
        } catch (err) {
            $('status').textContent = err.message
        }
    }
    $('addNative').onclick = () => {
        const option = $('sessions').selectedOptions[0]
        if (option) {
            socket.send({ type: 'nativeAdd', sessionId: option.value, label: option.textContent, trusted: $('trusted').checked })
        }
    }
    $('refreshSessions').onclick = loadSessions
    loadSessions()
}

async function loadSessions() {
    try {
        const sessions = await api('/api/sessions')
        $('sessions').replaceChildren(...sessions.map(s => new Option(s.label, s.id)))
    } catch (err) {
        $('status').textContent = err.message
    }
}

function render({ room, viewers }) {
    $('guestControl').checked = room.guestControl
    const last = room.queue.length - 1
    $('queue').replaceChildren(...room.queue.map((item, i) => li(
        `${i === room.index ? '▶ ' : ''}${item.name}`,
        button('Play', () => command({ type: 'jump', index: i })),
        button('↑', () => command({ type: 'queueMove', from: i, to: i - 1 }), i === 0),
        button('↓', () => command({ type: 'queueMove', from: i, to: i + 1 }), i === last),
        button('✕', () => command({ type: 'queueRemove', index: i })),
    )))
    $('natives').replaceChildren(...room.nativeSessions.map(n => li(
        `${n.label} — ${n.status}${n.trusted ? ' · my device' : ''}`,
        ...(n.status === 'out-of-sync'
            ? [button('Retry', () => socket.send({ type: 'nativeAdd', sessionId: n.sessionId, label: n.label, trusted: n.trusted }))]
            : []),
        button('Remove', () => socket.send({ type: 'nativeRemove', sessionId: n.sessionId })),
    )))
    $('viewers').textContent = viewers.join(', ') || 'nobody'
}

start().catch((err) => {
    $('jfError').textContent = err.message
})
```

- [ ] **Step 6: Verify manually**

Run: `JELLYFIN_URL=http://<jellyfin-host>:8096 JELLYFIN_API_KEY=<key> HOST_PASSWORD=pw npm start`
Open `http://localhost:8080` and check every acceptance criterion. Also run `npm test` (nothing should regress).

- [ ] **Step 7: Commit**

```bash
git add web/ws.js web/playback.js web/style.css web/host.html web/host.js
git commit -m "## - Add host UI for rooms, queue and native devices"
```

---

### Task 8: Guest player

**Goal:** Guests join by link, enter a name, and watch in sync with custom controls and per-viewer audio, subtitle and quality choice.

**Files:**
- Create: `web/room.html`, `web/room.js`

**Behaviour notes:**
- Custom controls only (no native `controls`), so every play/pause/seek event is a deliberate user command, never confused with sync corrections.
- Sync loop every 1s and on each state message: play/pause to match the room, then `decide()` → seek / playbackRate / none. Skipped while `video.seeking`.
- Text subtitles are a `<track>` pointing at the proxied WebVTT and need no reload. Image subtitles need a burn-in, so selecting one (or leaving one) reloads the stream with `SubtitleStreamIndex`.
- Audio or quality change → new PlaybackInfo + stream reload; sync seeks back to the room position.
- hls.js starts at the room position (`startPosition`), so Jellyfin doesn't transcode from 0 first.
- If autoplay is blocked, a "Tap to start" button appears.

**Acceptance Criteria:**
- [ ] Two browsers in one room stay within ~0.3s; pause/seek/next from one applies to both
- [ ] Guest controls disabled when guest control is off (unless host)
- [ ] Audio, subtitle (text and image) and quality pickers work per viewer
- [ ] Reconnects after a server restart once the host recreates the room; shows status while disconnected
- [ ] Works on iPhone Safari (native HLS fallback, `playsinline`, fullscreen via `webkitEnterFullscreen`)

**Verify:** Manual — host queues an item; open `/r/<id>` in two browsers (one with devtools throttled to "Fast 4G") and a phone; check the criteria.

**Steps:**

- [ ] **Step 1: Player page** — `web/room.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watchparty</title>
<link rel="stylesheet" href="/web/style.css">
<script src="/vendor/hls.min.js"></script>
</head>
<body>
<form id="join" class="card">
    <h1>Join the watch party</h1>
    <input id="name" placeholder="Your name" maxlength="32" required autofocus>
    <button>Join</button>
</form>

<main id="player" hidden>
    <div class="stage">
        <video id="video" playsinline></video>
        <button id="tap" hidden>▶ Tap to start</button>
        <p id="status"></p>
    </div>
    <div class="controls">
        <button id="toggle" aria-label="Play or pause">▶</button>
        <input id="seek" type="range" min="0" max="0" step="1" value="0" aria-label="Seek">
        <span id="time">0:00 / 0:00</span>
        <button id="next" aria-label="Next item">⏭</button>
        <select id="audio" aria-label="Audio track"></select>
        <select id="subs" aria-label="Subtitles"></select>
        <select id="quality" aria-label="Quality">
            <option value="">Original</option>
            <option value="20000000">20 Mbps</option>
            <option value="8000000">8 Mbps</option>
            <option value="4000000">4 Mbps</option>
            <option value="1500000">1.5 Mbps</option>
        </select>
        <button id="fullscreen" aria-label="Fullscreen">⛶</button>
    </div>
    <p id="info"></p>
</main>
<script type="module" src="/web/room.js"></script>
</body>
</html>
```

- [ ] **Step 2: Player logic** — `web/room.js`

```js
import { connectRoom } from './ws.js'
import { decide, targetPosition } from './sync.js'
import { deviceProfile, playbackInfo, proxied, subtitlePath, withDevice } from './playback.js'

const $ = (id) => document.getElementById(id)
const video = $('video')
const roomId = location.pathname.split('/')[2]
const prefs = { audio: null, subs: null, bitrate: null } // per viewer; audio/subs reset per item

let socket = null
let cast = null       // set up in Task 9
let state = null      // last 'state' message
let isHost = false
let current = null    // { itemId, source } of the loaded stream; source null while loading
let loadToken = 0
let hls = null
let dragging = false

function recall(key) {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function store(key, value) {
    try {
        localStorage.setItem(key, value)
    } catch {
        // private mode: not remembered, still works
    }
}

const deviceId = recall('wp_device') ?? (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2))
store('wp_device', deviceId)

$('name').value = recall('wp_name') ?? ''
$('join').onsubmit = (event) => {
    event.preventDefault()
    const name = $('name').value.trim()
    store('wp_name', name)
    $('join').hidden = true
    $('player').hidden = false
    socket = connectRoom(roomId, name, onMessage)
    setInterval(syncNow, 1000)
}

function onMessage(msg) {
    if (msg.type === 'welcome') {
        isHost = msg.isHost
        $('status').textContent = ''
        return
    }
    if (msg.type === 'error') {
        $('status').textContent = msg.message
        return
    }
    if (msg.type !== 'state') {
        return
    }
    state = msg
    const item = state.room.queue[state.room.index]
    if (item && current?.itemId !== item.id) {
        prefs.audio = null
        prefs.subs = null
        load(item.id)
    }
    render()
    syncNow()
}

// --- loading streams ---

const findSub = (source, index) => source?.MediaStreams.find(m => m.Type === 'Subtitle' && m.Index === index)
const isImageSub = (source, index) => Boolean(findSub(source, index) && !findSub(source, index).IsTextSubtitleStream)

function subtitleParam() {
    if (prefs.subs === null) {
        return null // let Jellyfin pick its default
    }
    return isImageSub(current?.source, prefs.subs) ? prefs.subs : -1 // text subs are drawn by the browser
}

function currentTarget() {
    const item = state.room.queue[state.room.index]
    return Math.min(targetPosition(state.room, socket.serverNow()), item?.runtime || Infinity)
}

async function load(itemId) {
    const token = ++loadToken
    const subs = subtitleParam()
    current = { itemId, source: null }
    $('status').textContent = 'Loading…'
    try {
        const source = await playbackInfo(roomId, itemId, deviceProfile(video), { deviceId, audio: prefs.audio, subs, bitrate: prefs.bitrate })
        if (token !== loadToken) {
            return
        }
        current = { itemId, source }
        prefs.audio ??= source.DefaultAudioStreamIndex ?? null
        prefs.subs ??= source.DefaultSubtitleStreamIndex ?? -1
        attach(proxied(roomId, withDevice(source.TranscodingUrl, deviceId)))
        showSubtitles()
        fillPickers()
        $('status').textContent = ''
    } catch (err) {
        if (token !== loadToken) {
            return
        }
        $('status').textContent = `${err.message} – retrying…`
        setTimeout(() => {
            if (token === loadToken) {
                load(itemId)
            }
        }, 5000)
    }
}

// ponytail: the old Jellyfin transcode isn't stopped on reload; Jellyfin kills idle HLS jobs itself
function attach(src) {
    hls?.destroy()
    hls = null
    if (window.Hls?.isSupported()) {
        hls = new Hls({ startPosition: currentTarget() })
        hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) {
                return
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError()
            } else {
                $('status').textContent = 'Stream error – reloading…'
                setTimeout(() => load(current.itemId), 3000)
            }
        })
        hls.loadSource(src)
        hls.attachMedia(video)
    } else {
        video.src = src // iPhone Safari: native HLS
    }
}

function showSubtitles() {
    for (const track of video.querySelectorAll('track')) {
        track.remove()
    }
    const { itemId, source } = current
    const stream = findSub(source, prefs.subs)
    if (!stream?.IsTextSubtitleStream) {
        return
    }
    const track = document.createElement('track')
    track.kind = 'subtitles'
    track.label = stream.DisplayTitle
    track.src = proxied(roomId, subtitlePath(itemId, source.Id, stream.Index))
    track.default = true
    video.append(track)
    track.track.mode = 'showing'
}

function fill(select, options, selected) {
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value, false, value === selected)))
}

function fillPickers() {
    const streams = current.source.MediaStreams
    fill($('audio'), streams.filter(m => m.Type === 'Audio').map(m => [m.Index, m.DisplayTitle]), prefs.audio)
    fill($('subs'), [
        [-1, 'No subtitles'],
        ...streams.filter(m => m.Type === 'Subtitle').map(m => [m.Index, m.DisplayTitle + (m.IsTextSubtitleStream ? '' : ' (burned in)')]),
    ], prefs.subs)
}

$('audio').onchange = () => {
    prefs.audio = Number($('audio').value)
    load(current.itemId)
}
$('subs').onchange = () => {
    const previous = prefs.subs
    prefs.subs = Number($('subs').value)
    if (isImageSub(current.source, previous) || isImageSub(current.source, prefs.subs)) {
        load(current.itemId)
    } else {
        showSubtitles()
    }
}
$('quality').onchange = () => {
    prefs.bitrate = Number($('quality').value) || null
    load(current.itemId)
}

// --- controls ---

const command = (cmd) => socket.send({ type: 'cmd', cmd })

$('toggle').onclick = () => command({ type: state.room.playing ? 'pause' : 'play' })
$('next').onclick = () => command({ type: 'next' })
$('seek').oninput = () => {
    dragging = true
}
$('seek').onchange = () => {
    dragging = false
    command({ type: 'seek', position: Number($('seek').value) })
}
$('tap').onclick = () => {
    $('tap').hidden = true
    video.play().catch(() => {})
}
$('fullscreen').onclick = () => {
    if (document.fullscreenElement) {
        document.exitFullscreen()
    } else if ($('player').requestFullscreen) {
        $('player').requestFullscreen()
    } else {
        video.webkitEnterFullscreen?.()
    }
}
document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON'].includes(event.target.tagName) && !$('toggle').disabled) {
        event.preventDefault()
        $('toggle').click()
    }
})

function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor(s / 60) % 60
    const sec = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

function render() {
    const { room, viewers } = state
    const item = room.queue[room.index]
    const canControl = isHost || room.guestControl
    for (const id of ['toggle', 'seek', 'next']) {
        $(id).disabled = !canControl || !item
    }
    $('toggle').textContent = room.playing ? '⏸' : '▶'
    $('seek').max = String(Math.floor(item?.runtime ?? 0))
    const natives = room.nativeSessions.map(n => `${n.label}${n.status === 'out-of-sync' ? ' (out of sync)' : ''}`)
    $('info').textContent = `${item?.name ?? 'Nothing queued yet'} · Watching: ${[...viewers, ...natives].join(', ')}`
}

// --- sync ---

function syncNow() {
    if (!state) {
        return
    }
    const { room } = state
    const runtime = room.queue[room.index]?.runtime ?? 0
    const target = currentTarget()
    if (!dragging) {
        $('seek').value = String(Math.floor(target))
    }
    $('time').textContent = `${clock(dragging ? Number($('seek').value) : target)} / ${clock(runtime)}`

    if (cast?.active()) {
        if (!video.paused) {
            video.pause()
        }
        cast.sync(target)
        return
    }
    if (!current?.source || video.readyState === 0 || video.seeking) {
        return
    }
    if (room.playing && video.paused) {
        video.play().then(() => { $('tap').hidden = true }).catch(() => { $('tap').hidden = false })
    }
    if (!room.playing && !video.paused) {
        video.pause()
    }
    const d = decide(video.currentTime - target, room.playing)
    if (d.action === 'seek') {
        video.currentTime = target
    }
    video.playbackRate = d.action === 'rate' ? d.rate : 1
}
```

- [ ] **Step 3: Verify manually**

Start the server against your Jellyfin, create a room, queue a movie with multiple audio tracks and both text and PGS subtitles. Check each acceptance criterion. In the Jellyfin dashboard (Activity / Active devices) confirm that a remux shows "Direct stream" or copies video, and that only image subtitles cause a video transcode.

- [ ] **Step 4: Commit**

```bash
git add web/room.html web/room.js
git commit -m "## - Add synced guest player with per-viewer tracks"
```

---

### Task 9: Chromecast

**Goal:** Guests in Chrome can cast to a Chromecast; the page keeps the cast in sync with the room.

**Files:**
- Create: `web/cast.js`
- Modify: `web/room.html`, `web/room.js`

**Acceptance Criteria:**
- [ ] Cast button appears in Chrome (desktop/Android) once a Cast device is on the network
- [ ] Casting plays the current item at the room position, pauses/resumes with the room, seeks on drift > 2s
- [ ] Next item loads on the Chromecast automatically
- [ ] Local video pauses while casting; stopping the cast resumes local sync
- [ ] Default text subtitle shows on the TV

**Verify:** Manual — served over HTTPS (the receiver rejects plain http and self-signed certs); cast from Chrome, compare against a second browser.

**Steps:**

- [ ] **Step 1: Cast sender** — `web/cast.js`

```js
// Chromecast via Google's Default Media Receiver. The sender SDK only exists in Chrome.
import { decide } from './sync.js'
import { deviceProfile, playbackInfo, proxied, subtitlePath, withDevice } from './playback.js'

const COOLDOWN_MS = 3000

export function setupCast({ roomId, deviceId, getState }) {
    const castDevice = `${deviceId}-cast`
    let player = null
    let controller = null
    let loadedItem = null
    let lastAction = 0

    function init() {
        const context = cast.framework.CastContext.getInstance()
        context.setOptions({
            receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
        })
        player = new cast.framework.RemotePlayer()
        controller = new cast.framework.RemotePlayerController(player)
        controller.addEventListener(cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED, () => {
            loadedItem = null
        })
    }

    // the SDK may finish loading before or after this module runs
    if (window.__castAvailable) {
        init()
    } else {
        window.__onGCastApiAvailable = (available) => {
            if (available) {
                init()
            }
        }
    }

    async function load(item, target, playing) {
        const source = await playbackInfo(roomId, item.id, deviceProfile(null, true), { deviceId: castDevice })
        const url = location.origin + proxied(roomId, withDevice(source.TranscodingUrl, castDevice))
        const media = new chrome.cast.media.MediaInfo(url, 'application/x-mpegURL')
        media.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.FMP4
        media.hlsVideoSegmentFormat = chrome.cast.media.HlsVideoSegmentFormat.FMP4
        media.metadata = new chrome.cast.media.GenericMediaMetadata()
        media.metadata.title = item.name

        const subtitles = source.MediaStreams.filter(m => m.Type === 'Subtitle' && m.IsTextSubtitleStream)
        media.tracks = subtitles.map((s) => {
            const track = new chrome.cast.media.Track(s.Index, chrome.cast.media.TrackType.TEXT)
            track.trackContentId = location.origin + proxied(roomId, subtitlePath(item.id, source.Id, s.Index))
            track.trackContentType = 'text/vtt'
            track.subtype = chrome.cast.media.TextTrackType.SUBTITLES
            track.name = s.DisplayTitle
            track.language = s.Language
            return track
        })

        const request = new chrome.cast.media.LoadRequest(media)
        request.currentTime = target
        request.autoplay = playing
        // ponytail: casting uses the item's default subtitle; change tracks from the Google Home app if needed
        if (subtitles.some(s => s.Index === source.DefaultSubtitleStreamIndex)) {
            request.activeTrackIds = [source.DefaultSubtitleStreamIndex]
        }
        await cast.framework.CastContext.getInstance().getCurrentSession().loadMedia(request)
    }

    return {
        active: () => Boolean(player?.isConnected),

        /** Called every second by the player while casting. Seeks only: the Default Receiver has no playback rate. */
        sync(target) {
            const { room } = getState()
            const item = room.queue[room.index]
            if (!item || Date.now() - lastAction < COOLDOWN_MS) {
                return
            }
            if (loadedItem !== item.id) {
                loadedItem = item.id
                lastAction = Date.now()
                load(item, target, room.playing).catch((err) => {
                    console.error('Cast load failed', err)
                    loadedItem = null
                })
                return
            }
            if (!player.isMediaLoaded) {
                return
            }
            if (room.playing === player.isPaused) {
                controller.playOrPause()
                lastAction = Date.now()
                return
            }
            if (decide(player.currentTime - target, room.playing, false).action === 'seek') {
                player.currentTime = target
                controller.seek()
                lastAction = Date.now()
            }
        },
    }
}
```

- [ ] **Step 2: Load the SDK and add the button** — `web/room.html`

In `<head>`, after the hls.js script, add:

```html
<script>window.__onGCastApiAvailable = (available) => { window.__castAvailable = available }</script>
<script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1" async></script>
```

In `.controls`, before the fullscreen button, add:

```html
<google-cast-launcher aria-label="Cast"></google-cast-launcher>
```

- [ ] **Step 3: Wire it into the player** — `web/room.js`

Add the import below the existing imports:

```js
import { setupCast } from './cast.js'
```

In the `$('join').onsubmit` handler, after `socket = connectRoom(roomId, name, onMessage)`, add:

```js
    cast = setupCast({ roomId, deviceId, getState: () => state })
```

`syncNow()` already handles `cast?.active()`.

- [ ] **Step 4: Verify manually**

Deploy behind HTTPS (Task 10) or temporarily expose with a tunnel that has a valid cert. Cast from Chrome; check each acceptance criterion against a second browser in the same room.

- [ ] **Step 5: Commit**

```bash
git add web/cast.js web/room.html web/room.js
git commit -m "## - Add Chromecast support via Default Media Receiver"
```

---

### Task 10: Docker, README and end-to-end check

**Goal:** Deployable container next to Jellyfin, with documented setup and a full manual run-through.

**Files:**
- Create: `Dockerfile`, `docker-compose.example.yml`, `README.md`

**Acceptance Criteria:**
- [ ] `docker build` succeeds; container serves `/api/health`
- [ ] README covers API key creation, env vars, reverse proxy (websocket upgrade + HTTPS), native-device usage
- [ ] Full end-to-end checklist below passes on the real server

**Verify:** `docker build -t watchparty . && docker run --rm -p 8080:8080 -e JELLYFIN_URL=http://host.docker.internal:8096 -e JELLYFIN_API_KEY=x -e HOST_PASSWORD=pw watchparty` then `curl -s localhost:8080/api/health` → `{"ok":true}`

**Steps:**

- [ ] **Step 1: Dockerfile**

```dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY web web
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
```

- [ ] **Step 2: Compose example** — `docker-compose.example.yml`

```yaml
# Put this next to your Jellyfin service, or point JELLYFIN_URL at the Jellyfin host.
services:
  watchparty:
    build: .
    restart: unless-stopped
    environment:
      JELLYFIN_URL: http://jellyfin:8096
      JELLYFIN_API_KEY: change-me
      HOST_PASSWORD: change-me
      PUBLIC_URL: https://watch.example.com
    ports:
      - "8080:8080"
```

- [ ] **Step 3: README** — `README.md`

````markdown
# Watchparty

Watch Jellyfin together. Guests join by link in a browser (or cast to a Chromecast); you can also join from native Jellyfin apps. Everyone stays in sync.

Watchparty never encodes video itself. Guests get whatever Jellyfin would serve them (usually a cheap remux), so Jellyfin stays the only program using the GPU.

## Requirements

* Jellyfin 10.9 or newer
* Node 24 or Docker
* HTTPS with a valid certificate for Chromecast and for guests outside your network

## Setup

1. In Jellyfin: **Dashboard → API Keys → +**, name it `watchparty`.
2. Copy `docker-compose.example.yml` to `docker-compose.yml`, fill in the values, run `docker compose up -d --build`.
3. Put it behind your reverse proxy with websocket upgrade enabled. Caddy example:

   ```
   watch.example.com {
       reverse_proxy watchparty:8080
   }
   ```

   Nginx needs `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.

| Env var | Required | Meaning |
|---|---|---|
| `JELLYFIN_URL` | yes | Internal Jellyfin URL, e.g. `http://jellyfin:8096` |
| `JELLYFIN_API_KEY` | yes | API key from step 1 |
| `HOST_PASSWORD` | yes | Password for the host page |
| `PUBLIC_URL` | no | External URL; `https://` enables the Secure cookie flag |
| `PORT` | no | Default `8080` |

## Using it

1. Open `PUBLIC_URL`, log in, create a room, search and add things to the queue.
2. Share the room link. Guests enter a name and watch.
3. To watch on a TV or phone with the Jellyfin app: open the app on that device (logged in as anyone), then on the host page pick it under **Native Jellyfin devices** and click **Add**. Tick **My device** for your own devices so they can always control playback.
4. **Guests can control playback** decides whether guests (and untrusted native devices) may pause, seek or skip.

Native apps sync to within about 2 seconds (they report their position rarely); browsers within about 0.3 seconds.

## Development

```
npm install
npm test
npm run check
JELLYFIN_URL=http://localhost:8096 JELLYFIN_API_KEY=... HOST_PASSWORD=pw npm start
```
````

- [ ] **Step 4: Build and smoke-test the image**

Run the **Verify** command above.
Expected: `{"ok":true}`; container logs show `Cannot reach Jellyfin` (fake URL) without crashing.

- [ ] **Step 5: End-to-end checklist on the real server**

Deploy with real values behind HTTPS, then in one room:

- [ ] Desktop Chrome + desktop Firefox: play, pause, seek, next stay in sync (< 0.5s visible difference)
- [ ] Phone browser (iPhone Safari if available) joins mid-play and lands at the right spot
- [ ] Chromecast from Chrome follows pause/seek/next
- [ ] Native app (Android TV or Jellyfin Media Player) added from host page: starts the item at the room position, follows pause/seek; pausing on its remote pauses the room
- [ ] Guest control off: guest buttons disabled; untrusted native remote pause is reverted
- [ ] Per-viewer: one guest picks another audio track and PGS subtitles while the other keeps defaults; both stay in sync
- [ ] Jellyfin dashboard during a 4-viewer session: only PGS/incompatible streams transcode; no GPU errors
- [ ] Queue auto-advances at the end of an episode for all clients
- [ ] Kill a guest's network for 30s: it reconnects and resyncs; others never paused

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.example.yml README.md
git commit -m "## - Add Docker image and setup docs"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| Room state, commands, guest-control toggle, queue | 1 |
| Web sync rule (0.3s / 2s, rate 0.95–1.05) | 2, 8 |
| Proxy allowlist, queue check, key never in browser | 3 |
| Playback & transcoding (HLS remux, per-viewer DeviceId, audio/subs/bitrate) | 7 (`playback.js`), 8 |
| Host auth, cookie, rate limit | 4 |
| Native conductor (PlayNow, ~2s threshold, user actions, 3 retries → out-of-sync) | 5 |
| Error handling (buffering, reconnect, 30 min room TTL, Jellyfin down) | 6, 7 (`ws.js`), 8 |
| Queue auto-advance | 1 (`advanceIfEnded`), 6 (ticker) |
| Chromecast (Default Receiver, seek-only, HTTPS) | 9 |
| Configuration env vars | 6, 10 |
| Testing (unit, conductor against fake Jellyfin, proxy, manual) | 1–6, 10 |

Deviation from spec: the conductor integration test uses an injected fake Jellyfin object instead of a fake HTTP server. It covers the same behaviour with less code.
