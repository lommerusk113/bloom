import { median } from './sync.js'

/** Reconnecting websocket to a room. onMessage gets every server message except clock pongs. */
export function connectRoom(roomId, name, onMessage) {
    const samples = []
    let ws = null
    let retries = 0

    const socket = {
        offset: 0,
        serverNow: () => Date.now() + socket.offset,
        send(msg) {
            if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify(msg))
            }
        },
    }
    const ping = () => socket.send({ type: 'ping', t0: Date.now() })

    function open() {
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`)
        ws.onopen = () => {
            retries = 0
            socket.send({ type: 'hello', name })
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
        ws.onclose = () => {
            onMessage({ type: 'error', message: 'Connection lost – reconnecting…' })
            setTimeout(open, Math.min(1000 * 2 ** retries++, 15_000))
        }
    }

    open()
    setInterval(ping, 30_000)
    return socket
}
