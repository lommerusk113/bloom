# Watchparty — Design

Date: 2026-11-02

## Goal

Watch Jellyfin content together, in sync, across every device: desktop/mobile browsers, Chromecast/TVs, and official Jellyfin native apps.
Guests join via a link without a Jellyfin account.
Replaces Jellyfin SyncPlay (poor client support) and Owncast/neko-rooms (double encoding overloaded the GPU).

## Non-goals (v1)

* Text/voice chat.
* Shared single transcode for the whole room (add only if >4–5 viewers struggle).
* Persistence across restarts.
* Multiple host accounts.

## Constraints

* Server GPU: GTX 1060 6GB. Jellyfin must be the **only** process using the GPU. Watchparty never decodes or encodes video.
* Jellyfin already handles 4 concurrent viewers fine.
* Guests are internet users without Jellyfin accounts; the Jellyfin API key must never reach the browser.

## Architecture

One Node.js/TypeScript service in a Docker container next to Jellyfin.

```
 guests (browser / Chromecast) ──ws + http──▶ watchparty ──http (API key)──▶ Jellyfin ◀── native apps
                                                  │                              ▲
                                                  └──── remote-control API ──────┘
```

### Units

| Unit | Purpose | Depends on |
|---|---|---|
| `room` | In-memory room state + pure state transitions (play, pause, seek, queue advance, permissions) | nothing |
| `sync` (`web/sync.js`) | Pure function: given room state, server time, client position → `none` / `rate(x)` / `seek(p)`; used by the web player and Cast sender | nothing |
| `jellyfin` | Thin client for the Jellyfin HTTP API (items, search, playback info, sessions, remote commands) | Jellyfin |
| `proxy` | Forwards guest HLS/subtitle requests to Jellyfin, injecting the API key, restricted to the room's queue | `jellyfin`, `room` |
| `conductor` | Keeps native Jellyfin sessions in sync via remote control, with its own thresholds | `jellyfin`, `room` |
| `server` | HTTP + websocket wiring, host auth, static files | all of the above |
| `web` | Static player + host UI (hls.js, Cast sender SDK) | `server` |

### Room state

```ts
type Room = {
  id: string                 // random, unguessable (≥128 bits)
  queue: QueueItem[]         // Jellyfin item ids + titles
  index: number              // current queue position
  playing: boolean
  position: number           // seconds, valid at `updatedAt`
  updatedAt: number          // server epoch ms
  guestControl: boolean      // host toggle
  nativeSessions: NativeSession[]
}
```

Current position = `position + (playing ? (now - updatedAt) / 1000 : 0)`.

Room commands: `play`, `pause`, `seek(p)`, `next`, `jump(index)`, `queueAdd/Remove/Move` (host only), `setGuestControl` (host only).
When `guestControl` is false, guest `play/pause/seek/next/jump` are rejected.

## Playback & transcoding

Watchparty does **no** media processing.
Each viewer gets an HLS stream from Jellyfin as its own play session (unique `DeviceId` + `PlaySessionId` per guest).
Direct play is disabled so every stream goes through HLS and the proxy can bind it to the room:

* Remux (video copy) when the browser supports the codec — near-zero cost.
* Audio-only transcode for unsupported audio (DTS, TrueHD) — CPU, cheap.
* Full transcode only when Jellyfin decides it's needed (unsupported video codec, image subtitles burned in, bitrate cap) — NVENC, handled by Jellyfin as today.

Per-viewer choices:

* **Audio track** — passed as `AudioStreamIndex` on the stream request.
* **Subtitles** — text subs delivered as WebVTT sidecar (`/Videos/{id}/{mediaSourceId}/Subtitles/{index}/Stream.vtt`), rendered client-side.
  Image subs (PGS/VobSub) passed as `SubtitleStreamIndex` with burn-in; Jellyfin transcodes for that viewer.
