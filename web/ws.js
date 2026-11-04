import { median, nextBackoff } from './sync.js'

/**
 * Reconnecting websocket to a room. onMessage gets every server message except clock pongs,
 * { type: 'gone' } once the room is deleted and { type: 'locked' } when it needs a password this browser lacks.
 */
export function connectRoom(roomId, name, onMessage, observer = false) {
    const samples = []
    let ws = null
    let delay = 0 // reconnect backoff, 0 while connected
    let closed = false

    const socket = {
        offset: 0,
        serverNow: () => Date.now() + socket.offset,
        send(msg) {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg))
            }
        },
        /** Leaves the room for good: no reconnecting. */
        close() {
            closed = true
            ws?.close()
        },
    }
    const ping = () => socket.send({ type: 'ping', t0: Date.now() })

    function open() {
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`)
        ws.onopen = () => {
            delay = 0
            socket.send({ type: 'hello', name, observer })
            for (let i = 0; i < 5; i++) {
                setTimeout(ping, i * 200)
            }
        }
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data)
            if (msg.type !== 'pong') {
                onMessage(msg)
                return
            }
            samples.push(msg.server - (msg.t0 + Date.now()) / 2)
            if (samples.length > 5) {
                samples.shift()
            }
            socket.offset = median(samples)
        }
        ws.onclose = (event) => {
            if (closed) {
                return
            }
            if (event.code === 4404) {
                onMessage({ type: 'gone' })
                return
            }
            if (event.code === 4401) {
                onMessage({ type: 'locked' })
                return
            }
            if (event.code === 4403) {
                onMessage({ type: 'kicked' })
                return
            }
            onMessage({ type: 'error', message: 'Connection lost – reconnecting…' })
            delay = nextBackoff(delay, 1000, 15_000)
            setTimeout(open, delay)
        }
    }

    open()
    setInterval(ping, 30_000)
    return socket
}
