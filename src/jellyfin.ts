import type { QueueItem } from './room.ts'
import type { Account } from './users.ts'

export const TICKS_PER_SECOND = 10_000_000

type JfItem = {
    Id: string
    Name: string
    Type: string
    SeriesName?: string
    SeriesId?: string
    ParentIndexNumber?: number
    IndexNumber?: number
    RunTimeTicks?: number
    ProductionYear?: number
    CommunityRating?: number
    OfficialRating?: string
    Genres?: string[]
    Overview?: string
    ProviderIds?: Record<string, string>
    BackdropImageTags?: string[]
}

export type Jellyfin = ReturnType<typeof createJellyfin>

export const normalizeId = (id: string): string => id.replaceAll('-', '').toLowerCase()

/** Without a userId, resolveUser() picks an administrator: Jellyfin 10.11 rejects PlaybackInfo without one. */
export function createJellyfin(baseUrl: string, apiKey: string, userId?: string) {

    let user = userId

    const auth = `MediaBrowser Token="${apiKey}"`

    function raw(path: string, init: RequestInit = {}): Promise<Response> {
        const headers = new Headers(init.headers)
        headers.set('Authorization', auth)
        return fetch(baseUrl + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(10_000) })
    }

    async function json<T>(path: string, init?: RequestInit): Promise<T> {
        const res = await raw(path, init)
        if (!res.ok) {
            throw new Error(`Jellyfin ${res.status} on ${path.split('?')[0]}`)
        }
        return res.status === 204 ? (undefined as T) : ((await res.json()) as T)
    }

    const tmdbIndex = new Map<string, { at: number; map: Promise<Map<string, Card>> }>() // per user
    /** as: whose view of the library; Jellyfin then leaves out libraries and ratings that user may not see. */
    const listItems = (query: URLSearchParams, as = user) => {
        if (as) {
            query.set('userId', as)
        }
        return json<{ Items: JfItem[]; TotalRecordCount?: number }>(`/Items?${query}`)
    }

    return {
        raw,
        get userId() {
            return user
        },
        /** Uses the first administrator when no user was configured. */
        async resolveUser(): Promise<void> {
            if (!user) {
                const users = await json<Array<{ Id: string; Name: string; Policy?: { IsAdministrator?: boolean } }>>('/Users')
                const admin = users.find(u => u.Policy?.IsAdministrator)
                if (!admin) {
                    throw new Error('No administrator user found; set JELLYFIN_USER_ID')
                }
                user = admin.Id
                console.log(`Using Jellyfin user "${admin.Name}"`)
            }
        },
        /** Removes the api key from text headed to guests, without exposing the key itself. */
        redact: (text: string): string => text.replaceAll(apiKey, ''),
        systemInfo: () => json<{ ServerName: string; Version: string }>('/System/Info'),

        async search(term: string, as?: string): Promise<Card[]> {
            const query = new URLSearchParams({ searchTerm: term, IncludeItemTypes: 'Movie,Series,Episode', Recursive: 'true', Limit: '40' })
            return (await listItems(query, as ?? user)).Items.map(card)
        },

        /** The user's video libraries, as Jellyfin's home screen lists them. */
        async views(as?: string): Promise<Array<{ id: string; name: string }>> {
            const res = await json<{ Items: Array<{ Id: string; Name: string; CollectionType?: string }> }>(`/UserViews?${new URLSearchParams({ userId: as ?? user ?? '' })}`)
            return res.Items.filter(v => VIDEO_LIBRARIES.has(v.CollectionType ?? 'mixed')).map(v => ({ id: v.Id, name: v.Name }))
        },

        /** One page of a library's movies and shows. */
        async library(o: { parent: string; genre?: string; sort?: string; start: number }, as?: string): Promise<{ items: Card[]; total: number }> {
            const query = new URLSearchParams({
                ParentId: o.parent, IncludeItemTypes: 'Movie,Series', Recursive: 'true', Limit: String(PAGE), StartIndex: String(o.start),
                ...SORTS[o.sort ?? ''] ?? SORTS.name,
            })
            if (o.genre) {
                query.set('Genres', o.genre)
            }
            const res = await listItems(query, as ?? user)
            return { items: res.Items.map(card), total: res.TotalRecordCount ?? res.Items.length }
        },

        /** Recently added to a library, newest first. */
        async latest(parent: string, as?: string): Promise<Card[]> {
            const query = new URLSearchParams({ ParentId: parent, Limit: '24', userId: as ?? user ?? '' })
            return (await json<JfItem[]>(`/Items/Latest?${query}`)).map(card)
        },

        async genres(parent: string, as?: string): Promise<string[]> {
            const query = new URLSearchParams({ ParentId: parent, SortBy: 'SortName', userId: as ?? user ?? '' })
            return (await json<{ Items: Array<{ Name: string }> }>(`/Genres?${query}`)).Items.map(g => g.Name)
        },

        /** Seasons of a series, or episodes of a season, in order. */
        async children(id: string, as?: string): Promise<Card[]> {
            const query = new URLSearchParams({ ParentId: id, IncludeItemTypes: 'Season,Episode', IsMissing: 'false', ExcludeLocationTypes: 'Virtual', SortBy: 'ParentIndexNumber,IndexNumber,SortName' })
            return (await listItems(query, as ?? user)).Items.map(card)
        },

        /** The item's poster (or episode thumbnail), or its wide backdrop, resized by Jellyfin. */
        image: (id: string, backdrop = false) =>
            raw(`/Items/${encodeURIComponent(id)}/Images/${backdrop ? 'Backdrop?fillWidth=1600&quality=75' : 'Primary?fillWidth=320&quality=80'}`),

        /** Everything the details popup shows about one movie, show or episode. */
        async details(id: string, as?: string): Promise<Details | null> {
            const item = (await listItems(new URLSearchParams({ Ids: id, Fields: 'Overview,Genres' }), as ?? user)).Items[0]
            if (!item) {
                return null
            }
            return {
                ...card(item),
                year: item.ProductionYear ?? null,
                overview: item.Overview ?? '',
                genres: item.Genres ?? [],
                certification: item.OfficialRating ?? '',
                runtime: Math.round((item.RunTimeTicks ?? 0) / TICKS_PER_SECOND),
                backdrop: (item.BackdropImageTags?.length ?? 0) > 0,
            }
        },

        /** Library movies and shows by TMDB id ("Movie:105", "Series:1399"), to match TMDB lists. */
        byTmdb(as?: string): Promise<Map<string, Card>> {
            const who = as ?? user ?? ''
            const hit = tmdbIndex.get(who)
            if (hit && Date.now() - hit.at < INDEX_TTL_MS) {
                return hit.map
            }
            const query = new URLSearchParams({ IncludeItemTypes: 'Movie,Series', Recursive: 'true', Fields: 'ProviderIds' })
            const map = listItems(query, who || undefined).then(res => new Map(res.Items.filter(i => i.ProviderIds?.Tmdb).map(i => [`${i.Type}:${i.ProviderIds!.Tmdb}`, card(i)])))
            map.catch(() => tmdbIndex.delete(who))
            tmdbIndex.set(who, { at: Date.now(), map })
            return map
        },

        /** Which of these items the user may see. */
        async visible(ids: string[], as: string): Promise<Set<string>> {
            if (ids.length === 0) {
                return new Set()
            }
            return new Set((await listItems(new URLSearchParams({ Ids: ids.join(',') }), as)).Items.map(i => i.Id))
        },

        /** Subtitles Jellyfin's subtitle plugins (e.g. OpenSubtitles) offer for an item; lang is ISO 639-2, e.g. "eng". */
        async remoteSubtitles(itemId: string, lang: string): Promise<RemoteSubtitle[]> {
            const found = await json<Array<{ Id: string; Name?: string; ProviderName?: string; Format?: string; DownloadCount?: number; IsHashMatch?: boolean }>>(
                `/Items/${encodeURIComponent(itemId)}/RemoteSearch/Subtitles/${encodeURIComponent(lang)}`)
            return found.map(s => ({ id: s.Id, name: s.Name ?? s.Id, provider: s.ProviderName ?? '', format: s.Format ?? '', downloads: s.DownloadCount ?? 0, exact: s.IsHashMatch === true }))
        },

        /** Has Jellyfin download a remote subtitle next to the item, adding it as a subtitle stream. */
        async downloadSubtitle(itemId: string, subtitleId: string): Promise<void> {
            await json(`/Items/${encodeURIComponent(itemId)}/RemoteSearch/Subtitles/${encodeURIComponent(subtitleId)}`, { method: 'POST' })
        },

        /** Indexes of the item's subtitle streams. */
        async subtitleIndexes(itemId: string): Promise<number[]> {
            const item = (await listItems(new URLSearchParams({ Ids: itemId, Fields: 'MediaStreams' }))).Items[0] as JfItem & { MediaStreams?: Array<{ Type: string; Index: number }> }
            return (item?.MediaStreams ?? []).filter(s => s.Type === 'Subtitle').map(s => s.Index)
        },

        /** Checks a Jellyfin username and password; the Jellyfin session it opens is closed again right away. */
        async authenticate(name: string, password: string): Promise<Account | null> {
            const res = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', Authorization: 'MediaBrowser Client="Bloom", Device="Bloom", DeviceId="bloom-login", Version="1.0"' },
                body: JSON.stringify({ Username: name, Pw: password }),
                signal: AbortSignal.timeout(10_000),
            })
            if (!res.ok) {
                return null
            }
            const { User, AccessToken } = await res.json() as { User: JfUser; AccessToken: string }
            fetch(`${baseUrl}/Sessions/Logout`, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${AccessToken}"` } }).catch(() => {})
            return User.Policy?.IsDisabled ? null : account(User)
        },

        /** Jellyfin's enabled users. */
        async accounts(): Promise<Account[]> {
            return (await json<JfUser[]>('/Users')).filter(u => !u.Policy?.IsDisabled).map(account)
        },

        /** Saves how far a user got in an item, the way Jellyfin's own players leave it. */
        async saveProgress(userId: string, itemId: string, position: number, runtime: number): Promise<void> {
            const data = userData(position, runtime)
            if (data) {
                await json(`/UserItems/${encodeURIComponent(itemId)}/UserData?${new URLSearchParams({ userId })}`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, LastPlayedDate: new Date().toISOString() }),
                })
            }
        },

        /** The user's half-watched movies and episodes, most recent first, with how far they got (0–100). */
        async resume(userId: string): Promise<Array<Card & { progress: number }>> {
            const query = new URLSearchParams({ userId, Limit: '24', MediaTypes: 'Video', EnableUserData: 'true' })
            const res = await json<{ Items: Array<JfItem & { UserData?: { PlayedPercentage?: number } }> }>(`/UserItems/Resume?${query}`)
            return res.Items.map(i => ({ ...card(i), progress: Math.round(i.UserData?.PlayedPercentage ?? 0) }))
        },

        /** Where the user left off in an item, in seconds; 0 when not started or watched. */
        async resumePosition(userId: string, itemId: string): Promise<number> {
            const data = await json<{ PlaybackPositionTicks?: number }>(`/UserItems/${encodeURIComponent(itemId)}/UserData?${new URLSearchParams({ userId })}`)
            return (data.PlaybackPositionTicks ?? 0) / TICKS_PER_SECOND
        },

        /** Intro, recap, credits and preview ranges in seconds; empty without a segment plugin such as Intro Skipper. */
        async segments(itemId: string): Promise<Segment[]> {
            const res = await json<{ Items: Array<{ Type: string; StartTicks: number; EndTicks: number }> }>(`/MediaSegments/${encodeURIComponent(itemId)}`)
            return res.Items.filter(s => SKIPPABLE.has(s.Type))
                .map(s => ({ type: s.Type, start: s.StartTicks / TICKS_PER_SECOND, end: s.EndTicks / TICKS_PER_SECOND }))
        },

        /** The episode after this one in its show, or null for a movie or a show's last episode. */
        async nextEpisode(itemId: string, as?: string): Promise<QueueItem | null> {
            const item = (await listItems(new URLSearchParams({ Ids: itemId }), as ?? user)).Items[0]
            if (item?.Type !== 'Episode' || !item.SeriesId) {
                return null
            }
            const query = new URLSearchParams({ userId: as ?? user ?? '', startItemId: item.Id, Limit: '2', IsMissing: 'false' })
            const next = (await json<{ Items: JfItem[] }>(`/Shows/${encodeURIComponent(item.SeriesId)}/Episodes?${query}`)).Items[1]
            return next ? { id: next.Id, name: label(next), runtime: (next.RunTimeTicks ?? 0) / TICKS_PER_SECOND } : null
        },

        /** Resolves a movie/episode to itself and a series/season to its episodes in order. */
        async queueItems(id: string, as?: string): Promise<QueueItem[]> {
            if (!/^[0-9a-f-]{32,36}$/i.test(id)) {
                return [] // an empty Ids filter would list the whole library
            }
            const found = await listItems(new URLSearchParams({ Ids: id }), as ?? user)
            const item = found.Items[0]
            if (!item || !PLAYABLE.has(item.Type)) {
                return []
            }
            let items = [item]
            if (item.Type === 'Series' || item.Type === 'Season') {
                const query = new URLSearchParams({ ParentId: item.Id, IncludeItemTypes: 'Episode', Recursive: 'true', IsMissing: 'false', ExcludeLocationTypes: 'Virtual', SortBy: 'ParentIndexNumber,IndexNumber' })
                items = (await listItems(query, as ?? user)).Items
            }
            return items.map(i => ({ id: i.Id, name: label(i), runtime: (i.RunTimeTicks ?? 0) / TICKS_PER_SECOND }))
        },

    }
}

