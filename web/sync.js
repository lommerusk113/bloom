// Pure sync math, shared by the player and the Cast sender.

export const RATE_THRESHOLD = 0.3
export const SEEK_THRESHOLD = 2

/** Room position in seconds at the given server time. */
export function targetPosition(room, serverNow) {
    return room.position + (room.playing ? (serverNow - room.updatedAt) / 1000 : 0)
}

/**
 * What a player should do about its drift (local - target, seconds).
 * canRate=false for players without playbackRate (Cast Default Receiver).
 */
export function decide(drift, playing, canRate = true) {
    const abs = Math.abs(drift)
    if (abs > SEEK_THRESHOLD || (!playing && abs > RATE_THRESHOLD)) {
        return { action: 'seek' }
    }
    if (playing && canRate && abs >= RATE_THRESHOLD) {
        return { action: 'rate', rate: drift > 0 ? 0.95 : 1.05 }
    }
    return { action: 'none' }
}

export function median(values) {
    const sorted = [...values].sort((a, b) => a - b)
    const mid = sorted.length >> 1
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
