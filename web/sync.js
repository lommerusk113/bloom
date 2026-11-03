// Pure sync math, shared by the player and the Cast sender.

export const RATE_THRESHOLD = 0.3
export const SEEK_THRESHOLD = 2
export const MAX_SEEK_LEAD = 5

/** Room position in seconds at the given server time. */
export function targetPosition(room, serverNow) {
    return room.position + (room.playing && !room.waiting ? (serverNow - room.updatedAt) / 1000 : 0)
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

/**
 * Seconds to seek ahead of the target so the player lands in sync after the
 * seek's own delay (e.g. a transcode restart). driftAfterSeek is local - target
 * measured once playback resumed: behind (negative) grows the lead.
 */
export function adaptLead(lead, driftAfterSeek) {
    return Math.min(Math.max(lead - driftAfterSeek, 0), MAX_SEEK_LEAD)
}

/** Retry delay after another consecutive failure: min first, then doubling up to max. previousMs 0 = no failure yet. */
export function nextBackoff(previousMs, min, max) {
    return previousMs ? Math.min(previousMs * 2, max) : min
}

export const MAX_JOIN_LEAD = 30

/**
 * Seconds ahead of the room a viewer who joins (or reloads for their own setting) starts loading,
 * so they buffer alone instead of holding everyone: transcode startup plus two 6s segments at their speed.
 */
export function joinLead(bitrate, speed) {
    return Math.min(Math.max(3 + (bitrate * 12) / speed, 4), MAX_JOIN_LEAD)
}