* **Max bitrate** — optional per-viewer `MaxStreamingBitrate`.

Browser capability → Jellyfin `DeviceProfile` built client-side from `MediaSource.isTypeSupported`/`canPlayType` and sent to `PlaybackInfo` (via the proxy).

## Proxy

Routes under `/r/:roomId/jf/*` forward to Jellyfin with the API key added server-side (header, never in URLs returned to the browser).
Allowed paths only:

* `POST /Items/{itemId}/PlaybackInfo`
* `GET /Videos/{itemId}/master.m3u8`, `/Videos/{itemId}/main.m3u8`, segment paths under `/Videos/{itemId}/hls1/...`
* `GET /Videos/{itemId}/{mediaSourceId}/Subtitles/{index}/Stream.vtt`
* `DELETE /Videos/ActiveEncodings` (stop a transcode)

`itemId` must be in that room's queue, otherwise 404.
HLS and stop requests must carry a `PlaySessionId` that a `PlaybackInfo` call in the same room returned, otherwise 403.
A `PlaySessionId` stays usable until it is stopped (or the room is deleted), so a player paused for a long time can resume; each room keeps at most 500, dropping the least recently used.
Each room allows 24 active play sessions: `PlaybackInfo` returns 429 while 24 sessions made an HLS request within the last 120s; idle sessions stop counting, as Jellyfin kills such idle transcodes too.
HLS and stop requests are forwarded with `DeviceId` set to the `PlaySessionId`, since Jellyfin keys transcode jobs on both and a guest-chosen `DeviceId` would start extra jobs.
HLS playlists use relative URLs, so segments naturally come back through the proxy; the proxy strips `api_key`/`ApiKey` query params from playlists and from `PlaybackInfo`'s `TranscodingUrl` and subtitle `DeliveryUrl`s, drops filesystem `Path`s, and removes any remaining literal API key from playlists and `PlaybackInfo` responses (segments and subtitles pass through untouched).
Responses are streamed (no buffering whole segments).

Host-only endpoints (search library, add to queue) call `jellyfin` directly behind host auth.

## Web player

* `hls.js` for HLS; native HLS on Safari/iOS.
* Joins room via websocket after entering a display name.
* Clock sync: ping/pong on connect and every 30s; offset = median of last 5 samples.
* Every 1s (and on every room state change) runs `sync` against its `video.currentTime`:
  * |drift| < 0.3s → nothing (reset `playbackRate` to 1).
  * 0.3s ≤ |drift| ≤ 2s → `playbackRate` 0.95 or 1.05 until within 0.3s.
  * |drift| > 2s → seek.
* Local buffering does **not** pause the room; client catches up after.
* User actions (play/pause/seek/next) are sent as commands; UI reflects server-confirmed state.
* Audio/subtitle/bitrate picker per viewer.
* Host UI: password login, library search, queue editing, guest-control toggle, native session picker with per-session status.

### Chromecast

* Cast sender SDK (Chrome desktop/Android only; not available on iOS Safari).
* Uses the **Default Media Receiver** with the proxied HLS URL and WebVTT tracks — no custom receiver.
* While casting, the page drives the receiver via the Cast `RemotePlayerController` using the same `sync` decisions (seek only; Default Receiver has no playback rate control, so threshold is 2s).
* Requires the service to be reachable over **HTTPS** with a valid certificate (reverse proxy in front).

## Native conductor

Host adds active Jellyfin sessions (from `GET /Sessions`, filtered to sessions with `SupportsRemoteControl`) to a room.

