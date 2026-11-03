import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { join } from 'node:path'
import { createLimiter, digest, MAX_AGE_S, parseCookies, sessionCookie } from './auth.ts'

const COOKIE = 'bloom_session'
const NAME = /^[\w.@-]{1,32}$/
const MIN_PASSWORD = 6

type StoredUser = { id: string; name: string; hash: string; admin: boolean; disabled: boolean; createdAt: number; lastLogin: number | null }
/** What the API shows about a user: never the hash. */
export type User = Omit<StoredUser, 'hash'>

/**
 * Accounts and their login sessions, saved as JSON in dir/users.json.
 * Sessions are stored as sha256 of the cookie token, so the file alone can't be used to log in.
 */
// ponytail: one JSON file rewritten on every change; fine for a household's worth of users
export function createUsers(dir: string, secure: boolean) {

    const file = join(dir, 'users.json')
    const limiter = createLimiter()
    let data: { users: StoredUser[]; sessions: Record<string, { userId: string; expires: number }> } = { users: [], sessions: {} }
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

    const publicUser = ({ hash: _, ...user }: StoredUser): User => user
    const byId = (id: string) => data.users.find(u => u.id === id)

    function validate(name: string | undefined, password: string | undefined): void {
        if (name !== undefined && !NAME.test(name)) {
            throw new Error('Username: 1–32 letters, digits, . _ @ or -')
        }
        if (name !== undefined && data.users.some(u => u.name.toLowerCase() === name.toLowerCase())) {
            throw new Error('That username is taken')
        }
        if (password !== undefined && password.length < MIN_PASSWORD) {
            throw new Error(`Password: at least ${MIN_PASSWORD} characters`)
        }
    }

    function dropSessions(userId: string): void {
        for (const [key, session] of Object.entries(data.sessions)) {
            if (session.userId === userId) {
                delete data.sessions[key]
            }
        }
    }

    return {
        count: () => data.users.length,

        list: (): User[] => data.users.map(publicUser),

        get: (id: string): User | null => {
            const user = byId(id)
            return user ? publicUser(user) : null
        },

        create(name: string, password: string, admin: boolean, now = Date.now()): User {
            validate(name, password)
            const user: StoredUser = { id: randomUUID(), name, hash: hashPassword(password), admin, disabled: false, createdAt: now, lastLogin: null }
            data.users.push(user)
            save()
            return publicUser(user)
        },

        update(id: string, change: { password?: string; admin?: boolean; disabled?: boolean }): User {
            const user = byId(id)
            if (!user) {
                throw new Error('No such user')
            }
            validate(undefined, change.password)
            if (change.password !== undefined) {
                user.hash = hashPassword(change.password)
                dropSessions(id) // a new password logs out every other device
            }
            if (change.admin !== undefined) {
                user.admin = change.admin
            }
            if (change.disabled !== undefined) {
                user.disabled = change.disabled
                if (change.disabled) {
                    dropSessions(id)
                }
            }
            save()
            return publicUser(user)
        },

        remove(id: string): void {
            data.users = data.users.filter(u => u.id !== id)
            dropSessions(id)
            save()
        },

        /** A session token, or null for a wrong name/password, a disabled account or a rate limited ip. */
        login(name: string, password: string, ip: string, now = Date.now()): string | null {
            if (limiter.blocked(ip, now)) {
                return null
            }
            const user = data.users.find(u => u.name.toLowerCase() === name.trim().toLowerCase())
            // hash even for unknown names so timing doesn't reveal which names exist
            const ok = checkPassword(password, user?.hash ?? DUMMY_HASH) && user && !user.disabled
            if (!ok) {
                limiter.fail(ip, now)
                return null
            }
            for (const [key, session] of Object.entries(data.sessions)) {
                if (session.expires < now) {
                    delete data.sessions[key]
                }
            }
            const token = randomBytes(32).toString('base64url')
            data.sessions[tokenKey(token)] = { userId: user.id, expires: now + MAX_AGE_S * 1000 }
            user.lastLogin = now
            save()
            return token
        },

        /** The logged-in, enabled user behind the request's cookie. */
        fromRequest(req: IncomingMessage, now = Date.now()): User | null {
            const token = parseCookies(req.headers.cookie).get(COOKIE)
            const session = token ? data.sessions[tokenKey(token)] : undefined
            const user = session && session.expires > now ? byId(session.userId) : undefined
            return user && !user.disabled ? publicUser(user) : null
        },

        logout(req: IncomingMessage): void {
            const token = parseCookies(req.headers.cookie).get(COOKIE)
            if (token && data.sessions[tokenKey(token)]) {
                delete data.sessions[tokenKey(token)]
                save()
            }
        },

        checkPassword: (id: string, password: string): boolean => checkPassword(password, byId(id)?.hash ?? DUMMY_HASH),

        cookie: (token: string): string => sessionCookie(COOKIE, token, secure),
        clearCookie: (): string => sessionCookie(COOKIE, '', secure, 0),
    }
}

export type Users = ReturnType<typeof createUsers>

const tokenKey = (token: string): string => digest(token).toString('hex')

function hashPassword(password: string): string {
    const salt = randomBytes(16)
    return `${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`
}

function checkPassword(password: string, stored: string): boolean {
    const [salt, hash] = stored.split(':')
    const expected = Buffer.from(hash ?? '', 'hex')
    const actual = scryptSync(password, Buffer.from(salt ?? '', 'hex'), 32)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const DUMMY_HASH = hashPassword(randomBytes(8).toString('hex'))
