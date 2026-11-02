import type { QueueItem } from './room.ts'

export const TICKS_PER_SECOND = 10_000_000

export type JfSession = {
    Id: string
    DeviceName: string
    Client: string
    UserName?: string
    SupportsRemoteControl: boolean
    LastPlaybackCheckIn?: string
    NowPlayingItem?: { Id: string; Name?: string }
    PlayState?: { PositionTicks?: number; IsPaused?: boolean }
}

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

/** Requires Jellyfin 10.9+ (user-less /Items with an API key) unless userId is given. */
export function createJellyfin(baseUrl: string, apiKey: string, userId = process.env.JELLYFIN_USER_ID || undefined) {

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

    async function post(path: string): Promise<void> {
        await json<void>(path, { method: 'POST' })
    }

    const session = (id: string) => `/Sessions/${encodeURIComponent(id)}/Playing`
    const ticks = (seconds: number) => String(Math.round(seconds * TICKS_PER_SECOND))
    const listItems = (query: URLSearchParams) => {
        if (userId) {
            query.set('userId', userId)
        }
        return json<{ Items: JfItem[] }>(`/Items?${query}`)
    }

    return {
        raw,
        userId,
        systemInfo: () => json<{ ServerName: string; Version: string }>('/System/Info'),

        async search(term: string): Promise<Array<{ id: string; name: string; type: string }>> {
            const query = new URLSearchParams({ searchTerm: term, IncludeItemTypes: 'Movie,Series,Season,Episode', Recursive: 'true', Limit: '25' })
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

        sessions: () => json<JfSession[]>('/Sessions'),
        playNow: (sessionId: string, itemId: string, position: number) =>
            post(`${session(sessionId)}?${new URLSearchParams({ playCommand: 'PlayNow', itemIds: itemId, startPositionTicks: ticks(position) })}`),
        pause: (sessionId: string) => post(`${session(sessionId)}/Pause`),
        unpause: (sessionId: string) => post(`${session(sessionId)}/Unpause`),
        seek: (sessionId: string, position: number) => post(`${session(sessionId)}/Seek?seekPositionTicks=${ticks(position)}`),
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
