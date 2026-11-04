import { connectRoom } from './ws.js'
import { adaptLead, decide, joinLead, nextBackoff, targetPosition } from './sync.js'
import { cleanVtt, deviceProfile, MAX_BITRATE, ORIGINAL_BITRATE, playbackInfo, proxied, stopStream, subtitlePath } from './playback.js'
import { setupCast } from './cast.js'

const $ = (id) => document.getElementById(id)
const video = $('video')
const roomId = location.pathname.split('/')[2]
/** Inside the room settings page's small player: fullscreen and "back" act on that page's frame. */
const frame = window.frameElement
const screenDoc = frame ? parent.document : document
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
let myId = ''         // this connection's id: finds our own ballot in a vote
let personal = false // loading for this viewer alone (joining, own audio/subtitle/quality pick): don't hold the room
let loadedOnce = false
let catchUp = null    // { at, lead }: loading ahead of the room alone; starts playing when the room reaches `at`
let speedMbps = null  // measured download speed from the server
let speedTest = Promise.resolve()
let autoLimit = Infinity // bps ceiling for Auto, lowered a tier each time playback keeps stalling
let stalls = []       // times playback froze mid-stream, for lowering Auto
let lastTime = -1     // currentTime at the previous sync tick
let wasFrozen = false
let streamPlayed = false // the attached stream has played: freezes after this are stalls, not its startup
let segments = { itemId: null, list: [] } // intro/credits ranges of the playing item

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
    const here = location.hash === '#here' // "Watch here" was clicked
    history.replaceState(null, '', location.pathname + location.search)
    if (frame && !here && await playingElsewhere()) {
        standBy() // the small player on the settings page never takes over from a real player tab
        return
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
    tabs?.postMessage('claim')
    speedTest = measureSpeed()
    cast = setupCast({ roomId, deviceId, getState: () => state })
    setInterval(syncNow, 1000)
}

// --- one player per browser: two would play over each other and pull two streams ---

const tabs = 'BroadcastChannel' in window ? new BroadcastChannel(`bloom-room-${roomId}`) : null
let standingBy = false
if (tabs) {
    tabs.onmessage = ({ data }) => {
        if (data === 'who' && socket && !standingBy) {
            tabs.postMessage('here')
        } else if (data === 'claim' && socket && !standingBy) {
            socket.close() // the newest player wins
            state = null
            unloadStream()
            standBy()
        }
    }
}

/** Asks this browser's other tabs whether one already plays this room. */
function playingElsewhere() {
    if (!tabs) {
        return Promise.resolve(false)
    }
    return new Promise((resolve) => {
        const listen = ({ data }) => data === 'here' && resolve(true)
        tabs.addEventListener('message', listen)
        tabs.postMessage('who')
        setTimeout(() => {
            tabs.removeEventListener('message', listen)
            resolve(false)
        }, 300)
    })
}

function standBy() {
    standingBy = true
    $('join').hidden = true
    $('player').hidden = false
    $('elsewhere').hidden = false
}
$('watchHere').onclick = () => {
    location.hash = 'here'
    location.reload()
}

