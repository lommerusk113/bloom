import { connectRoom } from './ws.js'
import { targetPosition } from './sync.js'

const $ = (id) => document.getElementById(id)
const roomId = new URLSearchParams(location.search).get('room')
let socket = null
let state = null

async function api(path, init) {
    const res = await fetch(path, init)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
        throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    return body
}

const postJson = (path, data) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
const command = (cmd) => socket.send({ type: 'cmd', cmd })

function showStatus(text, error = true) {
    $('status').textContent = text
    $('status').classList.toggle('error', error)
    $('status').hidden = !text
}

function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) {
        node.className = className
    }
    if (text !== undefined) {
        node.textContent = text
    }
    return node
}

function li(text, ...children) {
    const item = el('li')
    item.append(el('span', 'grow', text), ...children)
    return item
}

function button(label, onClick, { disabled = false, className = '', title = '' } = {}) {
    const b = el('button', className, label)
    b.onclick = onClick
    b.disabled = disabled
    if (title) {
        b.title = title
    }
    return b
}

function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor(s / 60) % 60
    const sec = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

$('loginForm').onsubmit = async (event) => {
    event.preventDefault()
    try {
        await postJson('/api/login', { username: $('username').value, password: $('password').value })
        location.reload()
    } catch (err) {
        $('loginError').textContent = err.message
    }
}

async function start() {
    const me = await api('/api/me')
    $('jfError').textContent = me.jellyfinError ?? ''
    $('jfError').hidden = !me.jellyfinError
    if (!me.user) {
        $('login').hidden = false
        return
    }
    account(me.user)
    const rooms = await api('/api/rooms')
    const room = rooms.find(r => r.id === roomId)
    if (room) {
        manage(room)
    } else {
        lobby(rooms)
    }
}

function lobby(rooms) {
    $('lobby').hidden = false
    $('noRooms').hidden = rooms.length > 0
    $('rooms').replaceChildren(...rooms.map((r) => {
        const a = el('a', 'grow', r.name)
        a.href = `/?room=${r.id}`
        const item = el('li')
        item.append(a, el('span', 'muted', `${r.viewers} connected`))
        return item
    }))
    $('newRoom').onclick = async () => {
        const { id } = await api('/api/rooms', { method: 'POST' })
        location.search = `?room=${id}`
    }
}

function account(user) {
    try {
        localStorage.setItem('wp_name', localStorage.getItem('wp_name') || user.name) // the small player joins under it
    } catch {
        // private mode: the small player asks for a name
    }
    $('account').textContent = `${user.name} ▾`
    $('adminLink').hidden = !user.admin
    $('logout').onclick = async () => {
        await postJson('/api/logout', {}).catch(() => {})
        location.href = '/'
    }
}

function showPassword(password) {
    $('roomPassword').value = password
    $('savePassword').textContent = password ? 'Change' : 'Set'
    $('passwordNote').textContent = password ? `Guests must enter “${password}”.` : 'Anyone with the link can join.'
}

