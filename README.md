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
   The container runs read-only with all capabilities dropped; only login sessions, open rooms, the watchlist and watch history are written, to the `bloom-data` volume (`/data/*.json`), so rooms survive redeploys.

| Env var | Required | Meaning |
|---|---|---|
| `JELLYFIN_URL` | yes | Internal Jellyfin URL, e.g. `http://jellyfin:8096` |
| `JELLYFIN_API_KEY` | yes | API key from step 1 |
| `JELLYFIN_USER_ID` | no | Run as this Jellyfin user (default: the first administrator); limits libraries to that user's |
| `DATA_DIR` | no | Where login sessions are stored; `/data` in Docker, `./data` otherwise |
| `PUBLIC_URL` | recommended | External URL, e.g. `https://watch.example.com`; used in Discord links (otherwise the address hosts sign in on), its host is accepted as the websocket Origin and `https://` enables the Secure cookie flag |
| `TMDB_API_KEY` | no | Free key from themoviedb.org (Settings → API); adds “Trending this week” and “Popular right now” rows for titles in your library |
| `GIPHY_API_KEY` | no | Free key from developers.giphy.com (Create an App → API); adds GIF search to the chat |
| `DISCORD_WEBHOOK_URL` | no | A Discord channel webhook (Channel settings → Integrations → Webhooks); hosts can then announce their room there |
| `PORT` | no | Default `8080` |

## Deploy with Coolify

1. **New resource → Public/Private repository** → this repo, build pack **Docker Compose**, compose file `docker-compose.yml`.
2. Under **Environment Variables**, fill in `JELLYFIN_URL` and `JELLYFIN_API_KEY` (required), and optionally `TMDB_API_KEY`, `GIPHY_API_KEY`, `DISCORD_WEBHOOK_URL` and `JELLYFIN_USER_ID`.
3. Set the domain for the `bloom` service (Coolify fills `SERVICE_FQDN_BLOOM_8080`, which also becomes `PUBLIC_URL`) and deploy.

Behind **Pangolin** (or another proxy outside Coolify) skip the Coolify domain: set `PUBLIC_URL` to the public address and point the proxy at `http://<server-ip>:8765` (`HOST_PORT` changes 8765). In Pangolin turn off authentication for the resource, or guests get a Pangolin login instead of Bloom.

`JELLYFIN_URL` must be reachable from the Bloom container: if Jellyfin runs on the same server outside Coolify, use its public URL or the host's LAN address, not `localhost`.

## Using it

1. Log in with your Jellyfin username and password. Any enabled Jellyfin user can host; users are managed in Jellyfin, and disabling one there logs them out of Bloom and ends their rooms within 30 seconds. The host's watch progress is saved to their Jellyfin account (resume points and watched status); guests' isn't. Jellyfin administrators get **Admin**: every open room with who is watching and their connection speed, active streams, Jellyfin's status and users, and ending rooms.
2. Press **Start room**, now or scheduled for later, to get the invite link and password (each host has one room at a time). Search and add things to the queue; each host only sees the libraries their Jellyfin account can. Nobody else can manage it. **Movie nights** lists every scheduled room for all signed-in hosts, with a calendar file; only the owner gets a link in.
3. Share the room's invite link. Guests need no account: they enter a name and watch. The link's key renews every 24 hours (the old one keeps working for an hour), so old links stop letting new people in; guests already in stay in. Guests suggest titles from TMDB's catalogue, so a link never reveals what the library holds.
4. Every room has a **password** under Invite; guests enter it once, besides opening the link (you never need it). Your first room gets one like `otter-maple-42`; change it and Bloom remembers yours for your next rooms. Share it separately from the link.
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
JELLYFIN_URL=http://localhost:8096 JELLYFIN_API_KEY=... npm start
```
