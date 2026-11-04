// Talking to Jellyfin through the room's proxy.

export const proxied = (roomId, path) => `/r/${roomId}/jf${path}`

/** The most a converted stream may use: keeps the server's upload and every viewer's line comfortable. */
export const MAX_BITRATE = 10_000_000
/** Asks for the file as it is; Jellyfin takes an int32, so not more. */
export const ORIGINAL_BITRATE = 120_000_000

export const subtitlePath = (itemId, sourceId, index) => `/Videos/${itemId}/${sourceId}/Subtitles/${index}/0/Stream.vtt`

/**
 * Tidies converted subtitles: drops a cue's trailing line that is only a number (the next SRT cue's index,
 * left behind when a file lacks the blank line between cues) and ASS override tags such as {\an8}.
 */
export function cleanVtt(text) {
    return text.split(/\r?\n(?:[ \t]*\r?\n)+/).map((block) => {
        const lines = block.split(/\r?\n/)
        const timing = lines.findIndex(line => line.includes('-->'))
        if (timing < 0) {
            return block
        }
        const cue = lines.slice(timing + 1).map(line => line.replace(/\{\\[^}]*\}/g, ''))
        while (cue.length > 1 && /^\s*\d+\s*$/.test(cue.at(-1))) {
            cue.pop()
        }
        return [...lines.slice(0, timing + 1), ...cue].join('\n')
    }).join('\n\n')
}

/** Asks Jellyfin to end the transcode behind a TranscodingUrl; best effort, also while the page unloads. */
export function stopStream(roomId, transcodingUrl) {
    const id = new URL(transcodingUrl, location.origin).searchParams.get('PlaySessionId')
    if (!id) {
        return
    }
    fetch(proxied(roomId, '/Videos/ActiveEncodings?' + new URLSearchParams({ PlaySessionId: id })), { method: 'DELETE', keepalive: true }).catch(() => {})
}

/**
 * Everything is served as HLS so the proxy only needs streaming paths.
 * Video is copied (remux) whenever the browser can decode it; Jellyfin transcodes only what it must.
 * safe: H.264/AAC only: Chromecast Default Receiver, and the fallback after browser media errors.
 */
export function deviceProfile(video, safe = false) {
    const can = (type) => !safe && Boolean(
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
    const textSubs = ['vtt', 'webvtt', 'srt', 'subrip', 'ass', 'ssa', 'mov_text'].map(Format => ({ Format, Method: 'External' }))
    return {
        MaxStreamingBitrate: ORIGINAL_BITRATE, // the PlaybackInfo query sets the real cap
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

/**
 * Returns the media source with a TranscodingUrl. subs: stream index to burn in, -1 for none, null for Jellyfin's default.
 * Jellyfin ignores audio and subtitle choices unless mediaSourceId (the source's Id from an earlier call) names the source.
 */
export async function playbackInfo(roomId, itemId, profile, { deviceId, audio = null, subs = null, bitrate = null, mediaSourceId = null }) {
    const query = new URLSearchParams({
        DeviceId: deviceId,
        MaxStreamingBitrate: String(bitrate ?? MAX_BITRATE),
        EnableDirectPlay: 'false',
        EnableDirectStream: 'false',
        EnableTranscoding: 'true',
        AllowVideoStreamCopy: 'true',
        AllowAudioStreamCopy: 'true',
        AutoOpenLiveStream: 'false',
    })
    if (mediaSourceId) {
        query.set('MediaSourceId', mediaSourceId)
    }
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
