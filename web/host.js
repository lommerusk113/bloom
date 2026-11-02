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
        await postJson('/api/login', { password: $('password').value })
        location.reload()
    } catch (err) {
        $('loginError').textContent = err.message
    }
}

async function start() {
    const me = await api('/api/me')
    $('jfError').textContent = me.jellyfinError ?? ''
    $('jfError').hidden = !me.jellyfinError
    if (!me.host) {
        $('login').hidden = false
        return
    }
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
        const a = el('a', 'grow', r.title)
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

function showPassword(password) {
    $('roomPassword').value = password
    $('savePassword').textContent = password ? 'Change' : 'Set password'
    $('passwordNote').textContent = password ? `Guests must enter “${password}” to join.` : 'No password: anyone with the link can join.'
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
    $('open').href = url
    $('openFromInvite').href = url
    $('inviteButton').onclick = () => $('invite').showModal()
    $('copy').onclick = async () => {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(url)
        } else {
            // plain http on a LAN address is not a secure context: no Clipboard API
            $('link').select()
            document.execCommand('copy')
        }
        $('copy').textContent = 'Copied ✓'
        setTimeout(() => { $('copy').textContent = 'Copy link' }, 1500)
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
        } else if (msg.type === 'error') {
            showStatus(msg.message)
        } else if (msg.type === 'gone') {
            state = null
            showStatus('This room no longer exists')
        } else if (msg.type === 'state') {
            const wasEmpty = state !== null && state.room.queue.length === 0
            state = msg
            render()
            if (wasEmpty && msg.room.queue.length > 0 && msg.viewers.length === 0) {
                $('invite').showModal() // first pick and nobody here yet: time to share the link
            }
        }
    }, true)

    $('toggle').onclick = () => command({ type: state.room.playing ? 'pause' : 'play' })
    $('next').onclick = () => command({ type: 'next' })
    $('guestControl').onchange = () => command({ type: 'setGuestControl', value: $('guestControl').checked })
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
    $('crumbs').hidden = true
    $('filters').hidden = true
    $('rows').replaceChildren()
    $('catalogue').replaceChildren()
    $('more').hidden = true
    note('')
}

/** Jellyfin-style home: a row of recently added posters per library. */
async function home() {
    selectTab('home')
    clearBrowse()
    const token = browseToken
    $('rows').replaceChildren(...views.map((v) => {
        const section = el('section', 'shelf')
        const strip = el('div', 'strip')
        strip.append(el('span', 'muted', 'Loading…'))
        const page = (direction) => strip.scrollBy({ left: direction * strip.clientWidth * 0.9, behavior: 'smooth' })
        const head = el('div', 'shelf-head')
        head.append(
            button(`Recently added in ${v.name} ›`, () => openLibrary(v), { className: 'shelf-title' }),
            button('‹', () => page(-1), { className: 'shelf-arrow', title: 'Scroll left' }),
            button('›', () => page(1), { className: 'shelf-arrow', title: 'Scroll right' }),
        )
        section.append(head, strip)
        api(`/api/latest?parent=${encodeURIComponent(v.id)}`).then((items) => {
            if (token === browseToken) {
                strip.replaceChildren(...(items.length ? items.map(i => card([{ label: 'Home', back: home }], i)) : [el('span', 'muted', 'Nothing yet')]))
            }
        }, () => strip.replaceChildren(el('span', 'error', 'Could not load')))
        return section
    }))
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
    const container = i.type === 'Series' || i.type === 'Season'
    const tile = el('button', `tile${i.type === 'Episode' ? ' wide' : ''}`)
    tile.title = container ? `Open ${i.name}` : `Add ${i.name} to the queue`

    const art = el('div', 'art')
    const img = el('img')
    img.loading = 'lazy'
    img.alt = ''
    img.src = `/api/image?id=${encodeURIComponent(i.id)}`
    img.onerror = () => {
        img.remove()
        art.append(el('span', 'placeholder', i.title))
    }
    const badge = el('span', 'badge', container ? '›' : '+')
    art.append(img, badge)
    tile.append(art, el('span', 'tile-title', i.title), el('span', 'tile-sub', i.subtitle))

    tile.onclick = () => {
        if (container) {
            const isShow = i.type === 'Series'
            browse([...trail, {
                label: i.title,
                load: list(`/api/children?id=${encodeURIComponent(i.id)}`),
                addAll: i.id,
                addLabel: isShow ? '+ Add whole show' : '+ Add whole season',
            }])
            return
        }
        addItem(i.id)
        badge.textContent = '✓'
        tile.classList.add('added')
    }
    return tile
}

function renderTime() {
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
    const item = room.queue[room.index]
    $('guestControl').checked = room.guestControl
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

    $('viewers').replaceChildren(...(viewers.length ? viewers.map(v => el('span', 'chip', v)) : [el('span', 'muted', 'Nobody yet — use Invite')]))
}

start().catch((err) => {
    $('jfError').textContent = err.message
    $('jfError').hidden = false
})