function manage(room) {
    $('manage').hidden = false
    showPassword(room.password)
    $('passwordForm').onsubmit = async (event) => {
        event.preventDefault()
        const password = $('roomPassword').value.trim()
        try {
            await postJson(`/api/rooms/${roomId}/password`, { password })
            showPassword(password)
        } catch (err) {
            showStatus(err.message)
        }
    }
    const url = `${location.origin}/r/${roomId}`
    $('link').value = url
    $('open').href = url // fallback where an iframe can't go fullscreen (iPhone)
    $('miniPlayer').src = url
    $('open').onclick = (event) => {
        if ($('miniPlayer').requestFullscreen) {
            event.preventDefault()
            $('miniPlayer').requestFullscreen()
        }
    }
    $('copy').onclick = async () => {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(url)
        } else {
            // plain http on a LAN address is not a secure context: no Clipboard API
            $('link').select()
            document.execCommand('copy')
        }
        $('copy').textContent = 'Copied ✓'
        setTimeout(() => { $('copy').textContent = 'Copy' }, 1500)
    }
    $('endRoom').onclick = async () => {
        if (!confirm('End the room for everyone? Guests are disconnected and playback stops.')) {
            return
        }
        try {
            await api(`/api/rooms/${roomId}`, { method: 'DELETE' })
            location.search = ''
        } catch (err) {
            showStatus(err.message)
        }
    }

    socket = connectRoom(roomId, 'Host', (msg) => {
        if (msg.type === 'welcome') {
            showStatus('')
            $('announceRow').hidden = !msg.discord
        } else if (msg.type === 'error') {
            showStatus(msg.message)
        } else if (msg.type === 'gone') {
            state = null
            showStatus('This room no longer exists')
        } else if (msg.type === 'state') {
            state = msg
            render()
        } else if (msg.type === 'log') {
            renderLog(msg.entries)
        }
    }, true)

    $('toggle').onclick = () => command({ type: state.room.playing ? 'pause' : 'play' })
    $('next').onclick = () => command({ type: 'next' })
    $('guestControl').onchange = () => command({ type: 'setGuestControl', value: $('guestControl').checked })
    $('autoContinue').onchange = () => command({ type: 'setAutoContinue', value: $('autoContinue').checked })
    $('autoSkip').onchange = () => command({ type: 'setAutoSkip', value: $('autoSkip').checked })
    $('announce').onchange = () => command({ type: 'setAnnounce', value: $('announce').checked })
    $('scheduleForm').onsubmit = (event) => {
        event.preventDefault()
        if (state?.room.startsAt) {
            command({ type: 'schedule', at: null })
            return
        }
        const at = new Date($('startsAt').value).getTime() // datetime-local is read as local time
        if (!Number.isFinite(at) || at <= Date.now()) {
            showStatus('Pick a time in the future')
            return
        }
        command({ type: 'schedule', at })
    }
    $('searchForm').onsubmit = (event) => {
        event.preventDefault()
        const term = $('q').value
        selectTab(null)
        browse([{ label: `Results for “${term}”`, load: list(`/api/search?q=${encodeURIComponent(term)}`) }])
    }
    setupLibraries()
    setInterval(renderTime, 1000)
}

const addItem = (id) => socket.send({ type: 'addItem', itemId: id })
const list = (path) => async () => {
    const items = await api(path)
    return { items, total: items.length }
}

let views = []

async function setupLibraries() {
    try {
        views = await api('/api/views')
    } catch (err) {
        showStatus(err.message)
    }
    const tabs = [{ id: 'home', name: 'Home' }, ...views]
    $('libraries').replaceChildren(...tabs.map((v) => {
        const b = button(v.name, () => (v.id === 'home' ? home() : openLibrary(v)))
        b.dataset.id = v.id
        return b
    }))
    home()
}

function selectTab(id) {
    for (const b of $('libraries').children) {
        b.classList.toggle('active', b.dataset.id === id)
    }
}

function clearBrowse() {
    browseToken++
    $('hero').hidden = true
    $('crumbs').hidden = true
    $('filters').hidden = true
    $('rows').replaceChildren()
    $('catalogue').replaceChildren()
    $('more').hidden = true
    note('')
}

function shelf(title, load, onTitle) {
    const token = browseToken
    const section = el('section', 'shelf')
    const strip = el('div', 'strip')
    strip.append(el('span', 'muted', 'Loading…'))
    const page = (direction) => strip.scrollBy({ left: direction * strip.clientWidth * 0.9, behavior: 'smooth' })
    const head = el('div', 'shelf-head')
    head.append(
        onTitle ? button(`${title} ›`, onTitle, { className: 'shelf-title' }) : el('h2', 'shelf-title', title),
        button('‹', () => page(-1), { className: 'shelf-arrow', title: 'Scroll left' }),
        button('›', () => page(1), { className: 'shelf-arrow', title: 'Scroll right' }),
    )
    section.append(head, strip)
    load().then((items) => {
        if (token === browseToken) {
            strip.replaceChildren(...(items.length ? items.map(i => card([{ label: 'Home', back: home }], i)) : [el('span', 'muted', 'Nothing here yet')]))
        }
    }, () => strip.replaceChildren(el('span', 'error', 'Could not load')))
    return section
}

