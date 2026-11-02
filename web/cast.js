// Chromecast via Google's Default Media Receiver. The sender SDK only exists in Chrome.
import { adaptLead, decide, nextBackoff } from './sync.js'
import { deviceProfile, playbackInfo, proxied, stopStream, subtitlePath } from './playback.js'

const COOLDOWN_MS = 3000
const SEEK_COOLDOWN_MS = 8000 // a seek can restart the transcode; give it time to land
const MAX_RETRY_MS = 30_000 // Cast backoff starts at COOLDOWN_MS (one timer gates every Cast action); the web player uses 5s-60s

export function setupCast({ roomId, deviceId, getState }) {
    const castDevice = `${deviceId}-cast`
    let player = null
    let controller = null
    let loadedItem = null
    let lastAction = 0
    let lastSeek = 0
    let seekLead = 3
    let pendingSeek = false
    let retryDelay = 0 // grows while loads keep failing
    let loading = false
    let loadToken = 0 // a newer load makes the older one's callbacks no-ops
    let transcodingUrl = null // of the loaded cast source, to stop its transcode

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
            retryDelay = 0
            loadToken++ // an in-flight load belongs to the old session
            loading = false
            if (!player.isConnected) {
                stopTranscode()
            }
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

    function stopTranscode() {
        if (transcodingUrl) {
            stopStream(roomId, transcodingUrl)
            transcodingUrl = null
        }
    }

    async function load(token, item, target, playing) {
        stopTranscode()
        const source = await playbackInfo(roomId, item.id, deviceProfile(null, true), { deviceId: castDevice })
        if (token !== loadToken) {
            stopStream(roomId, source.TranscodingUrl) // superseded: don't leak its transcode
            return
        }
        transcodingUrl = source.TranscodingUrl
        const url = location.origin + proxied(roomId, source.TranscodingUrl)
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
            if (!item || loading || Date.now() - lastAction < (retryDelay || COOLDOWN_MS)) {
                return
            }
            if (loadedItem !== item.id) {
                loadedItem = item.id
                lastAction = Date.now()
                pendingSeek = false
                loading = true
                const token = ++loadToken
                load(token, item, target, room.playing).then(() => {
                    if (token !== loadToken) {
                        return
                    }
                    loading = false
                    lastAction = Date.now()
                }, (err) => {
                    if (token !== loadToken) {
                        return
                    }
                    console.error('Cast load failed', err)
                    loading = false
                    loadedItem = null
                    retryDelay = nextBackoff(retryDelay, COOLDOWN_MS, MAX_RETRY_MS) // 3s, 6s ... 30s
                    lastAction = Date.now()
                })
                return
            }
            if (!player.isMediaLoaded) {
                const finished = item.runtime > 0 && target >= item.runtime - 3 // end of queue: the receiver went idle
                if (!finished && Date.now() - lastAction > 3 * COOLDOWN_MS) {
                    // the receiver dropped the media (error, stopped from Google Home): load it again
                    loadedItem = null
                    retryDelay = nextBackoff(retryDelay, COOLDOWN_MS, MAX_RETRY_MS)
                    lastAction = Date.now()
                }
                return
            }
            retryDelay = 0
            if (room.playing === player.isPaused) {
                // explicit play/pause: playOrPause() toggles and can double-flip while RemotePlayer state lags
                const media = cast.framework.CastContext.getInstance().getCurrentSession()?.getMediaSession()
                if (room.playing) {
                    media?.play(new chrome.cast.media.PlayRequest(), () => {}, console.error)
                } else {
                    media?.pause(new chrome.cast.media.PauseRequest(), () => {}, console.error)
                }
                lastAction = Date.now()
                return
            }
            if (Date.now() - lastSeek < SEEK_COOLDOWN_MS) {
                return
            }
            const drift = player.currentTime - target
            if (pendingSeek && !player.isPaused) {
                seekLead = adaptLead(seekLead, drift)
                pendingSeek = false
            }
            if (decide(drift, room.playing, false).action === 'seek') {
                player.currentTime = Math.min(target + (room.playing ? seekLead : 0), item.runtime || Infinity)
                controller.seek()
                lastAction = lastSeek = Date.now()
                pendingSeek = room.playing
            }
        },
    }
}
