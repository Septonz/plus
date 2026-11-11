// One way to show a time: 12-hour ("Tuesday 10:32 pm"). Chrome's en-NG locale defaults to 24-hour,
// so every time on screen goes through here.
export function formatTime(
  input: string | number | Date,
  o: { weekday?: 'short' | 'long'; date?: boolean; seconds?: boolean; locale?: string } = {},
): string {
  return new Date(input).toLocaleString(o.locale ?? 'en-NG', {
    ...(o.weekday ? { weekday: o.weekday } : {}),
    ...(o.date ? { day: 'numeric', month: 'short' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    ...(o.seconds ? { second: '2-digit' } : {}),
    hour12: true,
  })
}
