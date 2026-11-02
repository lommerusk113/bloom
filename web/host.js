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
    if (roomId && rooms.some(r => r.id === roomId)) {
        manage()
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

function manage() {
    $('manage').hidden = false
    const url = `${location.origin}/r/${roomId}`
    $('link').value = url
    $('open').href = url
    $('copy').onclick = async () => {
        await navigator.clipboard.writeText(url)
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
            state = msg
            render()
        }
    })

    $('toggle').onclick = () => command({ type: state.room.playing ? 'pause' : 'play' })
    $('next').onclick = () => command({ type: 'next' })
    $('guestControl').onchange = () => command({ type: 'setGuestControl', value: $('guestControl').checked })
    $('searchForm').onsubmit = (event) => {
        event.preventDefault()
        const term = $('q').value
        browse([{ label: `Results for “${term}”`, load: () => api(`/api/search?q=${encodeURIComponent(term)}`) }])
    }
    $('addNative').onclick = () => {
        const option = $('sessions').selectedOptions[0]
        if (option) {
            socket.send({ type: 'nativeAdd', sessionId: option.value, label: option.textContent, device: option.dataset.device, trusted: $('trusted').checked })
        }
    }
    $('refreshSessions').onclick = loadSessions
    loadSessions()
    setInterval(renderTime, 1000)
}

const KIND = { Movie: 'Movie', Series: 'Show', Season: 'Season', Episode: 'Episode' }

/** Shows the last level of a search → show → season trail; crumbs go back up. */
let browseToken = 0

async function browse(trail) {
    const token = ++browseToken // a slower earlier search must not overwrite this one
    const level = trail.at(-1)
    $('crumbs').hidden = trail.length < 2
    $('crumbs').replaceChildren(...trail.flatMap((step, i) => {
        const crumb = i === trail.length - 1 ? el('span', '', step.label) : button(step.label, () => browse(trail.slice(0, i + 1)), { className: 'link' })
        return i ? [el('span', 'muted', ' › '), crumb] : [crumb]
    }))
    $('results').replaceChildren(li('Loading…'))
    try {
        const items = await level.load()
        if (token !== browseToken) {
            return
        }
        if (items.length === 0) {
            $('results').replaceChildren(li('Nothing found'))
            return
        }
        $('results').replaceChildren(...items.map((i) => {
            const add = () => {
                socket.send({ type: 'addItem', itemId: i.id })
                showStatus(`Added ${i.name}`, false)
            }
            const container = i.type === 'Series' || i.type === 'Season'
            const open = () => browse([...trail, { label: i.name, load: () => api(`/api/children?id=${encodeURIComponent(i.id)}`) }])
            const row = li(i.name, el('span', 'tag', KIND[i.type] ?? i.type))
            if (container) {
                row.append(button(i.type === 'Series' ? 'Seasons ›' : 'Episodes ›', open, { className: 'primary' }), button('Add all', add))
            } else {
                row.append(button('Add', add, { className: 'primary' }))
            }
            return row
        }))
    } catch (err) {
        if (token !== browseToken) {
            return
        }
        $('results').replaceChildren(li(`Failed: ${err.message}`))
    }
}

async function loadSessions() {
    try {
        const sessions = await api('/api/sessions')
        $('sessions').replaceChildren(...sessions.map((s) => {
            const option = new Option(s.label, s.id)
            option.dataset.device = s.device
            return option
        }))
        if (sessions.length === 0) {
            $('sessions').replaceChildren(new Option('No Jellyfin apps open right now', ''))
        }
    } catch (err) {
        showStatus(err.message)
    }
}

function renderTime() {
    const item = state?.room.queue[state.room.index]
    if (!item) {
        $('nowTime').textContent = ''
        return
    }
    const position = Math.min(targetPosition(state.room, socket.serverNow()), item.runtime || Infinity)
    $('nowTime').textContent = `${state.room.playing ? 'Playing' : 'Paused'} · ${clock(position)} / ${clock(item.runtime)}`
}

function render() {
    const { room, viewers } = state
    const item = room.queue[room.index]
    $('guestControl').checked = room.guestControl
    $('nowTitle').textContent = item?.name ?? 'Nothing yet — add something below'
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

    $('natives').replaceChildren(...room.nativeSessions.map((n) => {
        const ok = n.status === 'syncing'
        return li(`${n.label}${n.trusted ? ' · my device' : ''}`,
            el('span', ok ? 'tag ok' : 'tag bad', ok ? 'In sync' : 'Out of sync'),
            ...(ok ? [] : [button('Retry', () => socket.send({ type: 'nativeAdd', sessionId: n.sessionId, label: n.label, device: n.device, trusted: n.trusted }))]),
            button('Remove', () => socket.send({ type: 'nativeRemove', sessionId: n.sessionId })),
        )
    }))

    $('viewers').replaceChildren(...(viewers.length ? viewers.map(v => el('span', 'chip', v)) : [el('span', 'muted', 'Nobody has joined yet')]))
}

start().catch((err) => {
    $('jfError').textContent = err.message
    $('jfError').hidden = false
})