/** Trakt-like home: a featured banner, TMDB trending/popular in the library, then each library's new and top rated. */
async function home() {
    selectTab('home')
    clearBrowse()
    const token = browseToken
    const libraryShelves = views.flatMap(v => [
        shelf(`Recently added in ${v.name}`, () => api(`/api/latest?parent=${encodeURIComponent(v.id)}`), () => openLibrary(v)),
        shelf(`Top rated in ${v.name}`, async () => (await api(`/api/library?parent=${encodeURIComponent(v.id)}&sort=rating&start=0`)).items.slice(0, 24), () => openLibrary(v, '', 'rating')),
    ])
    $('rows').replaceChildren(...libraryShelves)
    const discover = await api('/api/discover').catch(() => ({ enabled: false, shelves: [] }))
    if (token !== browseToken) {
        return
    }
    $('rows').prepend(...discover.shelves.filter(s => s.items.length).map(s => shelf(s.title, async () => s.items)))
    const [resume, saved] = await Promise.all([api('/api/resume').catch(() => []), loadWatchlist()])
    if (token !== browseToken) {
        return
    }
    if (saved.length) {
        $('rows').prepend(shelf('Watchlist', async () => saved))
    }
    if (resume.length) {
        $('rows').prepend(shelf('Continue watching', async () => resume))
    }
    const featured = discover.shelves[0]?.items[0] ?? (await api(`/api/latest?parent=${encodeURIComponent(views[0]?.id ?? '')}`).catch(() => []))[0]
    if (featured && token === browseToken) {
        showHero(featured.id, token)
    }
}

async function showHero(id, token) {
    const d = await api(`/api/details?id=${encodeURIComponent(id)}`).catch(() => null)
    if (!d || token !== browseToken) {
        return
    }
    const hero = $('hero')
    hero.style.backgroundImage = d.backdrop ? `url(/api/image?kind=backdrop&id=${encodeURIComponent(d.id)})` : ''
    const info = el('div', 'hero-info')
    info.append(el('div', 'hero-kicker', 'Featured'), el('h1', 'hero-title', d.title), meta(d), el('p', 'hero-overview', d.overview))
    info.append(actions(d))
    hero.replaceChildren(info)
    hero.hidden = false
}

/** Year · runtime · certification · rating line, Trakt style. */
function meta(d) {
    const line = el('div', 'meta')
    const parts = [d.year, d.runtime ? `${Math.round(d.runtime / 60)} min` : '', d.certification].filter(Boolean)
    if (d.rating) {
        line.append(el('span', 'score', `♥ ${Math.round(d.rating * 10)}%`))
    }
    line.append(...parts.map(p => el('span', '', String(p))))
    return line
}

function actions(d) {
    const row = el('div', 'row')
    const show = d.type === 'Series'
    row.append(
        button(show ? '▶ Watch from the start' : '▶ Watch now', () => {
            socket.send({ type: 'addItem', itemId: d.id, playNow: true })
            $('details').close()
            showStatus(`Playing ${d.name}`, false)
        }, { className: 'primary' }),
        button(show ? '+ Add whole show' : '+ Add to queue', (e) => {
            addItem(d.id)
            e.target.textContent = '✓ Added'
        }),
        button(onWatchlist.has(d.id) ? '★ On watchlist' : '☆ Watchlist', async (e) => {
            await toggleWatchlist(d.id)
            e.target.textContent = onWatchlist.has(d.id) ? '★ On watchlist' : '☆ Watchlist'
        }, { title: 'The shared “we should watch this” list' }),
        button('+ Add to vote', (e) => {
            if (!voteDraft.some(o => o.id === d.id) && voteDraft.length < 4) {
                voteDraft.push({ id: d.id, name: d.name })
            }
            e.target.textContent = '✓ In the vote'
            renderVote()
        }, { disabled: voteDraft.length >= 4 && !voteDraft.some(o => o.id === d.id) }),
    )
    return row
}

