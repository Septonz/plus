// Piece 12: the quiet "Presenter" link at the foot of Profile. A presenter types the presenter code
// once; voice-session checks it (constant time) and returns a 7-day token kept on this device only.
// Nothing else in the app hints that it exists.
import { useState } from 'react'
import { Button, Notice, Sheet } from '../ds/components'
import { clearPresenterUnlock, presenterBody, presenterUnlock, savePresenterUnlock } from '../lib/presenter'
import { call } from './api'
import { TextField } from './ui'

export function PresenterLink() {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [unlock, setUnlock] = useState(presenterUnlock)

  async function submit() {
    setBusy(true)
    setMsg(null)
    type Unlocked = { ok?: boolean; presenter_token?: string; expires_at?: string; text?: string }
    const r = await call<Unlocked>('voice-session/unlock', { code }).catch((): Unlocked => ({ ok: false, text: 'No connection. Try again.' }))
    setBusy(false)
    setCode('')
    if (!r.ok || !r.presenter_token || !r.expires_at) return setMsg(r.text ?? 'That didn’t work.')
    savePresenterUnlock({ token: r.presenter_token, expires_at: r.expires_at })
    // The mic reads its status once per page: reload so it picks up the unlock.
    window.location.reload()
  }

  async function lock() {
    setBusy(true)
    await call('voice-session/lock', presenterBody()).catch(() => null)
    clearPresenterUnlock()
    setUnlock(null)
    setBusy(false)
    window.location.reload()
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="mx-auto block min-h-11 px-3 text-sm text-tertiary">Presenter</button>
      <Sheet open={open} onClose={() => setOpen(false)} label="Presenter">
        <div className="space-y-4 px-5 pt-1">
          <h2 className="text-2xl font-semibold">Presenter</h2>
          {unlock ? (
            <>
              <Notice tone="success">Voice is unlocked on this device until {new Date(unlock.expires_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}.</Notice>
              <Button variant="secondary" className="w-full" loading={busy} onClick={() => void lock()}>Lock this device</Button>
            </>
          ) : (
            <>
              <p className="text-base text-secondary">Unlock voice on this device for a live demo.</p>
              <TextField label="Presenter code" value={code} onChange={setCode} autoComplete="off" type="password" />
              {msg && <Notice tone="danger">{msg}</Notice>}
              <Button className="w-full" loading={busy} disabled={code.trim().length < 6} onClick={() => void submit()}>Unlock voice</Button>
            </>
          )}
          <Button variant="plain" className="w-full" onClick={() => setOpen(false)}>Close</Button>
        </div>
      </Sheet>
    </>
  )
}
