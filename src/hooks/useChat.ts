import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

export interface ChatMessage {
  id: string
  nickname: string
  content: string
  created_at: string
}

const MAX_CONTENT = 500
const HISTORY_LIMIT = 80

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const sending = useRef(false)

  useEffect(() => {
    if (!supabase) {
      setError('Chat no configurado (faltan variables de entorno de Supabase)')
      return
    }

    let cancelled = false

    supabase
      .from('messages')
      .select('id, nickname, content, created_at')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) setError(err.message)
        else if (data) setMessages([...data].reverse())
      })

    const channel = supabase
      .channel('global-chat')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          setMessages((prev) => {
            const next = [...prev, payload.new as ChatMessage]
            return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next
          })
        },
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
      })

    return () => {
      cancelled = true
      channel.unsubscribe()
    }
  }, [])

  async function send(nickname: string, content: string): Promise<boolean> {
    if (!supabase || sending.current) return false
    const clean = content.trim().slice(0, MAX_CONTENT)
    const nick = nickname.trim().slice(0, 32)
    if (!clean || !nick) return false
    sending.current = true
    const { error: err } = await supabase.from('messages').insert({
      nickname: nick,
      content: clean,
    })
    sending.current = false
    if (err) {
      setError(err.message)
      return false
    }
    return true
  }

  return { messages, send, connected, error }
}