* On add / item change: `POST /Sessions/{id}/Playing?playCommand=PlayNow&itemIds={item}&startPositionTicks={pos}`.
* Polls `GET /Sessions` every 1s. Estimated native position = `PlayState.PositionTicks` + (elapsed since `LastPlaybackCheckIn` if not paused).
* Native clients report progress infrequently (some every ~10s), so native sync uses a looser threshold: seek only if |drift| > 3s, at most once per 10s per session.
* Pause state mismatch → `POST /Sessions/{id}/Playing/Pause` or `/Unpause`.
* Change detection: if a native session's pause state or position jumps (>5s beyond estimate) without a conductor command in the last 5s, treat it as a user action → room command (if `guestControl` allows or the device is trusted; otherwise revert that session).
  Falling behind by up to the time since the last expectation (+2s) counts as buffering, not a user seek.
* Trusted devices (host ticks **My device**) bypass `guestControl`.
* Wrong item playing → re-issue `PlayNow`.
* Command not reflected after 3 attempts, or session missing from 5 consecutive polls → mark `out-of-sync` in host UI, stop commanding it; host can re-add.

Expected native sync precision: ~3s (limited by client progress reporting). Web clients: ~0.3s.

## Queue

* Host builds queue from library search (items, episodes, whole seasons).
* When the room position reaches the item's runtime, the server advances `index`, sets position 0, playing true, broadcasts; conductor sends `PlayNow` to native sessions.
  Clients send no `ended` message; past the last item the room stops at its end.
* Guests may `next`/`jump` only if `guestControl` is on.

## Error handling

| Situation | Behavior |
|---|---|
| Web client buffers | Room continues; client catches up via rate/seek |
| Web client disconnects | Auto-reconnect with backoff; resyncs to room state |
| Room idle (no web clients, no *syncing* native sessions) | Deleted after 30 min |
| Native session ignores commands / goes offline | 3 ignored commands or 5 consecutive polls without the session → `out-of-sync`, flagged to host |
| Jellyfin unreachable / bad API key | Startup check fails loudly in logs; host UI shows error; guests see "server unavailable" |
| Proxy request for item not in queue | 404 |
| Guest command while `guestControl` off | Rejected, client gets current state back |

## Configuration (env vars)

* `JELLYFIN_URL` — internal URL, e.g. `http://jellyfin:8096`
* `JELLYFIN_API_KEY` — admin API key
* `JELLYFIN_USER_ID` — optional; run as this Jellyfin user (needed when PlaybackInfo or remote control fails with only an API key; limits libraries to that user's)
* `HOST_PASSWORD` — host login
* `PUBLIC_URL` — external HTTPS base URL (for links and Cast)
* `PORT` — default 8080

## Security

* API key only server-side.
* Host session via HTTP-only, `SameSite=Strict` cookie after password check; constant-time compare; basic rate limit on login.
* Room ids from `crypto.randomBytes(16)`, base64url.
* Proxy allowlist as above; no library browsing for guests.
* Websocket `Origin` must match the `Host` header or `PUBLIC_URL`'s host.
* Websocket rate limit: 20 messages per second per client; excess dropped; a client over the limit for 5 consecutive seconds is disconnected.
* At most 50 websocket clients per room (further upgrades are refused); a client with over 1 MB of unsent data is disconnected instead of buffering more broadcasts; a `hello` that does not change the name is not broadcast.
* Display names length-limited and escaped.

## Testing

* Unit (`node:test`): `sync` decisions at threshold boundaries, `room` transitions (incl. permission rejects, queue advance, position math), native drift/user-action detection.
* Integration: conductor against a stubbed Jellyfin client (command issued, retries, out-of-sync, user-action detection, seek lead). Proxy allowlist (item in/out of queue).
* Manual: real Jellyfin with 2 desktop browsers, a phone, Chromecast, and one native app (Android TV or Jellyfin Media Player) in one room; verify sync, per-viewer subs/audio, queue advance, guest-control toggle.

## Risks

* Native client progress-report frequency varies; some third-party clients don't support remote control — they simply can't be added.
* Cast Default Receiver can't do smooth rate correction → occasional small seeks while casting.
* Upload bandwidth: each remuxing guest pulls full source bitrate; mitigated by per-viewer max bitrate.
