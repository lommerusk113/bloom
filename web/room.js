import { connectRoom } from './ws.js'
import { adaptLead, decide, joinLead, nextBackoff, targetPosition } from './sync.js'
import { deviceProfile, playbackInfo, proxied, stopStream, subtitlePath } from './playback.js'
import { setupCast } from './cast.js'

const $ = (id) => document.getElementById(id)
const video = $('video')
const roomId = location.pathname.split('/')[2]
const prefs = { audio: null, subs: null } // per viewer, reset per item

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
let myName = ''
let personal = false // loading for this viewer alone (joining, own audio/subtitle/quality pick): don't hold the room
let loadedOnce = false
let catchUp = null    // { at, lead }: loading ahead of the room alone; starts playing when the room reaches `at`
let speedMbps = null  // measured download speed from the server
let speedTest = Promise.resolve()

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
fetch(`/api/rooms/${roomId}/access`).then(res => res.json()).then(({ locked, allowed }) => {
    $('password').hidden = !(locked && !allowed)
    $('password').required = locked && !allowed
    if ($('password').hidden && $('name').value) {
        join() // remembered name and no password to type: straight in; "Tap to start" covers blocked autoplay
    }
}).catch(() => {}) // unknown room: the socket reports it as gone

$('join').onsubmit = (event) => {
    event.preventDefault()
    join()
}

async function join() {
    if (socket) {
        return // auto-join and a click can race
    }
    if (!$('password').hidden) {
        const res = await fetch(`/api/rooms/${roomId}/join`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: $('password').value }),
        }).catch(() => null)
        if (!res?.ok) {
            $('joinError').textContent = res?.status === 401 ? 'Wrong password' : 'Could not join, try again'
            return
        }
    }
    if (socket) {
        return
    }
    const name = $('name').value.trim()
    myName = name.slice(0, 32) || 'Guest'
    store('wp_name', name)
    $('join').hidden = true
    $('player').hidden = false
    video.play().catch(() => {}) // user gesture: unlocks later programmatic play() on iOS
    socket = connectRoom(roomId, name, onMessage)
    speedTest = measureSpeed()
    cast = setupCast({ roomId, deviceId, getState: () => state })
    setInterval(syncNow, 1000)
}

