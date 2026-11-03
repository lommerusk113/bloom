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
   The container runs read-only with all capabilities dropped; only accounts are written, to the `bloom-data` volume (`/data/users.json`). Rooms live in memory.

| Env var | Required | Meaning |
|---|---|---|
| `JELLYFIN_URL` | yes | Internal Jellyfin URL, e.g. `http://jellyfin:8096` |
| `JELLYFIN_API_KEY` | yes | API key from step 1 |
| `JELLYFIN_USER_ID` | no | Run as this Jellyfin user (default: the first administrator); limits libraries to that user's |
| `ADMIN_PASSWORD` | first start | Password (6+ characters) for the first admin account, username `admin` (`ADMIN_USERNAME` changes it). Only used while no accounts exist; change it afterwards from the account menu |
| `DATA_DIR` | no | Where accounts are stored; `/data` in Docker, `./data` otherwise |
| `PUBLIC_URL` | behind a reverse proxy | External URL; its host is accepted as the websocket Origin and `https://` enables the Secure cookie flag |
| `TMDB_API_KEY` | no | Free key from themoviedb.org (Settings → API); adds “Trending this week” and “Popular right now” rows for titles in your library |
| `PORT` | no | Default `8080` |

## Deploy with Coolify

1. **New resource → Public/Private repository** → this repo, build pack **Docker Compose**, compose file `docker-compose.yml`.
2. Under **Environment Variables**, fill in `JELLYFIN_URL`, `JELLYFIN_API_KEY` and `ADMIN_PASSWORD` (required), and optionally `TMDB_API_KEY` and `JELLYFIN_USER_ID`.
3. Set the domain for the `bloom` service (Coolify fills `SERVICE_FQDN_BLOOM_8080`, which also becomes `PUBLIC_URL`) and deploy.

Behind **Pangolin** (or another proxy outside Coolify) skip the Coolify domain: set `PUBLIC_URL` to the public address and point the proxy at `http://<server-ip>:8765` (`HOST_PORT` changes 8765). In Pangolin turn off authentication for the resource, or guests get a Pangolin login instead of Bloom.

`JELLYFIN_URL` must be reachable from the Bloom container: if Jellyfin runs on the same server outside Coolify, use its public URL or the host's LAN address, not `localhost`.

## Using it

1. Log in as `admin` and open **Admin** to create accounts for the people who should be able to host. The dashboard also shows every open room with who is watching and their connection speed, active streams and Jellyfin's status, and lets you end rooms, disable, reset or delete accounts.
2. Open the external URL, log in, create a room, search and add things to the queue. Each user only sees and controls their own rooms.
3. Share the room link. Guests need no account: they enter a name and watch.
4. Optionally set a **room password** under Invite; guests then enter it before joining (you never need it).
5. **Guests may pause, seek and skip** decides whether guests may control playback; the host always can.
6. In the player the host gets **‹ Room settings** to get back to the queue, invite and **End room**, which stops the room for everyone. Rooms nobody is in are removed after 5 minutes.

Each viewer has their own volume, audio, subtitle and quality. **Find more subtitles…** in the player searches through Jellyfin's subtitle plugins and adds the pick to the item; install the **OpenSubtitles** plugin in Jellyfin (Dashboard → Plugins) for it to find anything.

When someone joins or changes their own setting, Bloom measures their connection and has them load a few seconds ahead of the room (longer on slow connections) instead of pausing everyone; they start playing when the room reaches that point. **Auto** quality caps the stream at 70% of the measured speed.

Browsers sync to within about 0.3 seconds.

Each room allows 24 active streams; a stream that makes no requests for 2 minutes stops counting but can still resume, so long pauses are fine. Each room allows 50 open browser tabs. Each websocket client may send 20 messages per second; extra messages are dropped and a client that keeps flooding for 5 seconds is disconnected.

## Development

```
npm install
npm test
npm run check
JELLYFIN_URL=http://localhost:8096 JELLYFIN_API_KEY=... ADMIN_PASSWORD=change-me npm start
```
