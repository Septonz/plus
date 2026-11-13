import { useEffect, useState } from 'react'
import { recordingMode } from './presenter'

/** Recording mode, live: follows changes made on /demo (or another tab) through storage events. */
export function useRecordingMode(): boolean {
  const [on, setOn] = useState(recordingMode)
  useEffect(() => {
    const sync = () => setOn(recordingMode())
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
  return on
}
