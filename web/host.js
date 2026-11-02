import { connectRoom } from './ws.js'

const $ = (id) => document.getElementById(id)
const roomId = new URLSearchParams(location.search).get('room')
let socket = null

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

function li(text, ...children) {
    const item = document.createElement('li')
    const span = document.createElement('span')
    span.textContent = text
    item.append(span, ...children)
    return item
}

function button(label, onClick, disabled = false) {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = onClick
    b.disabled = disabled
    return b
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
    $('rooms').replaceChildren(...rooms.map((r) => {
        const a = document.createElement('a')
        a.href = `/?room=${r.id}`
        a.textContent = `${r.title} (${r.viewers} connected)`
        const item = document.createElement('li')
        item.append(a)
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
    $('copy').onclick = () => navigator.clipboard.writeText(url)
    $('endRoom').onclick = async () => {
        if (!confirm('End the room for everyone?')) {
            return
        }
        try {
            await api(`/api/rooms/${roomId}`, { method: 'DELETE' })
            location.search = ''
        } catch (err) {
            $('status').textContent = err.message
        }
    }

    socket = connectRoom(roomId, 'Host', (msg) => {
        if (msg.type === 'welcome') {
            $('status').textContent = ''
        } else if (msg.type === 'error') {
            $('status').textContent = msg.message
        } else if (msg.type === 'gone') {
            $('status').textContent = 'This room no longer exists'
        } else if (msg.type === 'state') {
            render(msg)
        }
    })

    $('guestControl').onchange = () => command({ type: 'setGuestControl', value: $('guestControl').checked })
    $('searchForm').onsubmit = async (event) => {
        event.preventDefault()
        try {
            const items = await api(`/api/search?q=${encodeURIComponent($('q').value)}`)
            $('results').replaceChildren(...items.map(i => li(`${i.name} · ${i.type}`, button('Add', () => socket.send({ type: 'addItem', itemId: i.id })))))
        } catch (err) {
            $('status').textContent = err.message
        }
    }
    $('addNative').onclick = () => {
        const option = $('sessions').selectedOptions[0]
        if (option) {
            socket.send({ type: 'nativeAdd', sessionId: option.value, label: option.textContent, device: option.dataset.device, trusted: $('trusted').checked })
        }
    }
    $('refreshSessions').onclick = loadSessions
    loadSessions()
}

async function loadSessions() {
    try {
        const sessions = await api('/api/sessions')
        $('sessions').replaceChildren(...sessions.map((s) => {
            const option = new Option(s.label, s.id)
            option.dataset.device = s.device
            return option
        }))
    } catch (err) {
        $('status').textContent = err.message
    }
}

function render({ room, viewers }) {
    $('guestControl').checked = room.guestControl
    const last = room.queue.length - 1
    $('queue').replaceChildren(...room.queue.map((item, i) => li(
        `${i === room.index ? '▶ ' : ''}${item.name}`,
        button('Play', () => command({ type: 'jump', index: i })),
        button('↑', () => command({ type: 'queueMove', from: i, to: i - 1 }), i === 0),
        button('↓', () => command({ type: 'queueMove', from: i, to: i + 1 }), i === last),
        button('✕', () => command({ type: 'queueRemove', index: i })),
    )))
    $('natives').replaceChildren(...room.nativeSessions.map(n => li(
        `${n.label} — ${n.status}${n.trusted ? ' · my device' : ''}`,
        ...(n.status === 'out-of-sync'
            ? [button('Retry', () => socket.send({ type: 'nativeAdd', sessionId: n.sessionId, label: n.label, device: n.device, trusted: n.trusted }))]
            : []),
        button('Remove', () => socket.send({ type: 'nativeRemove', sessionId: n.sessionId })),
    )))
    $('viewers').textContent = viewers.join(', ') || 'nobody'
}

start().catch((err) => {
    $('jfError').textContent = err.message
})
