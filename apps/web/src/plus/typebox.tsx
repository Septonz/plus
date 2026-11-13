// Piece 13, item 2: Type to Plus. What she types goes to the text-command function: a fixed parser
// (no AI model, no ElevenLabs) and then the same actions the voice agent calls. Money is only
// prepared here; the confirm sheet opens for her Yes (and PIN where needed), exactly as by voice.
// Used in the live voice sheet ("Type instead") and in the sheet a locked mic opens (guests' and the
// public's way to talk to Plus).
import { useState, type FormEvent } from 'react'
import { Button, Icon } from '../ds/components'
import { call } from './api'
import { clientTools } from './screen'

type Answer = {
  kind?: 'tool' | 'navigate' | 'ask' | 'unknown'
  tool?: string
  screen?: string
  echo?: string
  text?: string | null
  options?: string[]
  suggestions?: string[]
  result?: { action_id?: string }
  error?: string
}
type Turn = { id: number; you: string; plus: string; chips: string[] }

/** The app reloads its data (and opens the confirm sheet) when a typed command prepared something. */
export const REFRESH_EVENT = 'plus:refresh'

let nextId = 1

export function TypeToPlus({ placeholder = 'Type what you need, like “pay Iya Tunde 2k”', autoFocus = false }: { placeholder?: string; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])

  const send = async (said: string) => {
    const t = said.trim()
    if (!t || busy) return
    setBusy(true)
    setText('')
    let plus = ''
    let chips: string[] = []
    try {
      const a = await call<Answer>('text-command', { text: t })
      if (a.kind === 'navigate' && a.screen) {
        await clientTools().navigate?.({ screen: a.screen })
        plus = a.echo ?? 'Opening it.'
      } else if (a.kind === 'ask') {
        plus = a.text ?? ''
        chips = a.options ?? []
      } else if (a.kind === 'unknown') {
        plus = a.text ?? 'I didn’t catch that. Try one of these:'
        chips = a.suggestions ?? []
      } else {
        plus = a.text ?? a.echo ?? (a.error ? 'That didn’t work. Try again.' : '')
        if (a.result?.action_id) window.dispatchEvent(new Event(REFRESH_EVENT))
      }
    } catch {
      plus = 'That didn’t work. Check your connection and try again.'
    }
    setTurns((x) => [...x.slice(-3), { id: nextId++, you: t, plus, chips }])
    setBusy(false)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void send(text)
  }

  return (
    <div className="space-y-3">
      {turns.length > 0 && (
        <ul className="space-y-2" aria-live="polite" aria-label="Typed conversation">
          {turns.map((t) => (
            <li key={t.id} className="space-y-1.5">
              <p className="text-right"><span className="inline-block max-w-[85%] rounded-[1.1rem] bg-accent px-3.5 py-2 text-base text-on-accent">{t.you}</span></p>
              {t.plus && <p><span className="inline-block max-w-[85%] rounded-[1.1rem] bg-fill px-3.5 py-2 text-base text-label">{t.plus}</span></p>}
              {t.chips.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {t.chips.map((c) => (
                    <button key={c} type="button" onClick={() => void send(c)}
                      className="min-h-14 rounded-full border border-hairline px-4 text-base text-accent-ink active:bg-fill">
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="flex items-center gap-2">
        <label className="sr-only" htmlFor="type-to-plus">Type to Plus</label>
        <input id="type-to-plus" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
          maxLength={200} autoComplete="off" enterKeyHint="send"
          className="min-h-14 min-w-0 flex-1 rounded-full border border-hairline bg-canvas px-4 text-base text-label placeholder:text-secondary focus-visible:outline-2 focus-visible:outline-accent" />
        <Button type="submit" size="md" loading={busy} disabled={!text.trim()} ariaLabel="Send" className="min-h-14 min-w-14 !px-4"><Icon name="send" /></Button>
      </form>
    </div>
  )
}
