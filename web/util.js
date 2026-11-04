// Small helpers the player's modules share.

export const $ = (id) => document.getElementById(id)

/** localStorage that never throws: private mode just doesn't remember. */
export function recall(key) {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

export function store(key, value) {
    try {
        localStorage.setItem(key, value)
    } catch {
        // private mode: not remembered, still works
    }
}

/** 0:42, 12:05 or 1:02:05. */
export function clock(seconds) {
    const s = Math.max(0, Math.floor(seconds))
    const h = Math.floor(s / 3600)
    const m = Math.floor(s / 60) % 60
    const sec = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function listItem(text, ...children) {
    const li = document.createElement('li')
    li.textContent = text
    li.append(...children)
    return li
}

/** Runs fn after the input has been still for ms; only the latest call's result is kept. */
export function debounced(ms, fn) {
    let timer = 0
    let token = 0
    return (...args) => {
        clearTimeout(timer)
        timer = setTimeout(async () => {
            const mine = ++token
            const result = await fn(...args)
            if (mine === token) {
                result?.()
            }
        }, ms)
    }
}

const DAY_MS = 24 * 3600_000

/** 2d 3h, 4h 10m or 12m. */
export function until(ms) {
    const minutes = Math.max(0, Math.ceil(ms / 60_000))
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor(minutes / 60) % 24
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

export const longDate = (ms) => new Date(ms).toLocaleString([], { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/**
 * A start time picker: a strip of days (and "Now" when allowed) plus a time, defaulting to 20:00.
 * value() is null for now, a time in ms, or NaN for a time that has passed; onChange fires on every pick.
 */
export function timePicker(root, { allowNow = false, onChange = () => {} } = {}) {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const days = Array.from({ length: 14 }, (_, i) => new Date(midnight.getTime() + i * DAY_MS + 3600_000).setHours(0, 0, 0, 0))
    let day = allowNow ? null : days[0]

    const strip = document.createElement('div')
    strip.className = 'day-strip'
    const chip = (label, sub, value) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'day'
        b.innerHTML = '<span></span><small></small>'
        b.firstChild.textContent = label
        b.lastChild.textContent = sub
        b.onclick = () => { day = value; update() }
        b.dataset.value = String(value)
        return b
    }
    if (allowNow) {
        strip.append(chip('Now', 'start', null))
    }
    strip.append(...days.map((d, i) => chip(
        i === 0 ? 'Today' : i === 1 ? 'Tmrw' : new Date(d).toLocaleDateString([], { weekday: 'short' }),
        new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' }),
        d,
    )))

    const time = document.createElement('select')
    time.setAttribute('aria-label', 'Time')
    for (let m = 0; m < 1440; m += 15) {
        const label = new Date(midnight.getTime() + m * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        time.add(new Option(label, String(m), false, m === 20 * 60))
    }
    time.onchange = () => update()
    const summary = document.createElement('p')
    summary.className = 'muted small'
    const timeRow = document.createElement('label')
    timeRow.className = 'time-row'
    timeRow.append('at ', time)
    root.replaceChildren(strip, timeRow, summary)

    const value = () => {
        if (day === null) {
            return null
        }
        const at = new Date(day)
        at.setHours(0, Number(time.value), 0, 0) // minutes past midnight, DST-safe
        return at.getTime() > Date.now() ? at.getTime() : NaN
    }
    function update() {
        for (const b of strip.children) {
            b.classList.toggle('active', b.dataset.value === String(day))
        }
        timeRow.hidden = day === null
        const at = value()
        summary.textContent = at === null ? 'Starts right away.' : Number.isNaN(at) ? 'That time has passed: pick a later one.' : `${longDate(at)} · in ${until(at - Date.now())}`
        onChange(at)
    }
    update()
    return { value }
}
