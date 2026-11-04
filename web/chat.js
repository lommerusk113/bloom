// The chat beside the video (Discord style, also in fullscreen), with GIFs and title suggestions.
import { $, clock, debounced, listItem, recall, store } from './util.js'

/**
 * ctx: roomId, send(msg), myName(), small (the settings page's player, too small for chat),
 * and jumpTo(itemId, position): seeks the room there if allowed, else returns why not.
 */
export function setupChat(ctx) {

    let unread = 0

    function setOpen(open) {
        $('chat').hidden = !open
        $('player').classList.toggle('chat-open', open)
        $('chatButton').setAttribute('aria-expanded', String(open))
        store('wp_chat', open ? '1' : '0')
        if (open) {
            unread = 0
            $('unread').hidden = true
            $('chatLog').scrollTop = $('chatLog').scrollHeight
        } else {
            $('gifPicker').hidden = true
            $('suggestPicker').hidden = true
        }
    }

    function showHistory(messages) {
        $('chatLog').replaceChildren()
        messages.forEach(m => add(m, false))
        if (!messages.length) {
            const hint = listItem('No messages yet. Say hi!')
            hint.className = 'empty'
            $('chatLog').append(hint)
        }
    }

    function add(message, live = true) {
        const log = $('chatLog')
        log.querySelector('.empty')?.remove()
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40
        const row = document.createElement('li')
        row.title = new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        if (message.position !== null && message.itemId) {
            // where the movie was when it was said: tap to go back there
            const at = document.createElement('button')
            at.className = 'at'
            at.type = 'button'
            at.textContent = clock(message.position)
            at.title = 'Jump here'
            at.onclick = () => {
                const refused = ctx.jumpTo(message.itemId, message.position)
                if (refused) {
                    at.disabled = true
                    at.title = refused
                }
            }
            row.append(at)
        }
        const who = document.createElement('span')
        who.className = 'who'
        who.textContent = message.name
        row.append(who, message.text)
        if (message.gif) {
            row.append(image(message.gif.url, 'GIF', message.gif))
        }
        log.append(row)
        while (log.children.length > 200) {
            log.firstElementChild.remove()
        }
        if (atBottom || message.name === ctx.myName()) {
            log.scrollTop = log.scrollHeight
        }
        if (live && $('chat').hidden) {
            unread++
            $('unread').textContent = unread > 9 ? '9+' : String(unread)
            $('unread').hidden = false
        }
    }

    // pickers: GIFs and suggestions share the space above the input, one at a time
    function showPicker(id) {
        const show = $(id).hidden
        $('gifPicker').hidden = true
        $('suggestPicker').hidden = true
        $(id).hidden = !show
        return show
    }

    const searchGifs = debounced(350, async (term) => {
        const res = await fetch(`/r/${ctx.roomId}/gifs?q=${encodeURIComponent(term)}`).catch(() => null)
        const gifs = res?.ok ? await res.json() : []
        return () => $('gifResults').replaceChildren(...gifs.map((gif) => {
            const pick = document.createElement('button')
            pick.type = 'button'
            pick.title = gif.title
            pick.append(image(gif.preview, gif.title))
            pick.onclick = () => {
                ctx.send({ type: 'chat', text: $('chatInput').value.trim(), gif: { url: gif.url, width: gif.width, height: gif.height } })
                $('chatInput').value = ''
                $('gifPicker').hidden = true
            }
            return pick
        }))
    })

    // guests suggest from TMDB's catalogue: it shows in chat and on the host's page
    const searchTitles = debounced(300, async (term) => {
        const res = term ? await fetch(`/r/${ctx.roomId}/search?q=${encodeURIComponent(term)}`).catch(() => null) : null
        const found = res?.ok ? await res.json() : []
        return () => $('suggestResults').replaceChildren(...found.map((t) => {
            const pick = document.createElement('button')
            pick.type = 'button'
            const title = document.createElement('span')
            title.textContent = t.name
            const kind = document.createElement('small')
            kind.textContent = t.type === 'Series' ? 'Show' : 'Movie'
            const text = document.createElement('div')
            text.append(title, kind)
            pick.append(image(t.poster, ''), text)
            pick.onclick = () => {
                ctx.send({ type: 'suggest', tmdbId: t.tmdbId, kind: t.type })
                pick.disabled = true
                title.textContent = `✓ Suggested ${t.name}`
            }
            return listItem('', pick)
        }))
    })

    $('chatButton').onclick = (event) => {
        event.stopPropagation()
        setOpen($('chat').hidden)
    }
    $('chatClose').onclick = () => setOpen(false)
    $('chatForm').onsubmit = (event) => {
        event.preventDefault()
        const text = $('chatInput').value.trim()
        if (text) {
            ctx.send({ type: 'chat', text })
            $('chatInput').value = ''
        }
    }
    $('chat').onclick = (event) => event.stopPropagation() // clicks in the chat don't toggle playback or close menus
    $('chat').onkeydown = (event) => event.stopPropagation() // typing a space doesn't pause
    $('gifButton').onclick = () => {
        if (showPicker('gifPicker')) {
            $('gifSearch').value = ''
            $('gifSearch').focus()
            searchGifs('')
        }
    }
    $('gifSearch').oninput = () => searchGifs($('gifSearch').value)
    $('suggestButton').onclick = () => {
        if (showPicker('suggestPicker')) {
            $('suggestSearch').focus()
        }
    }
    $('suggestSearch').oninput = () => searchTitles($('suggestSearch').value.trim())
    for (const id of ['gifSearch', 'suggestSearch']) {
        $(id).onkeydown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault() // not a chat send
            }
        }
    }
    setOpen(!ctx.small && recall('wp_chat') === '1')

    return {
        add,
        showHistory,
        toggle: () => setOpen($('chat').hidden),
        /** What this server offers: GIF search needs GIPHY, suggestions need TMDB. */
        configure({ gifs, suggest }) {
            $('gifButton').hidden = !gifs
            $('suggestButton').hidden = !suggest
        },
    }
}

/** An image from GIPHY or TMDB: lazy, and without telling them which page asked. */
function image(src, alt, size) {
    const img = document.createElement('img')
    if (src) {
        img.src = src
    }
    img.alt = alt
    img.loading = 'lazy'
    img.referrerPolicy = 'no-referrer'
    if (size) {
        img.width = size.width
        img.height = size.height
        img.style.height = 'auto'
    }
    return img
}
