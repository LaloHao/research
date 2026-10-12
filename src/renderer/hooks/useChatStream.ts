import { useEffect, useRef } from 'react'
import type { ChatStreamUpdate } from '../../shared/chat'

/** Subscribes to the answers' stream (every conversation); always calls the latest callback. */
export function useChatStream(callback: (update: ChatStreamUpdate) => void): void {
  const ref = useRef(callback)
  ref.current = callback
  useEffect(() => window.research.chats.onStream((u) => ref.current(u)), [])
}
