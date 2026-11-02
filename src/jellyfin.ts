import type { QueueItem } from './room.ts'

export const TICKS_PER_SECOND = 10_000_000

type JfItem = {
    Id: string
    Name: string
    Type: string
    SeriesName?: string
    ParentIndexNumber?: number
    IndexNumber?: number
    RunTimeTicks?: number
    ProductionYear?: number
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

    const listItems = (query: URLSearchParams) => {
        if (user) {
            query.set('userId', user)
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

        async search(term: string): Promise<Card[]> {
            const query = new URLSearchParams({ searchTerm: term, IncludeItemTypes: 'Movie,Series,Episode', Recursive: 'true', Limit: '40' })
            return (await listItems(query)).Items.map(card)
        },

        /** The user's video libraries, as Jellyfin's home screen lists them. */
        async views(): Promise<Array<{ id: string; name: string }>> {
            const res = await json<{ Items: Array<{ Id: string; Name: string; CollectionType?: string }> }>(`/UserViews?${new URLSearchParams({ userId: user ?? '' })}`)
            return res.Items.filter(v => VIDEO_LIBRARIES.has(v.CollectionType ?? 'mixed')).map(v => ({ id: v.Id, name: v.Name }))
        },

        /** One page of a library's movies and shows. */
        async library(o: { parent: string; genre?: string; sort?: string; start: number }): Promise<{ items: Card[]; total: number }> {
            const query = new URLSearchParams({
                ParentId: o.parent, IncludeItemTypes: 'Movie,Series', Recursive: 'true', Limit: String(PAGE), StartIndex: String(o.start),
                ...SORTS[o.sort ?? ''] ?? SORTS.name,
            })
            if (o.genre) {
                query.set('Genres', o.genre)
            }
            const res = await listItems(query)
            return { items: res.Items.map(card), total: res.TotalRecordCount ?? res.Items.length }
        },

        /** Recently added to a library, newest first. */
        async latest(parent: string): Promise<Card[]> {
            const query = new URLSearchParams({ ParentId: parent, Limit: '24', userId: user ?? '' })
            return (await json<JfItem[]>(`/Items/Latest?${query}`)).map(card)
        },

        async genres(parent: string): Promise<string[]> {
            const query = new URLSearchParams({ ParentId: parent, SortBy: 'SortName', userId: user ?? '' })
            return (await json<{ Items: Array<{ Name: string }> }>(`/Genres?${query}`)).Items.map(g => g.Name)
        },

        /** Seasons of a series, or episodes of a season, in order. */
        async children(id: string): Promise<Card[]> {
            const query = new URLSearchParams({ ParentId: id, IncludeItemTypes: 'Season,Episode', IsMissing: 'false', ExcludeLocationTypes: 'Virtual', SortBy: 'ParentIndexNumber,IndexNumber,SortName' })
            return (await listItems(query)).Items.map(card)
        },

        /** The item's poster (or episode thumbnail), resized by Jellyfin. */
        image: (id: string) => raw(`/Items/${encodeURIComponent(id)}/Images/Primary?fillWidth=320&quality=80`),

        /** Resolves a movie/episode to itself and a series/season to its episodes in order. */
        async queueItems(id: string): Promise<QueueItem[]> {
            const found = await listItems(new URLSearchParams({ Ids: id }))
            const item = found.Items[0]
            if (!item) {
                return []
            }
            let items = [item]
            if (item.Type === 'Series' || item.Type === 'Season') {
                const query = new URLSearchParams({ ParentId: item.Id, IncludeItemTypes: 'Episode', Recursive: 'true', IsMissing: 'false', ExcludeLocationTypes: 'Virtual', SortBy: 'ParentIndexNumber,IndexNumber' })
                items = (await listItems(query)).Items
            }
            return items.map(i => ({ id: i.Id, name: label(i), runtime: (i.RunTimeTicks ?? 0) / TICKS_PER_SECOND }))
        },

    }
}

const PAGE = 60
const VIDEO_LIBRARIES = new Set(['movies', 'tvshows', 'mixed', 'homevideos'])
const SORTS: Record<string, Record<string, string>> = {
    name: { SortBy: 'SortName', SortOrder: 'Ascending' },
    added: { SortBy: 'DateCreated,SortName', SortOrder: 'Descending' },
    year: { SortBy: 'ProductionYear,SortName', SortOrder: 'Descending' },
    rating: { SortBy: 'CommunityRating,SortName', SortOrder: 'Descending' },
}

/** What the host's catalogue shows: title, a line below it, and the full label used in the queue. */
export type Card = { id: string; name: string; type: string; title: string; subtitle: string }

function card(i: JfItem): Card {
    const pad = (n?: number) => String(n ?? 0).padStart(2, '0')
    const subtitle = i.Type === 'Episode' ? `${i.SeriesName ?? ''} · S${pad(i.ParentIndexNumber)}E${pad(i.IndexNumber)}`
        : i.Type === 'Season' ? (i.SeriesName ?? '')
        : String(i.ProductionYear ?? '')
    return { id: i.Id, name: label(i), type: i.Type, title: i.Name, subtitle }
}

function label(i: JfItem): string {
    const pad = (n?: number) => String(n ?? 0).padStart(2, '0')
    if (i.Type === 'Episode') {
        return `${i.SeriesName} S${pad(i.ParentIndexNumber)}E${pad(i.IndexNumber)} – ${i.Name}`
    }
    if (i.Type === 'Season') {
        return `${i.SeriesName} – ${i.Name}`
    }
    return i.ProductionYear ? `${i.Name} (${i.ProductionYear})` : i.Name
}
