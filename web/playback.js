// Talking to Jellyfin through the room's proxy.

export const proxied = (roomId, path) => `/r/${roomId}/jf${path}`

export const subtitlePath = (itemId, sourceId, index) => `/Videos/${itemId}/${sourceId}/Subtitles/${index}/0/Stream.vtt`

/** Gives each viewer its own Jellyfin transcode job (all proxied requests share one API key). */
export function withDevice(url, deviceId) {
    const u = new URL(url, location.origin)
    u.searchParams.set('DeviceId', deviceId)
    return u.pathname + u.search
}

/** Asks Jellyfin to end the transcode behind a TranscodingUrl; best effort, also while the page unloads. */
export function stopStream(roomId, transcodingUrl, deviceId) {
    const id = new URL(transcodingUrl, location.origin).searchParams.get('PlaySessionId')
    if (!id) {
        return
    }
    fetch(proxied(roomId, '/Videos/ActiveEncodings?' + new URLSearchParams({ DeviceId: deviceId, PlaySessionId: id })), { method: 'DELETE', keepalive: true }).catch(() => {})
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
