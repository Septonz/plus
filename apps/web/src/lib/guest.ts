// Piece 12: public test mode on this device. "Try Plus now" and "Try the agent app" ask
// agent-tools/guest_start for a guest account (the same one again for 2 hours on this device),
// then sign in with the one-time token it returns. The device id is random and only identifies
// this browser to the guest pool; nothing else is stored.
import { supabase } from './supabase'
import { tool } from '../plus/api'

const DEVICE_KEY = 'plus-device'
const NOTICE_KEY = 'plus-guest-notice'

function deviceId(): string {
  try {
    const have = localStorage.getItem(DEVICE_KEY)
    if (have && /^[A-Za-z0-9_-]{16,100}$/.test(have)) return have
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    // No storage (private mode): a fresh id each time; the pool still works.
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
  }
}

export type GuestStart = { ok?: boolean; text?: string; error?: string; sign_in_token?: string; notice?: string; name?: string }

/** Sign in as a guest trader or guest agent; resolves with an error text, or null when signed in. */
export async function startGuest(kind: 'trader' | 'agent'): Promise<string | null> {
  if (!supabase) return 'This test link is not set up yet.'
  const r = await tool<GuestStart>('guest_start', { kind, device_id: deviceId() }).catch((): GuestStart => ({ ok: false, text: 'No connection. Try again.' }))
  if (!r.ok || !r.sign_in_token) return r.text ?? 'The test accounts are busy. Try again in a minute.'
  await supabase.auth.signOut().catch(() => undefined)
  const { error } = await supabase.auth.verifyOtp({ token_hash: r.sign_in_token, type: 'magiclink' })
  if (error) return 'That didn’t work. Try again.'
  try {
    if (r.notice) sessionStorage.setItem(NOTICE_KEY, r.notice)
    else sessionStorage.removeItem(NOTICE_KEY)
  } catch {
    // no storage: no notice
  }
  return null
}

/** "Someone else may be testing this account too", once, after a busy hand-over. */
export function takeGuestNotice(): string | null {
  try {
    const n = sessionStorage.getItem(NOTICE_KEY)
    sessionStorage.removeItem(NOTICE_KEY)
    return n
  } catch {
    return null
  }
}

/** The Home checklist, dismissed on this device. */
export const checklistDismissed = (): boolean => {
  try {
    return localStorage.getItem('plus-guest-checklist') === 'off'
  } catch {
    return false
  }
}
export function dismissChecklist() {
  try {
    localStorage.setItem('plus-guest-checklist', 'off')
  } catch {
    // nothing stored
  }
}

export const GUEST_STEPS: { key: string; title: string; how: string }[] = [
  { key: 'balance', title: 'Check your balance and activity', how: 'Home, then the Activity tab' },
  { key: 'shop', title: 'Pay a shop', how: 'Pay → Scan → Mama Put Canteen' },
  { key: 'save', title: 'Save ₦1,000 toward your goal', how: 'Home → Savings → Save' },
  { key: 'loan', title: 'Open the loan offer and accept it', how: 'Home → Loan · PIN 1234' },
  { key: 'share', title: 'Share your record and open it on /verify', how: 'Activity → Share my record' },
  { key: 'cashout', title: 'Get a cash-out code', how: 'Home → Wallet → Cash out' },
]