// --- the shared watchlist and guests' suggestions ---

const onWatchlist = new Set()

async function loadWatchlist() {
    const list = await api('/api/watchlist').catch(() => [])
    onWatchlist.clear()
    list.forEach(e => onWatchlist.add(e.id))
    return list
}

async function toggleWatchlist(id) {
    if (onWatchlist.has(id)) {
        await api(`/api/watchlist/${encodeURIComponent(id)}`, { method: 'DELETE' })
        onWatchlist.delete(id)
    } else {
        await postJson('/api/watchlist', { id })
        onWatchlist.add(id)
    }
}

function renderSuggestions(suggestions) {
    $('suggestPanel').hidden = suggestions.length === 0
    const dismiss = (id) => socket.send({ type: 'dismissSuggestion', itemId: id })
    $('suggestions').replaceChildren(...suggestions.toReversed().map(s => li(`${s.name} · ${s.by}`,
        button('+', () => {
            addItem(s.id)
            dismiss(s.id)
        }, { title: 'Add to the queue', className: 'primary' }),
        button('🗳', () => {
            if (!voteDraft.some(o => o.id === s.id) && voteDraft.length < 4) {
                voteDraft.push({ id: s.id, name: s.name })
            }
            dismiss(s.id)
            renderVote()
        }, { title: 'Add to the vote', disabled: voteDraft.length >= 4 }),
        button('☆', async () => {
            if (!onWatchlist.has(s.id)) {
                await toggleWatchlist(s.id)
            }
            dismiss(s.id)
        }, { title: 'Save to the watchlist' }),
        button('✕', () => dismiss(s.id), { title: 'Dismiss' }),
    )))
}

// --- votes: the host picks 2–4 titles, guests vote in the player, the winner plays next ---

let voteDraft = []

function renderVote() {
    const vote = state?.room.vote
    $('votePanel').hidden = !vote && voteDraft.length === 0
    if (vote) {
        const ballots = Object.values(vote.ballots)
        $('voteList').replaceChildren(...vote.options.map((o, i) => li(`${o.name} · ${ballots.filter(b => b === i).length}`)))
        $('voteNote').textContent = `Voting now · ${Math.max(0, Math.ceil((vote.endsAt - socket.serverNow()) / 1000))}s left · the winner plays next`
        $('voteActions').replaceChildren(
            button('End now', () => socket.send({ type: 'voteEnd' }), { className: 'primary' }),
            button('Cancel', () => socket.send({ type: 'voteCancel' })),
        )
        return
    }
    $('voteList').replaceChildren(...voteDraft.map((o, i) => li(o.name, button('✕', () => {
        voteDraft.splice(i, 1)
        renderVote()
    }, { title: 'Remove from the vote' }))))
    $('voteNote').textContent = voteDraft.length < 2 ? 'Add at least two titles with “+ Add to vote”.' : 'Everyone in the player gets 60 seconds to vote.'
    $('voteActions').replaceChildren(button('Start vote', () => {
        socket.send({ type: 'voteStart', itemIds: voteDraft.map(o => o.id) })
        voteDraft = []
    }, { className: 'primary', disabled: voteDraft.length < 2 }))
}

