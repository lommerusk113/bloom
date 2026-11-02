<img src="web/logo.svg" alt="" width="72">

# Bloom

*A group of jellyfish is called a bloom.*

Watch Jellyfin together. Guests join by link in a browser (or cast to a Chromecast). Everyone stays in sync.

Bloom never encodes video itself. Every guest gets an HLS stream from Jellyfin (a cheap remux when the browser supports the codecs, a transcode otherwise), so Jellyfin stays the only program using the GPU.

## Requirements

* Jellyfin 10.9 or newer
* Node 24 or Docker
* HTTPS with a valid certificate for Chromecast and for guests outside your network

## Setup

1. In Jellyfin: **Dashboard → API Keys → +**, name it `bloom`.
2. Copy `docker-compose.example.yml` to `docker-compose.yml`, fill in the values, run `docker compose up -d --build`.
3. Put it behind your reverse proxy with websocket upgrade enabled. Caddy example:

   ```
   watch.example.com {
       reverse_proxy bloom:8080
   }
   ```

   Nginx needs `proxy_http_version 1.1; proxy_set_header Host $host; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`.

   The example compose file publishes port 8080 on `127.0.0.1` only, so it is reachable from a reverse proxy on the same host (`localhost:8080`) or on the same Docker network (`bloom:8080`), never directly from outside.
   The container runs read-only with all capabilities dropped; Bloom keeps everything in memory.

| Env var | Required | Meaning |
|---|---|---|
| `JELLYFIN_URL` | yes | Internal Jellyfin URL, e.g. `http://jellyfin:8096` |
| `JELLYFIN_API_KEY` | yes | API key from step 1 |
| `JELLYFIN_USER_ID` | no | Run as this Jellyfin user (default: the first administrator); limits libraries to that user's |
| `HOST_PASSWORD` | yes | Password for the host page |
| `PUBLIC_URL` | behind a reverse proxy | External URL; its host is accepted as the websocket Origin and `https://` enables the Secure cookie flag |
| `TMDB_API_KEY` | no | Free key from themoviedb.org (Settings → API); adds “Trending this week” and “Popular right now” rows for titles in your library |
| `PORT` | no | Default `8080` |

## Using it

1. Open the external URL, log in, create a room, search and add things to the queue.
2. Share the room link. Guests enter a name and watch.
3. Optionally set a **room password** under Invite people; guests then enter it before joining (you never need it).
4. **Guests may pause, seek and skip** decides whether guests may control playback; the host always can.
5. **End room** (host page, or the player page when logged in as host) stops it for everyone: guests are disconnected and the room's transcodes stop. Rooms nobody is watching are also removed after 30 minutes.

Browsers sync to within about 0.3 seconds.

Each room allows 24 active streams; a stream that makes no requests for 2 minutes stops counting but can still resume, so long pauses are fine. Each room allows 50 open browser tabs. Each websocket client may send 20 messages per second; extra messages are dropped and a client that keeps flooding for 5 seconds is disconnected.

## Development

```
npm install
npm test
npm run check
JELLYFIN_URL=http://localhost:8096 JELLYFIN_API_KEY=... HOST_PASSWORD=pw npm start
```
