// The microphone. Tap: voice-session (verifies her login, returns a signed URL for the private
// ElevenLabs agent and a 15-minute plus_session token), then the official React SDK starts the
// conversation with plus_session as a dynamic variable. Every tool call the agent makes carries
// plus_session back to agent-tools, so the agent can only act for her.
// The PIN never goes through here: it is typed on the confirm sheet.
// During sign-up there is no login yet: the screen passes { onboarding_token } as `body`, and
// voice-session gives the agent a plus_session for that sign-up only.
// Before showing the mic it asks voice-session/status whether her market's agent is set up; if
// not, the mic shows "Voice coming soon" instead of failing.
//
// Variants: 'float' (the app: a round button bottom centre, above the nav; while live, a
// translucent sheet shows the conversation as text and what the agent is doing), 'inline' (sign-up:
// a mic beside a short line).
import { useConversation } from '@elevenlabs/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Icon, spring } from '../ds/components'
import { call } from './api'
import { useT } from './ui'

type Session = { signed_url?: string; plus_session?: string; error?: string }

export type MicWords = { mic: string; micListening: string; micSpeaking: string; micConnecting: string; micStop: string; micError: string; micSoon: string }

// One status check per page load (per login or sign-up), shared by every mic button on the page.
const statusOnce = new Map<string, Promise<boolean | null>>()
function voiceConfigured(body?: Record<string, unknown>): Promise<boolean | null> {
  const key = JSON.stringify(body ?? {})
  let p = statusOnce.get(key)
  if (!p) {
    p = call<{ configured?: boolean }>('voice-session/status', body)
      .then((r) => (typeof r.configured === 'boolean' ? r.configured : null))
      .catch(() => null)
    statusOnce.set(key, p)
  }
  return p
}

/** What the agent is doing, from the tool it just called. */
const DOING: Record<string, string> = {
  get_user: 'Checking your account…',
  get_balance: 'Checking your balance…',
  what_arrived: 'Looking at what came in…',
  prepare_pay: 'Preparing your payment…',
  prepare_ajo_contribution: 'Preparing your ajo payment…',
  prepare_group_contribution: 'Preparing your seettu payment…',
  prepare_advance: 'Preparing your advance…',
  prepare_cashout: 'Preparing a cash-out code…',
  set_auto_save: 'Preparing the auto-save change…',
  confirm_action: 'Confirming…',
  reject_action: 'Cancelling…',
  group_status: 'Checking your group…',
  my_record: 'Reading your history…',
  advance_status: 'Checking what you can borrow…',
  cash_outs: 'Checking your cash-out codes…',
  bank_details: 'Getting your account number…',
  save_payee: 'Saving this person…',
  start_onboarding: 'Opening your sign-up…',
  set_profile: 'Saving your details…',
  send_phone_code: 'Sending the code…',
  verify_phone_code: 'Checking the code…',
  create_wallet: 'Opening your wallet…',
}

type Line = { id: string; who: 'you' | 'plus'; text: string }

function useVoice(body: Record<string, unknown> | undefined, errorText: string) {
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [lines, setLines] = useState<Line[]>([])
  const [doing, setDoing] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void voiceConfigured(body).then((c) => live && setConfigured(c))
    return () => {
      live = false
    }
  }, [body])
  const conversation = useConversation({
    onError: (message: unknown) => {
      console.error('voice error', message)
      setError(errorText)
    },
    onMessage: (m: { message: string; source?: string; role?: string; event_id?: number }) => {
      const who = (m.role ?? m.source) === 'user' ? 'you' : 'plus'
      if (who === 'plus') setDoing(null)
      setLines((ls) => [...ls.slice(-11), { id: `${m.event_id ?? Date.now()}-${who}-${ls.length}`, who, text: m.message }])
    },
    onAgentToolRequest: (p: { tool_name?: string }) => setDoing(DOING[p.tool_name ?? ''] ?? 'Working on it…'),
    onDisconnect: () => setDoing(null),
  })
  const live = conversation.status === 'connected'
  const busy = starting || conversation.status === 'connecting'

  async function toggle() {
    setError(null)
    if (live || conversation.status === 'connecting') {
      conversation.endSession()
      return
    }
    setStarting(true)
    setLines([])
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((tr) => tr.stop())
      const s = await call<Session>('voice-session', body)
      if (s.error === 'voice_not_configured') {
        setConfigured(false)
        return
      }
      if (!s.signed_url || !s.plus_session) throw new Error(s.error ?? 'voice_unavailable')
      conversation.startSession({ signedUrl: s.signed_url, connectionType: 'websocket', dynamicVariables: { plus_session: s.plus_session } })
    } catch (err) {
      console.error('voice start failed', err)
      setError(errorText)
    } finally {
      setStarting(false)
    }
  }
  return { conversation, live, busy, configured, error, toggle, lines, doing }
}

