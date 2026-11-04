import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** A JSON file's contents, or fallback when it doesn't exist yet. Any other read error stops the server rather than lose data. */
export function loadJson<T>(file: string, fallback: T): T {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return fallback
        }
        throw new Error(`Cannot read ${file}: ${(err as Error).message}`)
    }
}

/** Writes through a temp file and a rename, so a crash mid-write never leaves half a file; readable by the server only. */
export function saveJson(file: string, data: unknown): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
}