function onMessage(msg) {
    if (msg.type === 'welcome') {
        isHost = msg.isHost
        reportedBuffering = false // a new connection starts out not buffering on the server
        if (speedMbps !== null) {
            socket.send({ type: 'speed', value: speedMbps })
        }
        $('manage').hidden = !isHost
        $('manage').href = `/?room=${roomId}`
        $('status').textContent = ''
        return
    }
    if (msg.type === 'error') {
        $('status').textContent = msg.message
        return
    }
    if (msg.type === 'locked') {
        // the host set a password after this page loaded: back to the join form, which now asks for it
        location.reload()
        return
    }
    if (msg.type === 'gone') {
        state = null // syncNow stops driving the player and Chromecast
        cast?.stop()
        unloadStream()
        $('manage').hidden = true
        for (const id of CONTROLS) {
            $(id).disabled = true // their handlers read state
        }
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
        // joining: load ahead alone; a new item: everyone loads from the start and the room waits
        prefs.audio = null
        prefs.subs = null
        load(item.id, !loadedOnce)
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
    clearSubtitles()
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

/** solo: only this viewer reloads (joining, own setting change), so it loads ahead of the room instead of holding it. */
async function load(itemId, solo = false) {
    const token = ++loadToken
    loadedOnce = true
    personal = solo
    catchUp = null
    const subs = subtitleParam()
    if (current?.source) {
        hls?.destroy() // its segment requests would fail once the transcode is stopped
        hls = null
        stopStream(roomId, current.source.TranscodingUrl)
    }
    if (current?.itemId !== itemId) {
        clearSubtitles() // the previous item's subtitles must not show over this one
    }
    current = { itemId, source: null, last: current?.itemId === itemId ? (current.source ?? current.last) : null }
    try {
        const known = current.last // this item's previous source: its Id makes Jellyfin honour the audio/subtitle pick
        await speedTest // its result picks the Auto quality and how far ahead to start
        if (token !== loadToken) {
            return
        }
        const source = await playbackInfo(roomId, itemId, deviceProfile(video, safeItem === itemId), { deviceId, audio: prefs.audio, subs, bitrate: bitrate(), mediaSourceId: known?.Id ?? null })
        if (token !== loadToken) {
            stopStream(roomId, source.TranscodingUrl) // superseded: don't leak its transcode
            return
        }
        current = { itemId, source }
        const room = state?.room
        if (solo && room?.playing && !room.waiting && !cast?.active()) {
            const lead = joinLead(Math.min(source.Bitrate || 8e6, bitrate() ?? Infinity), (speedMbps ?? 10) * 1e6)
            catchUp = { at: currentTarget() + lead, lead }
        }
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
            load(itemId, personal)
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
        load(current.itemId, true) // restored from the back/forward cache: pagehide stopped the stream
    }
})

function attach(src) {
    hls?.destroy()
    hls = null
    pendingSeek = false
    mediaErrors = 0
    if (window.Hls?.isSupported()) {
        const token = loadToken
        hls = new Hls({ startPosition: catchUp?.at ?? currentTarget() })
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
        load(current.itemId, true)
    } else {
        hls.destroy()
        hls = null
        stopStream(roomId, current.source.TranscodingUrl)
        $('status').textContent = 'This video can’t be played in this browser'
    }
}

function clearSubtitles() {
    for (const track of video.querySelectorAll('track')) {
        track.track.mode = 'disabled' // a removed <track> can keep rendering in some browsers
        track.remove()
    }
}

function showSubtitles() {
    clearSubtitles()
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
    if (!current) {
        return // stream unloaded (empty queue or room gone)
    }
    prefs.audio = Number($('audio').value)
    reloadAlone()
}
$('subs').onchange = () => {
    if (!current) {
        return
    }
    const previous = prefs.subs
    prefs.subs = Number($('subs').value)
    const source = current.source ?? current.last
    if (isImageSub(source, previous) || isImageSub(source, prefs.subs)) {
        reloadAlone()
    } else {
        showSubtitles()
    }
}
$('quality').value = recall('wp_quality') ?? 'auto'
$('quality').onchange = () => {
    store('wp_quality', $('quality').value)
    if (current) {
        reloadAlone()
    }
}

/** Reloads the stream for this viewer's own setting, re-measuring their speed first. */
function reloadAlone() {
    speedTest = measureSpeed()
    load(current.itemId, true)
}

/** Max bitrate to ask Jellyfin for: the picked quality, or for Auto 70% of the measured speed. null: the original. */
function bitrate() {
    const picked = $('quality').value
    if (picked !== 'auto') {
        return Number(picked) || null
    }
    // Jellyfin takes an int32: a fast LAN would overflow it
    return speedMbps === null ? null : Math.min(Math.max(1_500_000, Math.round(speedMbps * 700_000)), 120_000_000)
}

/** Times a download from the server for up to 3s; reports the speed to the room for the admin dashboard. */
async function measureSpeed() {
    try {
        const started = performance.now()
        const res = await fetch(`/r/${roomId}/speedtest`, { cache: 'no-store' })
        const reader = res.body.getReader()
        let bytes = 0
        while (performance.now() - started < 3000) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            bytes += value.length
        }
        reader.cancel().catch(() => {})
        speedMbps = Math.round((bytes * 8) / ((performance.now() - started) / 1000) / 100_000) / 10
        socket.send({ type: 'speed', value: speedMbps })
        $('speed').textContent = `Your connection: ${speedMbps} Mbps`
    } catch {
        $('speed').textContent = '' // unknown speed: Auto plays the original
    }
}

// --- controls ---

const command = (cmd) => socket.send({ type: 'cmd', cmd })
const CONTROLS = ['toggle', 'seek', 'next', 'back', 'forward']
const PLAY_ICON = 'M8 5v14l11-7z'
const PAUSE_ICON = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z'

$('toggle').onclick = () => command({ type: state.room.playing ? 'pause' : 'play' })
$('next').onclick = () => command({ type: 'next' })
$('back').onclick = () => command({ type: 'seek', position: Math.max(0, currentTarget() - 10) })
$('forward').onclick = () => command({ type: 'seek', position: currentTarget() + 30 })
$('settingsButton').onclick = (event) => {
    event.stopPropagation()
    $('settings').hidden = !$('settings').hidden
    $('settingsButton').setAttribute('aria-expanded', String(!$('settings').hidden))
}
$('settings').onclick = (event) => event.stopPropagation()
document.addEventListener('click', () => {
    $('settings').hidden = true
    $('settingsButton').setAttribute('aria-expanded', 'false')
})
video.onclick = () => {
    // with a mouse a click toggles like Jellyfin; on touch screens a tap only brings the controls back
    if (matchMedia('(hover: hover)').matches && !$('toggle').disabled) {
        $('toggle').click()
    }
}
video.ondblclick = () => $('fullscreen').click()