/** Five bars that follow her voice (input) or the agent's (output). */
function Waveform({ level, className = '' }: { level: () => number; className?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  useEffect(() => {
    let raf = 0
    const shape = [0.55, 0.85, 1, 0.85, 0.55]
    const tick = () => {
      const v = Math.min(1, level() * 2.2)
      const t = performance.now() / 180
      bars.current.forEach((b, i) => {
        if (!b) return
        const wobble = 0.18 + 0.12 * Math.sin(t + i * 1.3)
        b.style.transform = `scaleY(${Math.max(0.18, Math.min(1, (v + wobble * (v > 0.05 ? 1 : 0.4)) * shape[i]))})`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [level])
  return (
    <span className={`flex h-6 items-center gap-[3px] ${className}`} aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} ref={(el) => { bars.current[i] = el }} className="h-full w-[3px] origin-center rounded-full bg-current transition-transform duration-75" />
      ))}
    </span>
  )
}

/** `words` overrides the labels (Nigeria passes English; India uses the Tamil labels). */
export function VoiceButton({ size = 'float', words, body }: { size?: 'float' | 'hero' | 'dock' | 'inline'; words?: MicWords; body?: Record<string, unknown> }) {
  const tt = useT()
  const t = (k: keyof MicWords) => words?.[k] ?? tt(k)
  const v = useVoice(body, t('micError'))
  const { conversation, live, busy, configured, error, toggle } = v
  const label = configured === false ? t('micSoon') : busy ? t('micConnecting') : live ? (conversation.isSpeaking ? t('micSpeaking') : t('micListening')) : t('mic')
  const level = () => (conversation.isSpeaking ? conversation.getOutputVolume() : conversation.getInputVolume())

  if (size === 'inline') {
    return (
      <div className="flex items-center gap-3">
        <motion.button
          whileTap={{ scale: 0.94 }}
          onClick={toggle}
          disabled={configured === false}
          aria-label={live ? `${label}. ${t('micStop')}` : label}
          aria-pressed={live}
          className={`grid size-12 shrink-0 place-items-center rounded-full text-xl transition-colors disabled:bg-fill disabled:text-secondary ${live ? 'bg-label text-canvas' : 'bg-accent text-on-accent'}`}
        >
          {live ? <Waveform level={level} /> : <Icon name="mic" />}
        </motion.button>
        <span className="min-w-0 text-base leading-tight">
          <span className={configured === false ? 'text-secondary' : 'font-medium text-label'}>{label}</span>
          {live && <span className="block text-sm text-secondary">{v.doing ?? t('micStop')}</span>}
          {error && <span className="block text-sm text-danger">{error}</span>}
        </span>
      </div>
    )
  }

  // 'float' (and the older 'hero' / 'dock' names): the round mic, bottom centre.
  if (configured === false) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 flex justify-center">
        <span role="status" className="glass rounded-full border border-hairline/70 px-4 py-2 text-sm text-secondary shadow-card">{t('micSoon')}</span>
      </div>
    )
  }
  const last = v.lines.slice(-4)
  return (
    <>
      <AnimatePresence>
        {(live || busy) && (
          <motion.div
            key="voice-sheet"
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={spring}
            className="fixed inset-x-0 bottom-[calc(10rem+env(safe-area-inset-bottom))] z-40 mx-auto w-[calc(100%-2rem)] max-w-md"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            <div className="glass max-h-[40dvh] overflow-y-auto rounded-sheet border border-hairline/70 p-4 shadow-lift">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium text-secondary">
                <span className={`size-2 rounded-full ${live ? 'bg-success' : 'bg-fill-strong'}`} /> {label}
              </p>
              {last.length === 0 && <p className="text-lg text-secondary">{busy ? t('micConnecting') : 'Say what you need, in your own words.'}</p>}
              <ul className="space-y-2">
                {last.map((l) => (
                  <motion.li key={l.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={l.who === 'you' ? 'text-right' : ''}>
                    <span className={`inline-block max-w-[85%] rounded-[1.1rem] px-3.5 py-2 text-base leading-snug ${l.who === 'you' ? 'bg-accent text-on-accent' : 'bg-fill text-label'}`}>{l.text}</span>
                  </motion.li>
                ))}
              </ul>
              {v.doing && (
                <p className="mt-3 flex items-center gap-2 text-sm font-medium text-accent-ink">
                  <span className="spin inline-block size-3.5 rounded-full border-2 border-current border-t-transparent" /> {v.doing}
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex flex-col items-center gap-1.5">
        {error && <span className="glass pointer-events-auto rounded-full px-3 py-1 text-sm text-danger shadow-card">{error}</span>}
        <motion.button
          onClick={toggle}
          whileTap={{ scale: 0.93 }}
          animate={live ? { scale: [1, 1.04, 1] } : { scale: 1 }}
          transition={live ? { repeat: Infinity, duration: 2.4, ease: 'easeInOut' } : spring}
          aria-label={live ? `${label}. ${t('micStop')}` : label}
          aria-pressed={live}
          className={`pointer-events-auto grid size-16 place-items-center rounded-full text-2xl shadow-lift ring-4 ring-canvas transition-colors ${
            live ? 'bg-label text-canvas' : 'bg-accent text-on-accent'
          } ${busy ? 'opacity-80' : ''}`}
        >
          {live ? <Waveform level={level} /> : busy ? <span className="spin inline-block size-6 rounded-full border-2 border-current border-t-transparent" /> : <Icon name="mic" />}
        </motion.button>
      </div>
    </>
  )
}