function onMessage(msg) {
    if (msg.type === 'welcome') {
        isHost = msg.isHost
        myId = msg.id
        reportedBuffering = false // a new connection starts out not buffering on the server
        if (speedMbps !== null) {
            socket.send({ type: 'speed', value: speedMbps })
        }
        $('manage').hidden = !isHost || (frame && !screenDoc.fullscreenElement)
        $('manage').href = `/?room=${roomId}`
        $('status').textContent = ''
        return
    }
    if (msg.type === 'reaction') {
        showReaction(msg.emoji, msg.name)
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
    if (msg.type === 'gone' || msg.type === 'kicked') {
        state = null // syncNow stops driving the player and Chromecast
        cast?.stop()
        unloadStream()
        $('manage').hidden = true
        for (const id of CONTROLS) {
            $(id).disabled = true // their handlers read state
        }
        $('status').textContent = msg.type === 'kicked' ? 'The host removed you from the room' : 'This room no longer exists'
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
        nudgeSubtitles(-subOffset) // timing fixes are per file
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
            const lead = joinLead(Math.min(source.Bitrate || 8e6, bitrate()), (speedMbps ?? 10) * 1e6)
            catchUp = { at: currentTarget() + lead, lead }
        }
        prefs.audio ??= source.DefaultAudioStreamIndex ?? null
        prefs.subs ??= source.DefaultSubtitleStreamIndex ?? -1
        attach(proxied(roomId, source.TranscodingUrl + (maxHeight() ? `&MaxHeight=${maxHeight()}` : '')))
        showSubtitles()
        fillPickers()
        offerOriginal()
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
    streamPlayed = false
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
        URL.revokeObjectURL(track.src)
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
    const token = loadToken
    fetch(proxied(roomId, subtitlePath(itemId, source.Id, stream.Index))).then(res => res.ok ? res.text() : Promise.reject()).then((text) => {
        if (token !== loadToken || prefs.subs !== stream.Index) {
            return // another stream or subtitle was picked meanwhile
        }
        clearSubtitles()
        const track = document.createElement('track')
        track.kind = 'subtitles'
        track.label = stream.DisplayTitle
        track.src = URL.createObjectURL(new Blob([cleanVtt(text)], { type: 'text/vtt' }))
        track.default = true
        video.append(track)
        track.track.mode = 'showing'
        track.addEventListener('load', () => shiftCues(track.track, subOffset))
    }).catch(() => {})
}

// --- subtitle timing: per viewer, for subtitles that run a little early or late ---

let subOffset = 0

function shiftCues(textTrack, seconds) {
    for (const cue of textTrack?.cues ?? []) {
        // move the far edge first so a cue never ends before it starts
        if (seconds > 0) {
            cue.endTime += seconds
            cue.startTime += seconds
        } else {
            cue.startTime = Math.max(0, cue.startTime + seconds)
            cue.endTime = Math.max(cue.startTime, cue.endTime + seconds)
        }
    }
}

function nudgeSubtitles(seconds) {
    subOffset = Math.round((subOffset + seconds) * 10) / 10
    shiftCues(video.querySelector('track')?.track, seconds)
    $('subOffset').textContent = `${subOffset > 0 ? '+' : ''}${subOffset.toFixed(1)}s`
}
$('subEarlier').onclick = () => nudgeSubtitles(-0.5)
$('subLater').onclick = () => nudgeSubtitles(0.5)

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
if (!$('quality').value) {
    $('quality').value = 'auto' // a choice from an older list
}
$('quality').onchange = () => {
    store('wp_quality', $('quality').value)
    autoLimit = Infinity
    if (current) {
        reloadAlone()
    }
}

/** Reloads the stream for this viewer's own setting, re-measuring their speed first. */
function reloadAlone() {
    speedTest = measureSpeed()
    load(current.itemId, true)
}

/** The fixed qualities, best first, as "bitrate:height". */
const TIERS = [...$('quality').options].map(o => o.value).filter(v => /^\d+:\d+$/.test(v))
const tierBitrate = (tier) => Number(tier.split(':')[0])

/**
 * Auto: the best tier within half the measured speed (Wi-Fi swings well below a speed test) and below autoLimit.
 * Snapping to tiers keeps viewers on the same few streams.
 */
function autoTier() {
    const budget = Math.min(speedMbps === null ? MAX_BITRATE : speedMbps * 500_000, autoLimit)
    return TIERS.find(t => tierBitrate(t) <= budget) ?? TIERS.at(-1)
}

/** The stream this viewer gets: "original" or a tier. */
function quality() {
    const picked = $('quality').value
    if (picked === 'original') {
        return speedMbps !== null && fastEnough(current?.source ?? current?.last) ? 'original' : autoTier() // a new item is tried as is
    }
    return picked === 'auto' ? autoTier() : picked
}

/** Max bitrate to ask Jellyfin for. */
const bitrate = () => (quality() === 'original' ? ORIGINAL_BITRATE : tierBitrate(quality()))

/** The quality's resolution, e.g. 720; null for the original. */
const maxHeight = () => Number(quality().split(':')[1]) || null

/** Whether the viewer's connection carries the item's original file, with the same headroom Auto keeps. Unknown item: yes. */
function fastEnough(source) {
    return !source?.Bitrate || (speedMbps !== null && speedMbps * 500_000 >= source.Bitrate)
}

/** Original is only offered when the connection can carry it; shows what it needs otherwise. */
function offerOriginal() {
    const source = current?.source ?? current?.last
    const ok = speedMbps !== null && fastEnough(source)
    $('original').disabled = !ok
    $('original').textContent = ok || !source?.Bitrate ? 'Original file (best quality)'
        : `Original file (best quality) – needs ${Math.ceil(source.Bitrate / 500_000)} Mbps`
    if (!ok && $('quality').value === 'original') {
        $('quality').value = 'auto'
        if (current?.source && current.source.Bitrate > bitrate()) {
            load(current.itemId, true) // this item's file is too big for the connection
        }
    }
}

/** Times a download from the server for up to 5s; reports the speed to the room for the admin dashboard. */
async function measureSpeed() {
    try {
        const started = performance.now()
        const res = await fetch(`/r/${roomId}/speedtest`, { cache: 'no-store' })
        const reader = res.body.getReader()
        let bytes = 0
        while (performance.now() - started < 5000) {
            const { done, value } = await reader.read()
            if (done) {
                break
            }
            bytes += value.length
        }
        reader.cancel().catch(() => {})
        speedMbps = Math.round((bytes * 8) / ((performance.now() - started) / 1000) / 100_000) / 10
        socket.send({ type: 'speed', value: speedMbps })
        $('speed').textContent = `Your connection: ${speedMbps} Mbps · Auto picks ${$('quality').querySelector(`option[value="${autoTier()}"]`).textContent}`
        offerOriginal()
    } catch {
        $('speed').textContent = '' // unknown speed: Auto plays MAX_BITRATE
        offerOriginal()
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
    if (screenDoc.fullscreenElement) {
        screenDoc.exitFullscreen()
    } else if (frame?.requestFullscreen) {
        frame.requestFullscreen()
    } else if ($('player').requestFullscreen) {
        $('player').requestFullscreen()
    } else {
        video.webkitEnterFullscreen?.()
    }
}
if (frame) {
    // the settings page is right behind the fullscreen player: "Room settings" just leaves fullscreen
    $('manage').onclick = (event) => {
        event.preventDefault()
        screenDoc.exitFullscreen()
    }
    screenDoc.addEventListener('fullscreenchange', () => {
        $('manage').hidden = !isHost || !screenDoc.fullscreenElement
    })
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
    renderVote()
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
    $('viewers').replaceChildren(...viewers.map(v => chip(v.name)))
    showMediaSession(room, item)
}

// --- sync ---

/** Three stalls within a minute on Auto: reload alone at 60% of the bitrate it played at. */
function noteStall() {
    const now = Date.now()
    stalls = [...stalls.filter(at => now - at < 60_000), now]
    if (stalls.length < 3 || !['auto', 'original'].includes($('quality').value) || !current?.source) {
        return
    }
    stalls = []
    const playedAt = Math.min(bitrate(), current.source.Bitrate || MAX_BITRATE)
    $('quality').value = 'auto' // the original file didn't keep up either
    const lower = TIERS.find(t => tierBitrate(t) < playedAt)
    if (!lower) {
        return // already the lowest
    }
    autoLimit = tierBitrate(lower)
    $('speed').textContent = `Playback kept stalling: Auto lowered to ${$('quality').querySelector(`option[value="${lower}"]`).textContent}`
    load(current.itemId, true)
}

// --- phone lock screen and headset buttons ---

const mediaSession = 'mediaSession' in navigator ? navigator.mediaSession : null
let sessionItem = null

function showMediaSession(room, item) {
    if (!mediaSession) {
        return
    }
    if (item?.id !== sessionItem) {
        sessionItem = item?.id ?? null
        mediaSession.metadata = item
            ? new MediaMetadata({ title: item.name, artist: room.name, artwork: [{ src: `/r/${roomId}/poster?item=${item.id}`, sizes: '320x480', type: 'image/jpeg' }] })
            : null
    }
    mediaSession.playbackState = room.playing ? 'playing' : 'paused'
}

/** Lock-screen buttons send room commands like the on-screen ones, when this viewer may control playback. */
function sessionAction(action, cmd) {
    try {
        mediaSession?.setActionHandler(action, () => {
            if (state && (isHost || state.room.guestControl)) {
                command(cmd())
            }
        })
    } catch {
        // the browser doesn't offer this button
    }
}
sessionAction('play', () => ({ type: 'play' }))
sessionAction('pause', () => ({ type: 'pause' }))
sessionAction('seekbackward', () => ({ type: 'seek', position: Math.max(0, currentTarget() - 10) }))
sessionAction('seekforward', () => ({ type: 'seek', position: currentTarget() + 30 }))
sessionAction('nexttrack', () => ({ type: 'next' }))

function showSessionPosition(position, runtime) {
    try {
        if (runtime > 0) {
            mediaSession?.setPositionState({ duration: runtime, position: Math.min(Math.max(position, 0), runtime), playbackRate: 1 })
        }
    } catch {
        // an older browser without position state
    }
}

// --- up next, votes and reactions ---

const UP_NEXT_S = 15

/** The last seconds of an item: what plays next, with "Play now" and "Pause" for viewers who may control playback. */
function showUpNext(target) {
    const { room } = state
    const item = room.queue[room.index]
    const next = room.queue[room.index + 1]
    const left = (item?.runtime ?? 0) - target
    $('upNext').hidden = !next || !room.playing || !item.runtime || left > UP_NEXT_S || left <= 0
    if ($('upNext').hidden) {
        return
    }
    $('upNextName').textContent = next.name
    $('upNextIn').textContent = `starting in ${Math.ceil(left)}s`
    $('upNextActions').hidden = !(isHost || room.guestControl)
}
$('upNextPlay').onclick = () => command({ type: 'next' })
$('upNextPause').onclick = () => command({ type: 'pause' })

function renderVote() {
    const vote = state.room.vote
    $('vote').hidden = !vote
    if (!vote) {
        return
    }
    const ballots = Object.values(vote.ballots)
    $('voteOptions').replaceChildren(...vote.options.map((option, i) => {
        const pick = document.createElement('button')
        pick.classList.toggle('mine', vote.ballots[myId] === i)
        const count = ballots.filter(b => b === i).length
        const label = document.createElement('span')
        label.textContent = option.name
        const tally = document.createElement('span')
        tally.className = 'count'
        tally.textContent = `${count} vote${count === 1 ? '' : 's'}`
        pick.append(label, tally)
        pick.onclick = () => socket.send({ type: 'vote', option: i })
        return pick
    }))
    showVoteTime()
}

function showVoteTime() {
    const vote = state?.room.vote
    if (vote) {
        $('voteIn').textContent = `${Math.max(0, Math.ceil((vote.endsAt - socket.serverNow()) / 1000))}s left`
    }
}

const REACTIONS = ['😂', '😮', '😍', '👏', '😱', '🔥']
$('reactBar').replaceChildren(...REACTIONS.map((emoji) => {
    const b = document.createElement('button')
    b.textContent = emoji
    b.title = `React ${emoji}`
    b.onclick = () => socket?.send({ type: 'react', emoji })
    return b
}))
$('reactButton').onclick = (event) => {
    event.stopPropagation()
    $('reactBar').hidden = !$('reactBar').hidden
    $('reactButton').setAttribute('aria-expanded', String(!$('reactBar').hidden))
}
$('reactBar').onclick = (event) => event.stopPropagation()
document.addEventListener('click', () => {
    $('reactBar').hidden = true
    $('reactButton').setAttribute('aria-expanded', 'false')
})

/** Floats someone's reaction up the screen, everyone's own included. */
function showReaction(emoji, name) {
    if ($('reactionLayer').childElementCount > 30) {
        return // a flood would only bury the movie
    }
    const bubble = document.createElement('div')
    bubble.className = 'reaction'
    bubble.style.left = `${60 + Math.random() * 30}%`
    const who = document.createElement('small')
    who.textContent = name
    bubble.append(emoji, who)
    bubble.addEventListener('animationend', () => bubble.remove())
    $('reactionLayer').append(bubble)
}

const SKIP_LABELS = { Intro: 'Skip intro', Recap: 'Skip recap', Outro: 'Skip credits', Preview: 'Skip preview' }

/** Shows "Skip intro"/"Skip credits" while the room is inside such a segment, for viewers who may control playback. */
function showSkip(target, local) {
    const { room } = state
    const item = room.queue[room.index]
    if (item && segments.itemId !== item.id) {
        segments = { itemId: item.id, list: [] }
        fetch(`/r/${roomId}/segments`).then(res => res.ok ? res.json() : []).then((list) => {
            if (segments.itemId === item.id) {
                segments.list = list
            }
        }).catch(() => {})
    }
    const segment = segments.list.find(s => target >= s.start && target < s.end - 1)
    const canControl = isHost || room.guestControl
    $('skip').hidden = !segment || !canControl || (!local && !cast?.active()) || !$('upNext').hidden
    if (segment) {
        $('skip').textContent = SKIP_LABELS[segment.type] ?? 'Skip'
        // credits that run to the end: on to the next item instead of the last second of this one
        const toEnd = segment.end >= (item.runtime || Infinity) - 2 && room.index < room.queue.length - 1
        $('skip').onclick = () => command(toEnd ? { type: 'next' } : { type: 'seek', position: segment.end })
    }
}

video.addEventListener('waiting', () => { stalled = true })
video.addEventListener('playing', () => {
    stalled = false
    streamPlayed = true
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
    // readyState and 'waiting' flicker on healthy streams: moving playback is never loading
    const advancing = local && !video.paused && video.currentTime !== lastTime
    const frozen = local && playing && !video.paused && !video.seeking && lastTime >= 0 && video.currentTime === lastTime
    lastTime = local ? video.currentTime : -1
    if (advancing) {
        stalled = false
    }
    if (frozen && !wasFrozen && streamPlayed && Date.now() - lastSeekedAt > 4000) {
        noteStall()
    }
    wasFrozen = frozen
    stalled ||= frozen
    reportBuffering(Boolean(room.queue[room.index]) && !cast?.active() && !advancing && (!local || video.seeking || stalled || video.readyState < 3))
    showUpNext(target)
    showSkip(target, local)
    showVoteTime()
    const waitingFor = state.waitingFor.filter(name => name !== myName)
    $('wait').textContent = room.waiting ? `Waiting for ${waitingFor.join(', ') || 'you'} to load…` : ''
    // the counter shows this player's own position, so it stops while it loads
    const position = local && !video.seeking && !catchUp ? video.currentTime : target
    if (!dragging) {
        $('seek').value = String(Math.floor(position))
    }
    const shown = dragging ? Number($('seek').value) : position
    showSessionPosition(shown, runtime)
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
