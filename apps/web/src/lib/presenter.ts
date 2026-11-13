// Piece 12: this device's presenter unlock (voice is kept for live demos). voice-session/unlock
// returns a signed 7-day token; it lives only here, in this browser, and travels in the body of
// voice-session calls. /app and /demo share it (same origin), so unlocking on /demo (staff login)
// also unlocks the phone frame. Storage can be missing (private mode): then the device just stays locked.
const KEY = 'plus-presenter'

export type Unlock = { token: string; expires_at: string }

export function presenterUnlock(): Unlock | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const u = JSON.parse(raw) as Unlock
    if (typeof u?.token !== 'string' || !(Date.parse(u.expires_at) > Date.now())) {
      localStorage.removeItem(KEY)
      return null
    }
    return u
  } catch {
    return null
  }
}

export function savePresenterUnlock(u: Unlock) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token: u.token, expires_at: u.expires_at }))
  } catch {
    // no storage: nothing to keep
  }
}

export function clearPresenterUnlock() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // nothing stored
  }
}

/** The extra body field every voice-session call carries. */
export const presenterBody = (): Record<string, unknown> => {
  const u = presenterUnlock()
  return u ? { presenter_token: u.token } : {}
}

/** The demo video (Vercel env VITE_DEMO_VIDEO_URL); null hides the button. */
export const DEMO_VIDEO_URL: string | null = (() => {
  const v = (import.meta.env.VITE_DEMO_VIDEO_URL as string | undefined)?.trim()
  return v && /^https:\/\//.test(v) ? v : null
})()
