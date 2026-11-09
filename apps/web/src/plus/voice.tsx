// The big microphone button. Tap: voice-session (verifies her login, returns a signed URL for
// the private ElevenLabs agent and a 15-minute plus_session token), then the official React SDK
// starts the conversation with plus_session as a dynamic variable. Every tool call the agent
// makes carries plus_session back to agent-tools, so the agent can only act for her.
// The PIN never goes through here: it is typed on the confirm screen.
import { useConversation } from '@elevenlabs/react'
import { useState } from 'react'
import { call } from './api'
import { Icon, useT } from './ui'

type Session = { signed_url?: string; plus_session?: string; error?: string }

export function VoiceButton({ size = 'hero' }: { size?: 'hero' | 'dock' }) {
  const t = useT()
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
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
      const s = await call<Session>('voice-session')
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

  const label = busy ? t('micConnecting') : live ? (conversation.isSpeaking ? t('micSpeaking') : t('micListening')) : t('mic')
  const hero = size === 'hero'
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
