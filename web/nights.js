const $ = (id) => document.getElementById(id)

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

function until(ms) {
    if (ms <= 0) {
        return 'starting now'
    }
    const minutes = Math.ceil(ms / 60_000)
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor(minutes / 60) % 24
    return `in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`}`
}

function night(n) {
    const card = el('li', 'night')
    const art = el('div', 'night-art')
    if (n.itemId) {
        const img = el('img')
        img.src = `/api/image?id=${encodeURIComponent(n.itemId)}`
        img.alt = ''
        img.onerror = () => img.remove()
        art.append(img)
    }
    const when = new Date(n.startsAt)
    const info = el('div', 'night-info')
    info.append(
        el('div', 'night-when', when.toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })),
        el('div', 'night-title', n.title),
        el('div', 'muted', `${n.mine ? 'Your room' : `Hosted by ${n.host}`} · ${until(n.startsAt - Date.now())}${n.viewers ? ` · ${n.viewers} waiting` : ''}`),
    )
    const actions = el('div', 'row')
    const calendar = el('a', 'button', 'Add to calendar')
    calendar.href = `/api/nights/${encodeURIComponent(n.id)}.ics`
    actions.append(calendar)
    if (n.link) {
        const open = el('a', 'button primary', 'Open your room')
        open.href = n.link
        actions.append(open)
    }
    info.append(actions)
    card.append(art, info)
    return card
}

async function load() {
    const res = await fetch('/api/nights')
    if (res.status === 403) {
        location.href = '/' // signed out
        return
    }
    if (!res.ok) {
        $('error').textContent = 'Could not load movie nights'
        $('error').hidden = false
        return
    }
    const nights = await res.json()
    $('error').hidden = true
    $('none').hidden = nights.length > 0
    $('nights').replaceChildren(...nights.map(night))
}

load()
setInterval(load, 60_000)
