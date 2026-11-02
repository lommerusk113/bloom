import { connectRoom } from './ws.js'
import { adaptLead, decide, nextBackoff, targetPosition } from './sync.js'
import { deviceProfile, playbackInfo, proxied, stopStream, subtitlePath } from './playback.js'
import { setupCast } from './cast.js'

const $ = (id) => document.getElementById(id)
const video = $('video')
const roomId = location.pathname.split('/')[2]
const prefs = { audio: null, subs: null, bitrate: null } // per viewer; audio/subs reset per item

let socket = null
let cast = null
let state = null      // last 'state' message
let isHost = false
let current = null    // { itemId, source, last } of the loaded stream; source null while loading, last is the item's previous source
let loadToken = 0
let retry = { itemId: null, delay: 0 } // backoff for consecutive load failures of one item
let hls = null
let mediaErrors = 0     // fatal hls.js media errors of the attached source
let safeItem = null     // item reloaded with the H.264/AAC profile after media errors persisted
let dragging = false
let seekLead = 1        // seconds to seek past the target, learned from how far behind seeks land
let pendingSeek = false // a seek while playing whose landing drift hasn't been measured yet
let lastSeekedAt = 0
let stalled = false     // buffering: currentTime frozen while not seeking

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
    video.play().catch(() => {}) // user gesture: unlocks later programmatic play() on iOS
    socket = connectRoom(roomId, name, onMessage)
    cast = setupCast({ roomId, deviceId, getState: () => state })
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
    if (msg.type === 'gone') {
        unloadStream()
        $('status').textContent = 'This room no longer exists'
        return
    }
    if (msg.type !== 'state') {
        return
    }
    state = msg
    const item = state.room.queue[state.room.index]
    if (!item && current) {
        // queue emptied: drop the removed item's stream before the proxy starts refusing it
        unloadStream()
        $('status').textContent = ''
    }
    if (item && current?.itemId !== item.id) {
        prefs.audio = null
        prefs.subs = null
        load(item.id)
    }
    render()
    syncNow()
}

// --- loading streams ---

function unloadStream() {
    loadToken++ // cancels pending retries and in-flight loads
    hls?.destroy()
    hls = null
    if (current?.source) {
        stopStream(roomId, current.source.TranscodingUrl)
    }
    video.removeAttribute('src')
    video.load()
    current = null
}

const findSub = (source, index) => source?.MediaStreams.find(m => m.Type === 'Subtitle' && m.Index === index)
const isImageSub = (source, index) => Boolean(findSub(source, index) && !findSub(source, index).IsTextSubtitleStream)

function subtitleParam() {
    if (prefs.subs === null) {
        return null // let Jellyfin pick its default
    }
    return isImageSub(current?.source ?? current?.last, prefs.subs) ? prefs.subs : -1 // text subs are drawn by the browser
}

function currentTarget() {
    const item = state.room.queue[state.room.index]
    return Math.min(targetPosition(state.room, socket.serverNow()), item?.runtime || Infinity)
}

async function load(itemId) {
    const token = ++loadToken
    const subs = subtitleParam()
    if (current?.source) {
        hls?.destroy() // its segment requests would fail once the transcode is stopped
        hls = null
        stopStream(roomId, current.source.TranscodingUrl)
    }
    current = { itemId, source: null, last: current?.itemId === itemId ? (current.source ?? current.last) : null }
    $('status').textContent = 'Loading…'
    try {
        const source = await playbackInfo(roomId, itemId, deviceProfile(video, safeItem === itemId), { deviceId, audio: prefs.audio, subs, bitrate: prefs.bitrate })
        if (token !== loadToken) {
            stopStream(roomId, source.TranscodingUrl) // superseded: don't leak its transcode
            return
        }
        current = { itemId, source }
        prefs.audio ??= source.DefaultAudioStreamIndex ?? null
        prefs.subs ??= source.DefaultSubtitleStreamIndex ?? -1
        attach(proxied(roomId, source.TranscodingUrl))
        showSubtitles()
        fillPickers()
        $('status').textContent = ''
    } catch (err) {
        if (token === loadToken) {
            retryLoad(token, itemId, err.message)
        }
    }
}