/** The details popup: backdrop, poster, facts, overview, and seasons with episodes for a show. */
async function showDetails(id) {
    const dialog = $('details')
    dialog.replaceChildren(el('p', 'muted', 'Loading…'))
    dialog.showModal()
    const d = await api(`/api/details?id=${encodeURIComponent(id)}`).catch(() => null)
    if (!d) {
        dialog.replaceChildren(el('p', 'error', 'Could not load details'))
        return
    }
    const close = el('form', 'dialog-close')
    close.method = 'dialog'
    close.append(button('✕', () => {}, { title: 'Close' }))
    const banner = el('div', 'details-banner')
    if (d.backdrop) {
        banner.style.backgroundImage = `url(/api/image?kind=backdrop&id=${encodeURIComponent(d.id)})`
    }
    const poster = el('img', 'details-poster')
    poster.src = `/api/image?id=${encodeURIComponent(d.id)}`
    poster.alt = ''
    poster.onerror = () => poster.remove()
    const body = el('div', 'details-body')
    const text = el('div', 'details-text')
    const genres = el('div', 'chips')
    genres.append(...d.genres.map(g => el('span', 'chip', g)))
    text.append(el('h2', 'details-title', d.type === 'Episode' ? d.name : d.title), meta(d), genres, el('p', '', d.overview || 'No description.'), actions(d))
    body.append(poster, text)
    dialog.replaceChildren(close, banner, body)
    if (d.type === 'Series' || d.type === 'Season') {
        dialog.append(await seasons(d))
    }
}

async function seasons(d) {
    const section = el('div', 'seasons')
    const tabs = el('div', 'chips')
    const episodes = el('ol', 'episodes')
    section.append(tabs, episodes)
    const list = d.type === 'Season' ? [d] : await api(`/api/children?id=${encodeURIComponent(d.id)}`).catch(() => [])
    const open = async (season, tab) => {
        for (const t of tabs.children) {
            t.classList.toggle('active', t === tab)
        }
        episodes.replaceChildren(el('li', 'muted', 'Loading…'))
        const items = await api(`/api/children?id=${encodeURIComponent(season.id)}`).catch(() => [])
        episodes.replaceChildren(
            ...items.map((e) => {
                const row = el('li')
                const thumb = el('img')
                thumb.loading = 'lazy'
                thumb.alt = ''
                thumb.src = `/api/image?id=${encodeURIComponent(e.id)}`
                thumb.onerror = () => thumb.replaceWith(el('span', 'thumb-empty'))
                const label = el('div', 'grow')
                label.append(el('strong', '', e.title), el('div', 'muted', e.subtitle.split(' · ').pop()))
                row.append(thumb, label,
                    button('▶', () => {
                        socket.send({ type: 'addItem', itemId: e.id, playNow: true })
                        $('details').close()
                    }, { title: 'Watch now' }),
                    button('+', (ev) => {
                        addItem(e.id)
                        ev.target.textContent = '✓'
                    }, { className: 'primary', title: 'Add to queue' }))
                return row
            }),
            ...(items.length ? [] : [el('li', 'muted', 'No episodes')]),
        )
        const addSeason = button(`+ Add all of ${season.title}`, (ev) => {
            addItem(season.id)
            ev.target.textContent = '✓ Added'
        }, { className: 'link' })
        const actionsRow = el('li', 'season-actions')
        actionsRow.append(addSeason)
        episodes.prepend(actionsRow)
    }
    list.forEach((season, i) => {
        const tab = button(season.title, () => open(season, tab), { className: 'chip-button' })
        tabs.append(tab)
        if (i === 0) {
            open(season, tab)
        }
    })
    return section
}

