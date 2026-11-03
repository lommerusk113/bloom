const $ = (id) => document.getElementById(id)

async function api(path, init) {
    const res = await fetch(path, init)
    const body = await res.json().catch(() => ({}))
    if (res.status === 403) {
        location.href = '/' // logged out, or not an admin
    }
    if (!res.ok) {
        throw new Error(body.error ?? `${res.status} ${res.statusText}`)
    }
    return body
}

const send = (method, path, data) => api(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) })

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

function button(label, onClick, className = '') {
    const b = el('button', className, label)
    b.onclick = async () => {
        b.disabled = true
        try {
            await onClick()
            await refresh()
        } catch (err) {
            showError(err.message)
        } finally {
            b.disabled = false
        }
    }
    return b
}

function row(...cells) {
    const tr = el('tr')
    tr.append(...cells.map((cell) => {
        const td = el('td')
        td.append(cell ?? '')
        return td
    }))
    return tr
}

function showError(text) {
    $('error').textContent = text
    $('error').hidden = !text
}

const ago = (ms, now) => {
    if (!ms) {
        return 'never'
    }
    const s = Math.round((now - ms) / 1000)
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86_400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} d ago`
}

function stat(value, label, bad = false) {
    const box = el('div', `stat${bad ? ' bad' : ''}`)
    box.append(el('div', 'stat-value', String(value)), el('div', 'stat-label', label))
    return box
}

function tag(text, kind = '') {
    return el('span', `tag ${kind}`, text)
}

function render({ server, rooms, users }) {
    const viewers = rooms.reduce((sum, r) => sum + r.viewers.length, 0)
    const streams = rooms.reduce((sum, r) => sum + r.streams, 0)
    const jf = server.jellyfin
    $('stats').replaceChildren(
        stat(jf.error ? 'Down' : 'OK', jf.error ? jf.error : `Jellyfin ${jf.name} ${jf.version}`, Boolean(jf.error)),
        stat(rooms.length, 'open rooms'),
        stat(viewers, 'people watching'),
        stat(streams, 'active streams'),
        stat(users.length, 'users'),
        stat(ago(server.startedAt, server.now).replace(' ago', ''), 'uptime'),
        stat(server.tmdb ? 'On' : 'Off', 'TMDB discovery'),
    )

    $('noRooms').hidden = rooms.length > 0
    $('rooms').replaceChildren(...rooms.map((r) => {
        const watching = el('div', 'chips')
        watching.append(...r.viewers.map(v => tag(`${v.name}${v.host ? ' ★' : ''} · ${v.speed ? `${v.speed} Mbps` : '…'}${v.buffering ? ' · loading' : ''}`, v.speed && v.speed < 5 ? 'off' : '')))
        const name = el('div')
        name.append(el('strong', '', r.name), ' ', ...(r.password ? [tag('🔒')] : []))
        return row(
            name,
            r.owner,
            r.playing ? `${r.state === 'playing' ? '▶' : r.state === 'loading' ? '…' : '⏸'} ${r.playing}` : el('span', 'muted', 'nothing'),
            r.viewers.length ? watching : el('span', 'muted', 'empty'),
            String(r.streams),
            button('End', () => confirm(`End ${r.name} for everyone?`) && api(`/api/rooms/${r.id}`, { method: 'DELETE' }), 'danger'),
        )
    }))

    $('users').replaceChildren(...users.map((u) => {
        const patch = (change) => send('PATCH', `/api/admin/users/${u.id}`, change)
        const actions = el('div', 'row')
        actions.append(
            button(u.admin ? 'Remove admin' : 'Make admin', () => patch({ admin: !u.admin })),
            button(u.disabled ? 'Enable' : 'Disable', () => patch({ disabled: !u.disabled })),
            button('Reset password', async () => {
                const password = prompt(`New password for ${u.name} (6+ characters)`)
                if (password) {
                    await patch({ password })
                }
            }),
            button('Delete', () => confirm(`Delete ${u.name}? Their rooms end too.`) && send('DELETE', `/api/admin/users/${u.id}`), 'danger'),
        )
        return row(
            el('strong', '', u.name),
            u.admin ? tag('admin', 'on') : tag('user'),
            u.disabled ? tag('disabled', 'off') : tag('active'),
            String(u.rooms),
            ago(u.lastLogin, server.now),
            new Date(u.createdAt).toLocaleDateString(),
            actions,
        )
    }))
}

async function refresh() {
    try {
        render(await api('/api/admin/overview'))
        showError('')
    } catch (err) {
        showError(err.message)
    }
}

$('create').onsubmit = async (event) => {
    event.preventDefault()
    try {
        const user = await send('POST', '/api/admin/users', { name: $('newName').value.trim(), password: $('newPassword').value, admin: $('newAdmin').checked })
        $('create').reset()
        $('createNote').textContent = `Created ${user.name}. They log in at ${location.origin}`
        await refresh()
    } catch (err) {
        $('createNote').textContent = err.message
    }
}

refresh()
setInterval(refresh, 5000)