// like Jellyfin: the controls fade out while playing and come back on any movement
let idleTimer = 0
function wake() {
    $('player').classList.remove('idle')
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
        if (state?.room.playing && $('settings').hidden && !dragging) {
            $('player').classList.add('idle')
        }
    }, 3000)
}
for (const type of ['mousemove', 'touchstart', 'keydown', 'click']) {
    document.addEventListener(type, wake, { passive: true })
}

// volume is per viewer and remembered
video.volume = Math.min(Math.max(Number(recall('wp_volume') ?? 1) || 0, 0), 1)
const VOLUME_ICON = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z'
const MUTED_ICON = 'M16.5 12A4.5 4.5 0 0 0 14 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z'
function showVolume() {
    const silent = video.muted || video.volume === 0
    $('volume').value = String(video.muted ? 0 : video.volume)
    $('volume').style.setProperty('--pct', `${(video.muted ? 0 : video.volume) * 100}%`)
    $('mute').querySelector('path').setAttribute('d', silent ? MUTED_ICON : VOLUME_ICON)
}
video.addEventListener('volumechange', showVolume)
showVolume()
$('volume').oninput = () => {
    video.volume = Number($('volume').value)
    video.muted = video.volume === 0
    store('wp_volume', String(video.volume))
}
$('mute').onclick = () => {
    if (video.volume === 0) {
        video.volume = 1
    }
    video.muted = !video.muted
}

// --- more subtitles, through Jellyfin's subtitle plugins (OpenSubtitles) ---

