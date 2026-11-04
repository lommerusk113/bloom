// Things Bloom sends outside itself: Discord webhook posts and calendar invites.

/** Posts to a Discord channel webhook; mentions are disabled so a title can't ping @everyone. Best effort. */
export function postToDiscord(webhookUrl: string, text: string): void {
    fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'Bloom', content: text, allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(8000),
    }).then((res) => {
        if (!res.ok) {
            console.error(`Discord webhook: ${res.status}`)
        }
    }, err => console.error('Discord webhook failed:', err.message))
}

/** A calendar invite (iCalendar) for a two-hour event with a reminder 15 minutes before. uid must be stable per event. */
export function icsEvent(o: { uid: string; start: number; title: string; description: string }, now = Date.now()): string {
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    const text = (value: string) => value.replace(/[\;,]/g, m => `\\${m}`).replace(/\n/g, '\\n')
    return [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bloom//Movie night//EN', 'BEGIN:VEVENT',
        `UID:${o.uid}@bloom`, `DTSTAMP:${stamp(now)}`,
        `DTSTART:${stamp(o.start)}`, `DTEND:${stamp(o.start + 2 * 3600_000)}`,
        `SUMMARY:${text(o.title)}`, `DESCRIPTION:${text(o.description)}`,
        'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Movie night soon', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n')
}