const PAGE = 60
type JfUser = { Id: string; Name: string; Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean } }
const account = (u: JfUser): Account => ({ id: u.Id, name: u.Name, admin: u.Policy?.IsAdministrator === true })

/** Jellyfin's default resume rules: under 5% isn't progress, past 90% counts as watched. */
export function userData(position: number, runtime: number): { PlaybackPositionTicks: number; Played?: true } | null {
    const pct = runtime > 0 ? position / runtime : 0
    if (pct < 0.05) {
        return null
    }
    return pct > 0.9 ? { PlaybackPositionTicks: 0, Played: true } : { PlaybackPositionTicks: Math.round(position * TICKS_PER_SECOND) } // rewatching keeps "watched"
}
const SKIPPABLE = new Set(['Intro', 'Recap', 'Outro', 'Preview'])
const PLAYABLE = new Set(['Movie', 'Episode', 'Series', 'Season'])
const INDEX_TTL_MS = 10 * 60_000
const VIDEO_LIBRARIES = new Set(['movies', 'tvshows', 'mixed', 'homevideos'])
const SORTS: Record<string, Record<string, string>> = {
    name: { SortBy: 'SortName', SortOrder: 'Ascending' },
    added: { SortBy: 'DateCreated,SortName', SortOrder: 'Descending' },
    year: { SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' },
    rating: { SortBy: 'CommunityRating,SortName', SortOrder: 'Descending' },
}

/** What the host's catalogue shows: title, a line below it, and the full label used in the queue. */
export type Card = { id: string; name: string; type: string; title: string; subtitle: string; rating: number | null }

export type Segment = { type: string; start: number; end: number }

export type RemoteSubtitle = { id: string; name: string; provider: string; format: string; downloads: number; exact: boolean }

export type Details =Card & { year: number | null; overview: string; genres: string[]; certification: string; runtime: number; backdrop: boolean }

function card(i: JfItem): Card {
    const subtitle = i.Type === 'Episode' ? [i.SeriesName, episodeCode(i)].filter(Boolean).join(' · ')
        : i.Type === 'Season' ? (i.SeriesName ?? '')
        : String(i.ProductionYear ?? '')
    const rating = i.CommunityRating ? Math.round(i.CommunityRating * 10) / 10 : null
    return { id: i.Id, name: label(i), type: i.Type, title: i.Name, subtitle, rating }
}

/** S01E02; just S01 when the library lacks the episode number, never a made-up E00. */
function episodeCode(i: JfItem): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const season = i.ParentIndexNumber == null ? '' : `S${pad(i.ParentIndexNumber)}`
    return i.IndexNumber == null ? season : `${season}E${pad(i.IndexNumber)}`
}

function label(i: JfItem): string {
    if (i.Type === 'Episode') {
        return [i.SeriesName, episodeCode(i)].filter(Boolean).join(' ') + ` – ${i.Name}`
    }
    if (i.Type === 'Season') {
        return `${i.SeriesName} – ${i.Name}`
    }
    return i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name
}