/** Reloads itemId after a backoff unless another load starts first. */
function retryLoad(token, itemId, message) {
    if (retry.itemId !== itemId) {
        retry = { itemId, delay: 0 }
    }
    const delay = retry.delay = nextBackoff(retry.delay, 5000, 60_000)
    $('status').textContent = `${message} – retrying in ${delay / 1000}s…`
    setTimeout(() => {
        if (token === loadToken) {
            load(itemId)
        }
    }, delay)
}

addEventListener('pagehide', () => {
    if (current?.source) {
        stopStream(roomId, current.source.TranscodingUrl)
    }
})
addEventListener('pageshow', (event) => {
    if (event.persisted && current) {
        load(current.itemId) // restored from the back/forward cache: pagehide stopped the stream
    }
})

function attach(src) {
    hls?.destroy()
    hls = null
    pendingSeek = false
    mediaErrors = 0
    if (window.Hls?.isSupported()) {
        const token = loadToken
        hls = new Hls({ startPosition: currentTarget() })
        hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal || token !== loadToken) {
                return
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                recoverMedia()
            } else {
                retryLoad(++loadToken, current.itemId, 'Stream error') // new token: later errors of this hls are ignored
            }
        })
        hls.loadSource(src)
        hls.attachMedia(video)
    } else {
        video.src = src // iPhone Safari: native HLS
    }
}

// escalates: recover, swap audio codec and recover, reload as H.264/AAC, give up
function recoverMedia() {
    mediaErrors++
    if (mediaErrors === 1) {
        hls.recoverMediaError()
    } else if (mediaErrors === 2) {
        hls.swapAudioCodec()
        hls.recoverMediaError()
    } else if (safeItem !== current.itemId) {
        safeItem = current.itemId
        load(current.itemId)
    } else {
        hls.destroy()
        hls = null
        stopStream(roomId, current.source.TranscodingUrl)
        $('status').textContent = 'This video can’t be played in this browser'
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
    const source = current.source ?? current.last
    if (isImageSub(source, previous) || isImageSub(source, prefs.subs)) {
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

video.addEventListener('waiting', () => { stalled = true })
video.addEventListener('playing', () => {
    stalled = false
    retry = { itemId: null, delay: 0 } // the stream works: the next failure starts the backoff over
})
video.addEventListener('canplay', () => { stalled = false })
video.addEventListener('error', () => {
    if (!hls && current?.source) { // native HLS: hls.js reports its own errors
        const code = video.error?.code
        const mediaError = code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        if (mediaError && safeItem !== current.itemId) {
            safeItem = current.itemId
            load(current.itemId)
        } else if (mediaError) {
            stopStream(roomId, current.source.TranscodingUrl)
            $('status').textContent = 'This video can’t be played in this browser'
        } else {
            retryLoad(++loadToken, current.itemId, 'Stream error')
        }
    }
})
video.addEventListener('seeked', () => { lastSeekedAt = Date.now() })

function isBuffered(time) {
    for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= time && time <= video.buffered.end(i)) {
            return true
        }
    }
    return false
}

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
    if (room.playing && video.paused && !video.ended) {
        video.play().then(() => { $('tap').hidden = true }).catch(() => { $('tap').hidden = false })
    }
    if (!room.playing && !video.paused) {
        video.pause()
    }
    if (stalled) {
        return // drift grows while buffering; seeking now would only restart the transcode
    }
    const drift = video.currentTime - target
    if (pendingSeek && !video.seeking && !video.paused) {
        seekLead = adaptLead(seekLead, drift)
        pendingSeek = false
    }
    const d = decide(drift, room.playing)
    if (d.action === 'seek') {
        if (Date.now() - lastSeekedAt < 4000) {
            return // let the last seek settle before judging it
        }
        const far = room.playing && !isBuffered(target) // buffered seeks land instantly: no lead, nothing to learn
        video.currentTime = Math.min(target + (far ? seekLead : 0), runtime || Infinity)
        pendingSeek = far
    }
    video.playbackRate = d.action === 'rate' ? d.rate : 1
}
