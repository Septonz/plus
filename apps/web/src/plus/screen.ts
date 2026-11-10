// What is on her screen, in words, for the voice agent. Each screen (and the confirm sheet) says
// what it shows with useSays(); the newest one mounted is on top (a detail over a tab, the confirm
// sheet over both). The mic sends it to the agent whenever it changes (a contextual update), and the
// client tools navigate / what_is_on_screen answer with it, so the agent always knows what she sees.
//
// Screen actions the agent may run from the app (navigate, demo buttons, settings) are registered
// with useScreenTools(); voice.tsx hands them to the conversation as ElevenLabs client tools. They
// run in her browser with her own login, so they only work in the app, never on a phone call.
import { useEffect, useRef, useState } from 'react'

type Entry = { id: number; text: string }
type ClientTool = (params: Record<string, unknown>) => Promise<string> | string

const stack: Entry[] = []
const listeners = new Set<(text: string) => void>()
let nextId = 1
let tools: Record<string, ClientTool> = {}

function emit() {
  const text = currentScreen()
  for (const l of listeners) l(text)
}

/** What is on her screen now (top of the stack); empty when no screen describes itself (sign-up). */
export function currentScreen(): string {
  return stack.at(-1)?.text ?? ''
}

export function onScreenChange(cb: (text: string) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** This component's screen, in a sentence or two: what it is, the key numbers, what she can do here. */
export function useSays(text: string | null) {
  const [myId] = useState(() => nextId++)
  useEffect(() => {
    return () => {
      const i = stack.findIndex((e) => e.id === myId)
      if (i >= 0) stack.splice(i, 1)
      emit()
    }
  }, [myId])
  useEffect(() => {
    if (text === null) return
    const e = stack.find((x) => x.id === myId)
    if (e) {
      if (e.text === text) return
      e.text = text
    } else stack.push({ id: myId, text })
    emit()
  }, [text, myId])
}

/** Wait for the screen to render (and its first read to land) before describing it. */
export const settle = (ms = 700) => new Promise((r) => setTimeout(r, ms))

/** Register the app's client tools (latest closure always used). */
export function useScreenTools(defs: Record<string, ClientTool>) {
  const ref = useRef(defs)
  useEffect(() => {
    ref.current = defs
  })
  useEffect(() => {
    const names = Object.keys(ref.current)
    const wrapped: Record<string, ClientTool> = {}
    for (const n of names) wrapped[n] = (p) => ref.current[n](p ?? {})
    tools = { ...tools, ...wrapped }
    return () => {
      const next = { ...tools }
      for (const n of names) delete next[n]
      tools = next
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Object.keys(defs).join(',')])
}

/** Client tools for the conversation: the registered ones plus what_is_on_screen. Errors go back as text. */
export function clientTools(): Record<string, (p: Record<string, unknown>) => Promise<string>> {
  const out: Record<string, (p: Record<string, unknown>) => Promise<string>> = {
    what_is_on_screen: async () => (currentScreen() ? `On her screen: ${currentScreen()}` : 'The screen is still loading.'),
  }
  for (const [n, fn] of Object.entries(tools)) {
    out[n] = async (p) => {
      try {
        return String(await fn(p ?? {}))
      } catch (e) {
        return `That didn't work: ${e instanceof Error ? e.message : String(e)}`
      }
    }
  }
  return out
}
