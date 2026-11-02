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
| `JELLYFIN_USER_ID` | no | Run as this Jellyfin user; set if PlaybackInfo or remote control fails with only an API key; also limits libraries to that user's |
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
