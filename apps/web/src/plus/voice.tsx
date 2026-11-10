// The big microphone button. Tap: voice-session (verifies her login, returns a signed URL for
// the private ElevenLabs agent and a 15-minute plus_session token), then the official React SDK
// starts the conversation with plus_session as a dynamic variable. Every tool call the agent
// makes carries plus_session back to agent-tools, so the agent can only act for her.
// The PIN never goes through here: it is typed on the confirm screen.
// During sign-up there is no login yet: the screen passes { onboarding_token } as `body`, and
// voice-session gives the agent a plus_session for that sign-up only (it can fill in her name,
// language and phone; never the PIN, the NIN or the photo).
// Before showing the mic it asks voice-session/status whether her market's agent is set up (for
// Nigeria: ELEVENLABS_AGENT_ID_NG). If not, it shows "Voice coming soon" instead of failing; as soon
// as the secret is set, the same button works, with no code change.
import { useConversation } from '@elevenlabs/react'
import { useEffect, useState } from 'react'
import { call } from './api'
import { Icon, useT } from './ui'

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
      .catch(() => null) // unknown: let her try; a failure then shows micError
    statusOnce.set(key, p)
  }
  return p
}

/** `words` overrides the labels (Nigeria passes English/Pidgin; India uses the Tamil labels). */
export function VoiceButton({ size = 'hero', words, body }: { size?: 'hero' | 'dock' | 'inline'; words?: MicWords; body?: Record<string, unknown> }) {
  const tt = useT()
  const t = (k: keyof MicWords) => words?.[k] ?? tt(k)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)
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
      setError(t('micError'))
    },
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
    try {
      // Ask for the microphone first so the permission prompt has a clear cause.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((tr) => tr.stop())
      const s = await call<Session>('voice-session', body)
      if (s.error === 'voice_not_configured') {
        setConfigured(false)
        return
      }
      if (!s.signed_url || !s.plus_session) throw new Error(s.error ?? 'voice_unavailable')
      conversation.startSession({
        signedUrl: s.signed_url,
        connectionType: 'websocket',
        dynamicVariables: { plus_session: s.plus_session },
      })
    } catch (err) {
      console.error('voice start failed', err)
      setError(t('micError'))
    } finally {
      setStarting(false)
    }
  }

  const hero = size === 'hero'
  if (size === 'inline') {
    // A row (sign-up): the mic beside a short line, so the steps keep the screen.
    const label = configured === false ? t('micSoon') : busy ? t('micConnecting') : live ? (conversation.isSpeaking ? t('micSpeaking') : t('micListening')) : t('mic')
    return (
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          disabled={configured === false}
          aria-label={live ? `${label}. ${t('micStop')}` : label}
          aria-pressed={live}
          className={`grid size-14 shrink-0 place-items-center rounded-full text-3xl shadow-lift transition active:scale-95 disabled:bg-sand disabled:text-ink-soft disabled:shadow-none ${live ? 'mic-live bg-saffron text-ink' : 'bg-brick text-cream'}`}
        >
          <Icon name={live ? 'stop' : 'mic'} />
        </button>
        <span className="min-w-0 text-lg font-bold leading-tight">
          <span className={configured === false ? 'text-ink-soft' : live ? 'text-saffron-deep' : 'text-brick'}>{label}</span>
          {error && <span className="block text-base font-semibold text-chili">{error}</span>}
        </span>
      </div>
    )
  }
  // Not set up: Home says "Voice coming soon"; the small docked mic on other screens stays out of the way.
  if (configured === false && size === 'dock') return null
  if (configured === false) {
    return (
      <div className="flex flex-col items-center gap-2" role="status">
        <span aria-hidden className={`grid place-items-center rounded-full bg-sand text-ink-soft ${hero ? 'size-36 text-6xl' : 'size-20 text-4xl'}`}>
          <Icon name="mic" />
        </span>
        <span className={`text-center font-extrabold text-ink-soft ${hero ? 'text-2xl' : 'text-base'}`}>{t('micSoon')}</span>
      </div>
    )
  }

  const label = busy ? t('micConnecting') : live ? (conversation.isSpeaking ? t('micSpeaking') : t('micListening')) : t('mic')
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={toggle}
        aria-label={live ? `${label}. ${t('micStop')}` : label}
        aria-pressed={live}
        className={`grid place-items-center rounded-full font-bold text-cream shadow-lg transition active:scale-95 ${
          hero ? 'size-36 text-6xl' : 'size-20 text-4xl'
        } ${live ? 'mic-live bg-saffron text-ink' : 'bg-brick'} ${busy ? 'opacity-70' : ''}`}
      >
        <Icon name={live ? 'stop' : 'mic'} />
      </button>
      <span className={`text-center font-extrabold ${hero ? 'text-2xl' : 'text-base'} ${live ? 'text-saffron' : 'text-brick'}`}>{label}</span>
      {live && hero && <span className="text-base text-ink-soft">{t('micStop')}</span>}
      {error && <span className="max-w-64 text-center text-base font-semibold text-chili">{error}</span>}
    </div>
  )
}
