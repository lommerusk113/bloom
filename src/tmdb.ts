/** TMDB lists (trending, popular) as TMDB ids; free key from themoviedb.org. Takes a v3 api key or a v4 read token. */
export type TmdbType = 'movie' | 'tv'

const TTL_MS = 60 * 60_000
const PAGES = 5

export function createTmdb(key: string) {

    const cache = new Map<string, { at: number; ids: Promise<string[]> }>()

    function list(path: string): Promise<string[]> {
        const hit = cache.get(path)
        if (hit && Date.now() - hit.at < TTL_MS) {
            return hit.ids
        }
        const bearer = key.length > 40 // v4 tokens are long JWTs, v3 keys 32 hex chars
        const page = async (n: number) => {
            const query = new URLSearchParams({ page: String(n), ...(bearer ? {} : { api_key: key }) })
            const res = await fetch(`https://api.themoviedb.org/3${path}?${query}`, { headers: bearer ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) })
            if (!res.ok) {
                throw new Error(`TMDB ${res.status}`)
            }
            const body = (await res.json()) as { results?: Array<{ id: number }> }
            return (body.results ?? []).map(r => String(r.id))
        }
        // a 20-title page rarely overlaps a home library much
        const ids = Promise.all(Array.from({ length: PAGES }, (_, i) => page(i + 1))).then(pages => [...new Set(pages.flat())])
        ids.catch(() => cache.delete(path)) // retry a failed list on the next request
        cache.set(path, { at: Date.now(), ids })
        return ids
    }

    return {
        trending: (type: TmdbType) => list(`/trending/${type}/week`),
        popular: (type: TmdbType) => list(`/${type}/popular`),
    }
}

export type Tmdb = ReturnType<typeof createTmdb>
