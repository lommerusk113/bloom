import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const MAX_AGE_S = 30 * 24 * 3600
const MAX_FAILURES = 10
const WINDOW_MS = 15 * 60_000

/** Counts failed logins per ip: blocked after MAX_FAILURES inside WINDOW_MS. */
// ponytail: behind a reverse proxy all logins share the proxy's ip, making the limit global
export function createLimiter() {

    const failures = new Map<string, { count: number; since: number }>()

    return {
        blocked(ip: string, now = Date.now()): boolean {
            for (const [key, entry] of failures) {
                if (now - entry.since > WINDOW_MS) {
                    failures.delete(key)
                }
            }
            return (failures.get(ip)?.count ?? 0) >= MAX_FAILURES
        },
        fail(ip: string, now = Date.now()): void {
            const current = failures.get(ip)
            failures.set(ip, { count: (current?.count ?? 0) + 1, since: current?.since ?? now })
        },
        /** Number of ips with failures inside the window. */
        size: () => failures.size,
    }
}

/** Password login with a session cookie; used for each password-protected room. */
// ponytail: tokens live in memory, so a restart asks guests for the room password again.
export function createAuth(password: string, secure: boolean, cookieName = 'wp_host') {

    const expected = digest(password)
    const tokens = new Set<string>()
    const limiter = createLimiter()

    return {
        /** A new session token, or null when the password is wrong or the ip is rate limited. */
        login(attempt: string, ip: string, now = Date.now()): string | null {

            if (limiter.blocked(ip, now)) {
                return null
            }

            if (!timingSafeEqual(digest(attempt), expected)) {
                limiter.fail(ip, now)
                return null
            }

            const token = randomBytes(32).toString('base64url')
            tokens.add(token)

            return token
        },

        trackedIps: limiter.size,

        isLoggedIn(req: IncomingMessage): boolean {
            const token = parseCookies(req.headers.cookie).get(cookieName)
            return token !== undefined && tokens.has(token)
        },

        cookie: (token: string): string => sessionCookie(cookieName, token, secure),
    }
}

export const sessionCookie = (name: string, token: string, secure: boolean, maxAge = MAX_AGE_S): string =>
    `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`

export function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest()
}

export function parseCookies(header = ''): Map<string, string> {
    const cookies = new Map<string, string>()
    for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0) {
            cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
        }
    }
    return cookies
}