/** A library as a poster grid, filtered by genre and sorted. */
async function openLibrary(view, genre = '', sort = $('sort').value) {
    selectTab(view.id)
    const query = (start) => new URLSearchParams({ parent: view.id, genre, sort, start: String(start) })
    browse([{ label: view.name, load: start => api(`/api/library?${query(start)}`), back: () => openLibrary(view, genre, sort) }])
    const token = browseToken
    $('filters').hidden = false
    $('sort').onchange = () => openLibrary(view, genre, $('sort').value)
    const chip = (name, value) => button(name, () => openLibrary(view, value, $('sort').value), { className: `chip-button${value === genre ? ' active' : ''}` })
    view.genres ??= api(`/api/genres?parent=${encodeURIComponent(view.id)}`).catch(() => [])
    const genres = await view.genres
    if (token !== browseToken) {
        return
    }
    $('genres').replaceChildren(chip('All', ''), ...genres.map(g => chip(g, g)))
}

let browseToken = 0

/**
 * Shows the last level of a trail (library/search → show → season) as poster cards; crumbs go back up.
 * level.load(start) resolves to { items, total }; level.addAll is the show or season id the level lists.
 */
async function browse(trail) {
    clearBrowse()
    const token = browseToken // a slower earlier load must not overwrite this one
    const level = trail.at(-1)
    $('crumbs').hidden = trail.length < 2
    $('crumbs').replaceChildren(...trail.flatMap((step, i) => {
        const crumb = i === trail.length - 1 ? el('strong', '', step.label) : button(step.label, () => (step.back ? step.back() : browse(trail.slice(0, i + 1))), { className: 'link' })
        return i ? [el('span', 'muted', ' › '), crumb] : [crumb]
    }), ...(level.addAll ? [button(level.addLabel, (e) => {
        addItem(level.addAll)
        e.target.textContent = '✓ Added'
    }, { className: 'primary push' })] : []))
    note('Loading…')
    await loadPage(trail, level, 0, token)
}

function note(text) {
    $('catalogueNote').textContent = text
    $('catalogueNote').hidden = !text
}

async function loadPage(trail, level, start, token) {
    try {
        const { items, total } = await level.load(start)
        if (token !== browseToken) {
            return
        }
        note(start === 0 && items.length === 0 ? 'Nothing found' : '')
        $('catalogue').append(...items.map(i => card(trail, i)))
        const shown = start + items.length
        $('more').hidden = shown >= total || items.length === 0
        $('more').onclick = () => {
            $('more').hidden = true
            loadPage(trail, level, shown, token)
        }
    } catch (err) {
        if (token === browseToken) {
            note(`Failed: ${err.message}`)
        }
    }
}

function card(trail, i) {
    const playable = i.type === 'Movie' || i.type === 'Episode'
    const tile = el('div', `tile${i.type === 'Episode' ? ' wide' : ''}`)
    tile.tabIndex = 0
    tile.role = 'button'
    tile.title = i.name

    const art = el('div', 'art')
    const img = el('img')
    img.loading = 'lazy'
    img.alt = ''
    img.src = `/api/image?id=${encodeURIComponent(i.id)}`
    img.onerror = () => {
        img.remove()
        art.append(el('span', 'placeholder', i.title))
    }
    art.append(img)
    if (i.rating) {
        art.append(el('span', 'rating', `♥ ${Math.round(i.rating * 10)}%`))
    }
    if (i.progress) {
        const bar = el('span', 'progress')
        bar.style.width = `${i.progress}%`
        art.append(bar)
    }
    const quick = button('+', (event) => {
        event.stopPropagation()
        addItem(i.id)
        quick.textContent = '✓'
        tile.classList.add('added')
    }, { className: 'badge', title: playable ? 'Add to queue' : 'Add every episode to the queue' })
    art.append(quick)
    tile.append(art, el('span', 'tile-title', i.title), el('span', 'tile-sub', i.subtitle))

    tile.onclick = () => showDetails(i.id)
    tile.onkeydown = (event) => {
        if (event.key === 'Enter') {
            showDetails(i.id)
        }
    }
    return tile
}

