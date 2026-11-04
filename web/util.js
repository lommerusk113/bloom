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
