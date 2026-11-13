// Piece 12: what only a guest (a public test account) sees. Presenter accounts and real accounts
// never render any of it: everything here is behind useGuest(), which reads get_user's `guest`.
import { createContext, useContext, useEffect, useState } from 'react'
import { Button, Card, Icon, Notice, Section } from '../ds/components'
import { checklistDismissed, dismissChecklist, GUEST_STEPS, takeGuestNotice } from '../lib/guest'
import { tool, type ToolResult } from '../plus/api'
import { useRecordingMode } from '../lib/recording'

export const GuestContext = createContext(false)
export const useGuest = () => useContext(GuestContext)
export const TEST_PIN_HINT = 'Test PIN: 1234'

/** Whether she is a guest: get_user's flag, read once per sign-in. */
export function useGuestFlag(userId: string | undefined): boolean {
  const [guest, setGuest] = useState(false)
  useEffect(() => {
    if (!userId) return
    let live = true
    void tool('get_user').then((r) => live && setGuest(r.guest === true)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [userId])
  return guest
}

type Status = ToolResult & { steps?: { key: string; done: boolean }[]; ready?: boolean; shop_code?: string | null; phone?: string | null }

function useGuestStatus(version: number, seen?: string) {
  const [s, setS] = useState<Status | null>(null)
  useEffect(() => {
    let live = true
    void tool<Status>('guest_status', seen ? { seen } : {}).then((r) => live && setS(r)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [version, seen])
  return s
}

/** Home: the 6 test steps, ticked from what she has done (dismissible on this device). */
export function GuestChecklist({ version }: { version: number }) {
  const guest = useGuest()
  const [hidden, setHidden] = useState(checklistDismissed)
  const [notice] = useState(takeGuestNotice)
  const s = useGuestStatus(version)
  const recording = useRecordingMode()
  if (!guest || recording) return null
  const done = new Set((s?.steps ?? []).filter((x) => x.done).map((x) => x.key))
  return (
    <>
      {notice && <Notice tone="warning">{notice}</Notice>}
      {s && s.ready === false && <Notice tone="info">Your test account is being set up on Stellar. Balances settle in a minute or two.</Notice>}
      {!hidden && (
        <Section title={`Test it in 2 minutes · ${done.size} of ${GUEST_STEPS.length}`} action={<button onClick={() => { dismissChecklist(); setHidden(true) }} className="min-h-11 px-2 text-base text-accent-ink">Hide</button>}>
          <Card>
            <ol className="space-y-3">
              {GUEST_STEPS.map((x, i) => (
                <li key={x.key} className="flex gap-3">
                  <span className={`grid size-7 shrink-0 place-items-center rounded-full text-sm font-semibold ${done.has(x.key) ? 'bg-accent text-on-accent' : 'bg-fill text-secondary'}`} aria-label={done.has(x.key) ? 'Done' : `Step ${i + 1}`}>
                    {done.has(x.key) ? <Icon name="check" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-base font-medium leading-snug ${done.has(x.key) ? 'text-secondary line-through' : ''}`}>{x.title}</span>
                    <span className="block text-sm text-secondary">{x.how}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-secondary">Test account{s?.phone ? ` · phone ${s.phone}` : ''} · PIN 1234 · Stellar testnet, no real money.</p>
          </Card>
        </Section>
      )}
    </>
  )
}

/** Activity: opening it ticks step 1 (logged by guest_status with seen=activity). */
export function GuestSeen({ what, version }: { what: string; version: number }) {
  const guest = useGuest()
  useEffect(() => {
    if (guest) void tool('guest_status', { seen: what }).catch(() => undefined)
  }, [guest, what, version])
  return null
}

/** A guest-only test button with its own result line. */
function Pretend({ label, toolName, body, onDone }: { label: string; toolName: string; body?: Record<string, unknown>; onDone?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<ToolResult | null>(null)
  return (
    <div className="space-y-2">
      <Button variant="secondary" className="w-full" loading={busy} onClick={async () => {
        setBusy(true)
        const r = await tool(toolName, body ?? {}).catch((): ToolResult => ({ ok: false, text: 'No connection. Try again.' }))
        setBusy(false)
        setMsg(r)
        if (r.ok) onDone?.()
      }}>{label}</Button>
      {msg && <Notice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</Notice>}
    </div>
  )
}

/** Add money: a real cash-in from the shared demo agent, waiting for her Yes. */
export function GuestCashIn({ onDone }: { onDone?: () => void }) {
  if (!useGuest()) return null
  return (
    <Section title="Test account">
      <Pretend label="Pretend Mama Bisi recorded ₦5,000 cash for you" toolName="guest_cash_in" onDone={onDone} />
    </Section>
  )
}

/** Cash out: the shared demo agent pays out her newest code (its float takes the money on Stellar). */
export function GuestPaidOut({ cashOutId, onDone }: { cashOutId: string; onDone?: () => void }) {
  if (!useGuest()) return null
  return <Pretend label="Pretend an agent paid this out" toolName="guest_agent_paid" body={{ cash_out_id: cashOutId }} onDone={onDone} />
}

/** Scan: the test shop's pay code, one tap to fill it in. */
export function GuestShop({ version, onUse }: { version: number; onUse: (code: string) => void }) {
  const guest = useGuest()
  const s = useGuestStatus(version)
  if (!guest || !s?.shop_code) return null
  const code = String(s.shop_code)
  return (
    <Card className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-base font-medium">Mama Put Canteen</p>
        <p className="text-sm text-secondary">Test shop · pay code <span className="num font-mono">{code.slice(0, 3)}-{code.slice(3)}</span></p>
      </div>
      <Button size="sm" onClick={() => onUse(code)}>Use</Button>
    </Card>
  )
}

/** Activity: open a fresh share code on /verify, prefilled. */
export function GuestVerifyLink({ code }: { code: string }) {
  if (!useGuest()) return null
  return (
    <a href={`/verify?code=${encodeURIComponent(code)}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 text-base font-medium text-accent-ink">
      Open this in /verify <Icon name="link" />
    </a>
  )
}