/** A time as datetime-local's value, in this browser's time zone. */
function toLocalInput(ms) {
    const d = new Date(ms)
    return new Date(ms - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function renderSchedule() {
    const at = state?.room.startsAt
    $('scheduleNote').textContent = at
        ? `Starts ${new Date(at).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · in ${until(at - socket.serverNow())}. Guests who open the link see a countdown, and the room stays open until then.`
        : 'Optional: pick a start time and the room starts playing by itself.'
}

function until(ms) {
    const minutes = Math.max(0, Math.ceil(ms / 60_000))
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor(minutes / 60) % 24
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function renderTime() {
    renderSchedule()
    if (state?.room.vote) {
        renderVote() // its countdown
    }
    const item = state?.room.queue[state.room.index]
    if (!item) {
        $('nowTime').textContent = 'Click a poster to add it'
        return
    }
    const position = Math.min(targetPosition(state.room, socket.serverNow()), item.runtime || Infinity)
    const mode = state.room.waiting ? `Waiting for ${state.waitingFor.join(', ')}` : state.room.playing ? 'Playing' : 'Paused'
    $('nowTime').textContent = `${mode} · ${clock(position)} / ${clock(item.runtime)}`
}

function render() {
    const { room, viewers } = state
    renderVote()
    const item = room.queue[room.index]
    $('guestControl').checked = room.guestControl
    $('autoContinue').checked = room.autoContinue
    $('autoSkip').checked = room.autoSkip
    $('announce').checked = room.announce
    renderSuggestions(room.suggestions)
    $('startsAt').disabled = Boolean(room.startsAt)
    $('saveSchedule').textContent = room.startsAt ? 'Cancel' : 'Schedule'
    if (room.startsAt) {
        $('startsAt').value = toLocalInput(room.startsAt)
    }
    $('nowHeading').textContent = !item ? 'Nothing playing' : room.waiting ? 'Loading…' : room.playing ? 'Now playing' : 'Paused'
    $('nowTitle').textContent = item?.name ?? 'Queue is empty'
    $('toggle').disabled = !item
    $('next').disabled = room.index >= room.queue.length - 1
    $('toggle').textContent = room.playing ? '⏸ Pause' : '▶ Play'
    renderTime()

    const last = room.queue.length - 1
    $('emptyQueue').hidden = room.queue.length > 0
    $('queue').replaceChildren(...room.queue.map((q, i) => {
        const row = li(q.name,
            button('▶', () => command({ type: 'jump', index: i }), { title: 'Play this now', disabled: i === room.index }),
            button('↑', () => command({ type: 'queueMove', from: i, to: i - 1 }), { disabled: i === 0, title: 'Move up' }),
            button('↓', () => command({ type: 'queueMove', from: i, to: i + 1 }), { disabled: i === last, title: 'Move down' }),
            button('✕', () => command({ type: 'queueRemove', index: i }), { title: 'Remove' }),
        )
        row.classList.toggle('current', i === room.index)
        return row
    }))

    $('viewers').replaceChildren(...(viewers.length ? viewers.map(viewerChip) : [el('span', 'muted', 'Nobody yet — share the link above')]))
}

/** A viewer's name; guests get a ✕ that removes them from the room. */
function viewerChip(v) {
    const chip = el('span', 'chip', v.host ? `${v.name} ★` : v.name)
    if (!v.host) {
        chip.append(button('✕', () => {
            if (confirm(`Remove ${v.name} from the room? To keep them out, also set a password.`)) {
                socket.send({ type: 'kick', id: v.id })
            }
        }, { className: 'kick', title: `Remove ${v.name}` }))
    }
    return chip
}

function renderLog(entries) {
    $('emptyLog').hidden = entries.length > 0
    $('log').replaceChildren(...entries.toReversed().map((e) => {
        const time = el('time', '', new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
        const row = el('li')
        row.append(time, `${e.name} ${e.text}`)
        return row
    }))
}

start().catch((err) => {
    $('jfError').textContent = err.message
    $('jfError').hidden = false
})
