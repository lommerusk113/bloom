import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { createLimiter, digest, MAX_AGE_S, parseCookies, sessionCookie } from './auth.ts'

const COOKIE = 'bloom_session'

/** A Jellyfin user, as far as Bloom cares. */
export type Account = { id: string; name: string; admin: boolean }
type Session = Account & { expires: number }

/**
 * Login sessions for Jellyfin users, saved as JSON in dir/sessions.json; Jellyfin checks the passwords.
 * Sessions are stored as sha256 of the cookie token, so the file alone can't be used to log in.
 */
// ponytail: one JSON file rewritten on every login; fine for a household's worth of users
export function createUsers(dir: string, secure: boolean, authenticate: (name: string, password: string) => Promise<Account | null>) {

    const file = join(dir, 'sessions.json')
    const limiter = createLimiter()
    let data: { sessions: Record<string, Session>; lastLogin: Record<string, number> } = { sessions: {}, lastLogin: {} }
    try {
        data = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(`Cannot read ${file}: ${(err as Error).message}`)
        }
    }

    function save(): void {
        mkdirSync(dir, { recursive: true })
        writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 })
        renameSync(`${file}.tmp`, file)
    }

    return {
        /** When each Jellyfin user last logged in to Bloom. */
        lastLogin: (id: string): number | null => data.lastLogin[id] ?? null,

        /** A session token, or null for a wrong name/password, a disabled Jellyfin user or a rate limited ip. */
        async login(name: string, password: string, ip: string, now = Date.now()): Promise<string | null> {
            if (limiter.blocked(ip, now)) {
                return null
            }
            const account = await authenticate(name.trim(), password)
            if (!account) {
                limiter.fail(ip, now)
                return null
            }
            for (const [key, session] of Object.entries(data.sessions)) {
                if (session.expires < now) {
                    delete data.sessions[key]
                }
            }
            const token = randomBytes(32).toString('base64url')
            data.sessions[tokenKey(token)] = { ...account, expires: now + MAX_AGE_S * 1000 }
            data.lastLogin[account.id] = now
            save()
            return token
        },

        /** The logged-in user behind the request's cookie. */
        fromRequest(req: IncomingMessage, now = Date.now()): Account | null {
            const token = parseCookies(req.headers.cookie).get(COOKIE)
            const session = token ? data.sessions[tokenKey(token)] : undefined
            return session && session.expires > now ? { id: session.id, name: session.name, admin: session.admin } : null
        },

        /**
         * Brings sessions in line with Jellyfin's current users: renames and admin rights follow,
         * deleted or disabled users are logged out. Returns the ids of users logged out.
         */
        refresh(enabled: Account[]): string[] {
            const byId = new Map(enabled.map(a => [a.id, a]))
            const dropped = new Set<string>()
            for (const [key, session] of Object.entries(data.sessions)) {
                const account = byId.get(session.id)
                if (account) {
                    data.sessions[key] = { ...account, expires: session.expires }
                } else {
                    dropped.add(session.id)
                    delete data.sessions[key]
                }
            }
            save()
            return [...dropped]
        },

        logout(req: IncomingMessage): void {
            const token = parseCookies(req.headers.cookie).get(COOKIE)
            if (token && data.sessions[tokenKey(token)]) {
                delete data.sessions[tokenKey(token)]
                save()
            }
        },

        cookie: (token: string): string => sessionCookie(COOKIE, token, secure),
        clearCookie: (): string => sessionCookie(COOKIE, '', secure, 0),
    }
}

export type Users = ReturnType<typeof createUsers>

const tokenKey = (token: string): string => digest(token).toString('hex')
