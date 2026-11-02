import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

const COOKIE = 'wp_host'
const MAX_AGE_S = 30 * 24 * 3600
const MAX_FAILURES = 10
const WINDOW_MS = 15 * 60_000

// ponytail: tokens live in memory, so a restart logs the host out. Fine for one host.
export function createAuth(password: string, secure: boolean) {

    const expected = digest(password)
    const tokens = new Set<string>()
    const failures = new Map<string, { count: number; since: number }>()

    return {
        /** A new session token, or null when the password is wrong or the ip is rate limited. */
        login(attempt: string, ip: string, now = Date.now()): string | null {

            for (const [key, entry] of failures) {
                if (now - entry.since > WINDOW_MS) {
                    failures.delete(key)
                }
            }

            const current = failures.get(ip)
            if (current && current.count >= MAX_FAILURES) {
                return null
            }

            if (!timingSafeEqual(digest(attempt), expected)) {
                failures.set(ip, { count: (current?.count ?? 0) + 1, since: current?.since ?? now })
                return null
            }

            const token = randomBytes(32).toString('base64url')
            tokens.add(token)

            return token
        },

        /** Number of ips with failures inside the window. */
        trackedIps(): number {
            return failures.size
        },

        isHost(req: IncomingMessage): boolean {
            const token = parseCookies(req.headers.cookie).get(COOKIE)
            return token !== undefined && tokens.has(token)
        },

        cookie(token: string): string {
            return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`
        },
    }
}

function digest(value: string): Buffer {
    return createHash('sha256').update(value).digest()
}

function parseCookies(header = ''): Map<string, string> {
    const cookies = new Map<string, string>()
    for (const part of header.split(';')) {
        const eq = part.indexOf('=')
        if (eq > 0) {
            cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
        }
    }
    return cookies
}