const LANGUAGES = { eng: 'English', nor: 'Norwegian', swe: 'Swedish', dan: 'Danish', fin: 'Finnish', ger: 'German', fre: 'French', spa: 'Spanish', ita: 'Italian', dut: 'Dutch', por: 'Portuguese', pol: 'Polish', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese' }
const BROWSER_LANGUAGES = { en: 'eng', nb: 'nor', nn: 'nor', no: 'nor', sv: 'swe', da: 'dan', fi: 'fin', de: 'ger', fr: 'fre', es: 'spa', it: 'ita', nl: 'dut', pt: 'por', pl: 'pol', ja: 'jpn', ko: 'kor', zh: 'chi' }
fill($('subLang'), Object.entries(LANGUAGES), recall('wp_sub_lang') ?? BROWSER_LANGUAGES[navigator.language.slice(0, 2)] ?? 'eng')
$('findSubs').onclick = () => {
    $('subSearch').hidden = !$('subSearch').hidden
}
$('subSearch').onsubmit = async (event) => {
    event.preventDefault()
    const lang = $('subLang').value
    store('wp_sub_lang', lang)
    $('subResults').replaceChildren(new Option('Searching…'))
    const res = await fetch(`/r/${roomId}/subtitles?lang=${lang}`).catch(() => null)
    const found = res?.ok ? await res.json() : null
    if (!found?.length) {
        const why = found ? 'Nothing found.' : 'Search failed.'
        $('subResults').replaceChildren(listItem(`${why} Subtitle search needs the OpenSubtitles plugin in Jellyfin.`))
        return
    }
    $('subResults').replaceChildren(...found.slice(0, 30).map((sub) => {
        const pick = document.createElement('button')
        pick.className = 'sub-result'
        pick.textContent = sub.name
        pick.title = `${sub.provider} · ${sub.format} · ${sub.downloads} downloads${sub.exact ? ' · exact match' : ''}`
        pick.onclick = () => downloadSubtitle(sub, pick)
        return listItem('', pick)
    }))
}

function listItem(text, ...children) {
    const li = document.createElement('li')
    li.textContent = text
    li.append(...children)
    return li
}

async function downloadSubtitle(sub, pick) {
    pick.disabled = true
    pick.textContent = 'Downloading…'
    const res = await fetch(`/r/${roomId}/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: sub.id }) }).catch(() => null)
    const body = await res?.json().catch(() => ({}))
    if (!res?.ok || !current) {
        pick.textContent = body?.error ?? 'Download failed'
        return
    }
    pick.textContent = `✓ ${sub.name}`
    $('subSearch').hidden = true
    prefs.subs = body.index // the stream list only shows it after a reload
    reloadAlone()
}
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
    for (const id of CONTROLS) {
        $(id).disabled = !canControl || !item
    }
    $('toggle').querySelector('path').setAttribute('d', room.playing ? PAUSE_ICON : PLAY_ICON)
    $('seek').max = String(Math.floor(item?.runtime ?? 0))
    $('title').textContent = item?.name ?? 'Waiting for the host to pick something…'
    document.title = `${room.name} · Bloom`
    $('lock').hidden = canControl
    const chip = (text, title = '') => {
        const span = document.createElement('span')
        span.className = 'chip'
        span.textContent = text
        span.title = title
        return span
    }
    $('viewers').replaceChildren(...viewers.map(v => chip(v)))
}

// --- sync ---

video.addEventListener('waiting', () => { stalled = true })
video.addEventListener('playing', () => {
    stalled = false
    personal = false
    retry = { itemId: null, delay: 0 } // the stream works: the next failure starts the backoff over
})
video.addEventListener('canplay', () => {
    stalled = false
    personal = false
})
video.addEventListener('error', () => {
    if (!hls && current?.source) { // native HLS: hls.js reports its own errors
        const code = video.error?.code
        const mediaError = code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        if (mediaError && safeItem !== current.itemId) {
            safeItem = current.itemId
            load(current.itemId, true)
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

let reportedBuffering = false

/** Tells the room this player is loading, so it waits instead of running ahead. */
function reportBuffering(loading) {
    $('spinner').hidden = !loading
    const buffering = loading && !personal && !catchUp
    if (buffering !== reportedBuffering) {
        reportedBuffering = buffering
        socket.send({ type: 'buffering', value: buffering })
    }
}

function syncNow() {
    if (!state) {
        return
    }
    const { room } = state
    const playing = room.playing && !room.waiting
    const runtime = room.queue[room.index]?.runtime ?? 0
    const target = currentTarget()
    const local = !cast?.active() && current?.source && video.readyState > 0
    reportBuffering(Boolean(room.queue[room.index]) && !cast?.active() && (!local || video.seeking || stalled || video.readyState < 3))
    const waitingFor = state.waitingFor.filter(name => name !== myName)
    $('wait').textContent = room.waiting ? `Waiting for ${waitingFor.join(', ') || 'you'} to load…` : ''
    // the counter shows this player's own position, so it stops while it loads
    const position = local && !video.seeking && !catchUp ? video.currentTime : target
    if (!dragging) {
        $('seek').value = String(Math.floor(position))
    }
    const shown = dragging ? Number($('seek').value) : position
    $('elapsed').textContent = clock(shown)
    $('duration').textContent = clock(runtime)
    $('seek').style.setProperty('--pct', `${runtime ? Math.min(100, (shown / runtime) * 100) : 0}%`)

    if (cast?.active()) {
        if (!video.paused) {
            video.pause()
        }
        cast.sync(target)
        return
    }
    if (catchUp && waitForRoom(playing, target)) {
        return
    }
    if (!current?.source || video.readyState === 0 || video.seeking) {
        return
    }
    if (playing && video.paused && !video.ended) {
        video.play().then(() => { $('tap').hidden = true }).catch(() => { $('tap').hidden = false })
    }
    if (!playing && !video.paused) {
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
    const d = decide(drift, playing)
    if (d.action === 'seek') {
        if (Date.now() - lastSeekedAt < 4000) {
            return // let the last seek settle before judging it
        }
        const far = playing && !isBuffered(target) // buffered seeks land instantly: no lead, nothing to learn
        video.currentTime = Math.min(target + (far ? seekLead : 0), runtime || Infinity)
        pendingSeek = far
    }
    video.playbackRate = d.action === 'rate' ? d.rate : 1
}

/**
 * While loading ahead alone: hold paused at catchUp.at until the room gets there; true while still holding.
 * Not loaded in time: aim further ahead. The room paused or seeked back: plain sync again.
 */
function waitForRoom(playing, target) {
    const ready = current?.source && video.readyState >= 3 && !video.seeking
    if (!playing || target < catchUp.at - catchUp.lead - 5) {
        catchUp = null
        return false
    }
    if (target >= catchUp.at) {
        if (ready) {
            catchUp = null
            return false
        }
        catchUp.lead = Math.min(catchUp.lead * 1.5, 60)
        catchUp.at = target + catchUp.lead
    }
    $('wait').textContent = `Joining in ${Math.ceil(catchUp.at - target)}s…`
    if (!video.paused) {
        video.pause()
    }
    if (current?.source && video.readyState > 0 && !video.seeking && Math.abs(video.currentTime - catchUp.at) > 1) {
        video.currentTime = catchUp.at
    }
    return true
}
