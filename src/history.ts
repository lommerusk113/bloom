import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One item watched in one room: who hosted, who watched, and for how long it actually played. */
export type Watched = { at: number; itemId: string; item: string; room: string; host: string; viewers: string[]; seconds: number }

const MAX_ENTRIES = 5000
const MIN_SECONDS = 60 // shorter is someone browsing, not watching
const DAY_MS = 24 * 3600_000

/** Watch history, saved as JSON in dir/history.json. */
// ponytail: one JSON file rewritten per finished item; fine for a household's few items a day
export function createHistory(dir: string) {

    const file = join(dir, 'history.json')
    let entries: Watched[] = []
    try {
        entries = JSON.parse(readFileSync(file, 'utf8'))
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(`Cannot read ${file}: ${(err as Error).message}`)
        }
    }

    return {
        add(entry: Watched): void {
            if (entry.seconds < MIN_SECONDS) {
                return
            }
            entries.push(entry)
            entries.splice(0, entries.length - MAX_ENTRIES)
            mkdirSync(dir, { recursive: true })
            writeFileSync(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 })
            renameSync(`${file}.tmp`, file)
        },

        /** The latest entries and totals for the last 30 days. */
        summary(now = Date.now()) {
            const month = entries.filter(e => now - e.at < 30 * DAY_MS)
            const top = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, value]) => ({ name, value }))
            const titles = new Map<string, number>()
            const people = new Map<string, number>()
            for (const e of month) {
                titles.set(e.item, (titles.get(e.item) ?? 0) + 1)
                for (const name of e.viewers) {
                    people.set(name, (people.get(name) ?? 0) + e.seconds)
                }
            }
            return {
                recent: entries.slice(-50).toReversed(),
                month: {
                    hours: Math.round(month.reduce((sum, e) => sum + e.seconds, 0) / 360) / 10,
                    items: month.length,
                    topTitles: top(titles),
                    topViewers: top(people).map(p => ({ name: p.name, value: Math.round(p.value / 360) / 10 })),
                },
            }
        },
    }
}
