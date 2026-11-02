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
