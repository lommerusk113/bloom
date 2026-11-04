// What shows over the video besides the controls: up next, votes, reactions, skip buttons, and the phone's lock screen.
import { $ } from './util.js'

const UP_NEXT_S = 15
const REACTIONS = ['😂', '😢', '😮', '😍', '👏', '😱', '🔥']
const SKIP_LABELS = { Intro: 'Skip intro', Recap: 'Skip recap', Outro: 'Skip credits', Preview: 'Skip preview' }

/**
 * ctx: roomId, state() (the last state message), canControl(), command(cmd), send(msg), myId(),
 * serverNow(), currentTarget(), castActive().
 */
export function setupOverlays(ctx) {

    let segments = { itemId: null, list: [] } // intro/credits ranges of the playing item
    let sessionItem = null
    const mediaSession = 'mediaSession' in navigator ? navigator.mediaSession : null

    /** The last seconds of an item: what plays next, with "Play now" and "Pause" for viewers who may control playback. */
    function showUpNext(target) {
        const { room } = ctx.state()
        const item = room.queue[room.index]
        const next = room.queue[room.index + 1]
        const left = (item?.runtime ?? 0) - target
        $('upNext').hidden = !next || !room.playing || !item.runtime || left > UP_NEXT_S || left <= 0
        if (!$('upNext').hidden) {
            $('upNextName').textContent = next.name
            $('upNextIn').textContent = `starting in ${Math.ceil(left)}s`
            $('upNextActions').hidden = !ctx.canControl()
        }
    }

    /** "Skip intro"/"Skip credits" while the room is inside such a segment, for viewers who may control playback. */
    function showSkip(target, local) {
        const { room } = ctx.state()
        const item = room.queue[room.index]
        if (item && segments.itemId !== item.id) {
            segments = { itemId: item.id, list: [] }
            fetch(`/r/${ctx.roomId}/segments`).then(res => res.ok ? res.json() : []).then((list) => {
                if (segments.itemId === item.id) {
                    segments.list = list
                }
            }).catch(() => {})
        }
        const segment = segments.list.find(s => target >= s.start && target < s.end - 1)
        $('skip').hidden = !segment || !ctx.canControl() || (!local && !ctx.castActive()) || !$('upNext').hidden
        if (segment) {
            $('skip').textContent = SKIP_LABELS[segment.type] ?? 'Skip'
            // credits that run to the end: on to the next item instead of the last second of this one
            const toEnd = segment.end >= (item.runtime || Infinity) - 2 && room.index < room.queue.length - 1
            $('skip').onclick = () => ctx.command(toEnd ? { type: 'next' } : { type: 'seek', position: segment.end })
        }
    }

    function renderVote() {
        const vote = ctx.state().room.vote
        $('vote').hidden = !vote
        if (!vote) {
            return
        }
        const ballots = Object.values(vote.ballots)
        $('voteOptions').replaceChildren(...vote.options.map((option, i) => {
            const count = ballots.filter(b => b === i).length
            const pick = document.createElement('button')
            pick.classList.toggle('mine', vote.ballots[ctx.myId()] === i)
            const label = document.createElement('span')
            label.textContent = option.name
            const tally = document.createElement('span')
            tally.className = 'count'
            tally.textContent = `${count} vote${count === 1 ? '' : 's'}`
            pick.append(label, tally)
            pick.onclick = () => ctx.send({ type: 'vote', option: i })
            return pick
        }))
        showVoteTime()
    }

    function showVoteTime() {
        const vote = ctx.state()?.room.vote
        if (vote) {
            $('voteIn').textContent = `${Math.max(0, Math.ceil((vote.endsAt - ctx.serverNow()) / 1000))}s left`
        }
    }

    /** Floats someone's reaction up the screen, everyone's own included. */
    function showReaction(emoji, name) {
        if ($('reactionLayer').childElementCount > 30) {
            return // a flood would only bury the movie
        }
        const bubble = document.createElement('div')
        bubble.className = 'reaction'
        bubble.style.left = `${60 + Math.random() * 30}%`
        const who = document.createElement('small')
        who.textContent = name
        bubble.append(emoji, who)
        bubble.addEventListener('animationend', () => bubble.remove())
        $('reactionLayer').append(bubble)
    }

    /** The phone's lock screen and headset buttons: title, poster, and the room's play state. */
    function showMediaSession(room, item) {
        if (!mediaSession) {
            return
        }
        if (item?.id !== sessionItem) {
            sessionItem = item?.id ?? null
            mediaSession.metadata = item
                ? new MediaMetadata({ title: item.name, artist: room.name, artwork: [{ src: `/r/${ctx.roomId}/poster?item=${item.id}`, sizes: '320x480', type: 'image/jpeg' }] })
                : null
        }
        mediaSession.playbackState = room.playing ? 'playing' : 'paused'
    }

    function showSessionPosition(position, runtime) {
        try {
            if (runtime > 0) {
                mediaSession?.setPositionState({ duration: runtime, position: Math.min(Math.max(position, 0), runtime), playbackRate: 1 })
            }
        } catch {
            // an older browser without position state
        }
    }

    /** Lock-screen buttons send room commands like the on-screen ones, when this viewer may control playback. */
    function sessionAction(action, cmd) {
        try {
            mediaSession?.setActionHandler(action, () => {
                if (ctx.state() && ctx.canControl()) {
                    ctx.command(cmd())
                }
            })
        } catch {
            // the browser doesn't offer this button
        }
    }

    $('upNextPlay').onclick = () => ctx.command({ type: 'next' })
    $('upNextPause').onclick = () => ctx.command({ type: 'pause' })
    $('reactBar').replaceChildren(...REACTIONS.map((emoji) => {
        const b = document.createElement('button')
        b.textContent = emoji
        b.title = `React ${emoji}`
        b.onclick = () => ctx.send({ type: 'react', emoji })
        return b
    }))
    $('reactButton').onclick = (event) => {
        event.stopPropagation()
        $('reactBar').hidden = !$('reactBar').hidden
        $('reactButton').setAttribute('aria-expanded', String(!$('reactBar').hidden))
    }
    $('reactBar').onclick = (event) => event.stopPropagation()
    document.addEventListener('click', () => {
        $('reactBar').hidden = true
        $('reactButton').setAttribute('aria-expanded', 'false')
    })
    sessionAction('play', () => ({ type: 'play' }))
    sessionAction('pause', () => ({ type: 'pause' }))
    sessionAction('seekbackward', () => ({ type: 'seek', position: Math.max(0, ctx.currentTarget() - 10) }))
    sessionAction('seekforward', () => ({ type: 'seek', position: ctx.currentTarget() + 30 }))
    sessionAction('nexttrack', () => ({ type: 'next' }))

    return {
        /** Every sync tick: the parts that follow the clock. */
        tick(target, local, position, runtime) {
            showUpNext(target)
            showSkip(target, local)
            showVoteTime()
            showSessionPosition(position, runtime)
        },
        /** Every state message. */
        render(room, item) {
            renderVote()
            showMediaSession(room, item)
        },
        showReaction,
    }
}
