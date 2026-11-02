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
        return json<{ Items: JfItem[] }>(`/Items?${query}`)
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

        async search(term: string): Promise<Array<{ id: string; name: string; type: string }>> {
            const query = new URLSearchParams({ searchTerm: term, IncludeItemTypes: 'Movie,Series,Season,Episode', Recursive: 'true', Limit: '25' })
            const res = await listItems(query)
            return res.Items.map(i => ({ id: i.Id, name: label(i), type: i.Type }))
        },

        /** Seasons of a series, or episodes of a season, in order. */
        async children(id: string): Promise<Array<{ id: string; name: string; type: string }>> {
            const query = new URLSearchParams({ ParentId: id, IncludeItemTypes: 'Season,Episode', IsMissing: 'false', ExcludeLocationTypes: 'Virtual', SortBy: 'ParentIndexNumber,IndexNumber,SortName' })
            const res = await listItems(query)
            return res.Items.map(i => ({ id: i.Id, name: label(i), type: i.Type }))
        },

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
