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

const minutes = (seconds) => seconds >= 3600 ? `${Math.floor(seconds / 3600)} h ${Math.round(seconds / 60) % 60} min` : `${Math.round(seconds / 60)} min`

function renderHistory({ recent, month }, now) {
    $('monthStats').replaceChildren(stat(month.hours, 'hours watched'), stat(month.items, 'titles played'))
    const ranked = (list, unit) => list.length ? list.map(e => { const li = el('li'); li.append(el('span', 'grow', e.name), el('span', 'muted', `${e.value}${unit}`)); return li }) : [el('li', 'muted', 'Nothing yet')]
    $('topTitles').replaceChildren(...ranked(month.topTitles, '×'))
    $('topViewers').replaceChildren(...ranked(month.topViewers, ' h'))
    $('noHistory').hidden = recent.length > 0
    $('history').replaceChildren(...recent.map(e => row(
        el('span', '', `${new Date(e.at).toLocaleDateString([], { day: 'numeric', month: 'short' })} ${new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`),
        el('strong', '', e.item),
        e.host || el('span', 'muted', '—'),
        e.viewers.join(', ') || el('span', 'muted', '—'),
        minutes(e.seconds),
    )))
}

function render({ server, rooms, users, history }) {
    renderHistory(history, server.now)
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

    $('users').replaceChildren(...users.map(u => row(
        el('strong', '', u.name),
        u.admin ? tag('admin', 'on') : tag('user'),
        String(u.rooms),
        ago(u.lastLogin, server.now),
    )))
}

async function refresh() {
    try {
        render(await api('/api/admin/overview'))
        showError('')
    } catch (err) {
        showError(err.message)
    }
}

refresh()
setInterval(refresh, 5000)
