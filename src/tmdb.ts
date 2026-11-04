/** TMDB lists (trending, popular) as TMDB ids; free key from themoviedb.org. Takes a v3 api key or a v4 read token. */
export type TmdbType = 'movie' | 'tv'

const TTL_MS = 60 * 60_000
const PAGES = 5

export function createTmdb(key: string) {

    const cache = new Map<string, { at: number; ids: Promise<string[]> }>()
    let art: { at: number; urls: Promise<string[]> } | null = null
    const bearer = key.length > 40 // v4 tokens are long JWTs, v3 keys 32 hex chars

    async function results(path: string, n: number, extra: Record<string, string> = {}): Promise<TmdbResult[]> {
        const query = new URLSearchParams({ page: String(n), ...extra, ...(bearer ? {} : { api_key: key }) })
        const res = await fetch(`https://api.themoviedb.org/3${path}?${query}`, { headers: bearer ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) })
        if (!res.ok) {
            throw new Error(`TMDB ${res.status}`)
        }
        return ((await res.json()) as { results?: TmdbResult[] }).results ?? []
    }

    function list(path: string): Promise<string[]> {
        const hit = cache.get(path)
        if (hit && Date.now() - hit.at < TTL_MS) {
            return hit.ids
        }
        const page = async (n: number) => (await results(path, n)).map(r => String(r.id))
        // a 20-title page rarely overlaps a home library much
        const ids = Promise.all(Array.from({ length: PAGES }, (_, i) => page(i + 1))).then(pages => [...new Set(pages.flat())])
        ids.catch(() => cache.delete(path)) // retry a failed list on the next request
        cache.set(path, { at: Date.now(), ids })
        return ids
    }

    return {
        trending: (type: TmdbType) => list(`/trending/${type}/week`),
        popular: (type: TmdbType) => list(`/${type}/popular`),
        /** Movies and shows matching a search, as guests see them: TMDB's catalogue, not the library's. */
        async search(term: string): Promise<TmdbTitle[]> {
            const found = await results('/search/multi', 1, { query: term, include_adult: 'false' })
            return found.filter(r => r.media_type === 'movie' || r.media_type === 'tv').slice(0, 20).map(title)
        },

        /** One movie or show by its TMDB id. */
        async title(type: TmdbType, id: string): Promise<TmdbTitle> {
            const query = new URLSearchParams(bearer ? {} : { api_key: key })
            const res = await fetch(`https://api.themoviedb.org/3/${type}/${encodeURIComponent(id)}?${query}`, { headers: bearer ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) })
            if (!res.ok) {
                throw new Error(`TMDB ${res.status}`)
            }
            return title({ ...(await res.json() as TmdbResult), media_type: type })
        },

        /** Wide artwork of this week's trending titles, for the login page's background. */
        backdrops(): Promise<string[]> {
            if (!art || Date.now() - art.at > TTL_MS) {
                const urls = results('/trending/all/week', 1).then(r => r.filter(i => i.backdrop_path).slice(0, 12).map(i => `https://image.tmdb.org/t/p/w1280${i.backdrop_path}`))
                urls.catch(() => { art = null })
                art = { at: Date.now(), urls }
            }
            return art.urls
        },
    }
}

export type Tmdb = ReturnType<typeof createTmdb>

type TmdbResult = { id: number; media_type?: string; title?: string; name?: string; release_date?: string; first_air_date?: string; poster_path?: string | null; backdrop_path?: string | null }

/** type is Jellyfin's word for it, so it matches the library's TMDB index ("Movie:105"). */
export type TmdbTitle = { tmdbId: string; type: 'Movie' | 'Series'; name: string; year: string; poster: string | null }

function title(r: TmdbResult): TmdbTitle {
    const year = (r.release_date ?? r.first_air_date ?? '').slice(0, 4)
    return {
        tmdbId: String(r.id),
        type: r.media_type === 'tv' ? 'Series' : 'Movie',
        name: year ? `${r.title ?? r.name} (${year})` : (r.title ?? r.name ?? ''),
        year,
        poster: r.poster_path ? `https://image.tmdb.org/t/p/w185${r.poster_path}` : null,
    }
}
