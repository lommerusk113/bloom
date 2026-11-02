import { connectRoom } from './ws.js'
import { decide, targetPosition } from './sync.js'
import { deviceProfile, playbackInfo, proxied, subtitlePath, withDevice } from './playback.js'

const $ = (id) => document.getElementById(id)
const video = $('video')
const roomId = location.pathname.split('/')[2]
const prefs = { audio: null, subs: null, bitrate: null } // per viewer; audio/subs reset per item

let socket = null
let cast = null       // set up in Task 9
let state = null      // last 'state' message
let isHost = false
let current = null    // { itemId, source } of the loaded stream; source null while loading
let loadToken = 0
let hls = null
let dragging = false

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
    socket = connectRoom(roomId, name, onMessage)
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
    if (msg.type !== 'state') {
        return
    }
    state = msg
    const item = state.room.queue[state.room.index]
    if (item && current?.itemId !== item.id) {
        prefs.audio = null
        prefs.subs = null
        load(item.id)
    }
    render()
    syncNow()
}

// --- loading streams ---

const findSub = (source, index) => source?.MediaStreams.find(m => m.Type === 'Subtitle' && m.Index === index)
const isImageSub = (source, index) => Boolean(findSub(source, index) && !findSub(source, index).IsTextSubtitleStream)

function subtitleParam() {
    if (prefs.subs === null) {
        return null // let Jellyfin pick its default
    }
    return isImageSub(current?.source, prefs.subs) ? prefs.subs : -1 // text subs are drawn by the browser
}

function currentTarget() {
    const item = state.room.queue[state.room.index]
    return Math.min(targetPosition(state.room, socket.serverNow()), item?.runtime || Infinity)
}

async function load(itemId) {
    const token = ++loadToken
    const subs = subtitleParam()
    current = { itemId, source: null }
    $('status').textContent = 'Loading…'
    try {
        const source = await playbackInfo(roomId, itemId, deviceProfile(video), { deviceId, audio: prefs.audio, subs, bitrate: prefs.bitrate })
        if (token !== loadToken) {
            return
        }
        current = { itemId, source }
        prefs.audio ??= source.DefaultAudioStreamIndex ?? null
        prefs.subs ??= source.DefaultSubtitleStreamIndex ?? -1
        attach(proxied(roomId, withDevice(source.TranscodingUrl, deviceId)))
        showSubtitles()
        fillPickers()
        $('status').textContent = ''
    } catch (err) {
        if (token !== loadToken) {
            return
        }
        $('status').textContent = `${err.message} – retrying…`
        setTimeout(() => {
            if (token === loadToken) {
                load(itemId)
            }
        }, 5000)
    }
}

// ponytail: the old Jellyfin transcode isn't stopped on reload; Jellyfin kills idle HLS jobs itself
function attach(src) {
    hls?.destroy()
    hls = null
    if (window.Hls?.isSupported()) {
        hls = new Hls({ startPosition: currentTarget() })
        hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) {
                return
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                hls.recoverMediaError()
            } else {
                $('status').textContent = 'Stream error – reloading…'
                setTimeout(() => load(current.itemId), 3000)
            }
        })
        hls.loadSource(src)
        hls.attachMedia(video)
    } else {
        video.src = src // iPhone Safari: native HLS
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
    if (isImageSub(current.source, previous) || isImageSub(current.source, prefs.subs)) {
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
    if (room.playing && video.paused) {
        video.play().then(() => { $('tap').hidden = true }).catch(() => { $('tap').hidden = false })
    }
    if (!room.playing && !video.paused) {
        video.pause()
    }
    const d = decide(video.currentTime - target, room.playing)
    if (d.action === 'seek') {
        video.currentTime = target
    }
    video.playbackRate = d.action === 'rate' ? d.rate : 1
}
