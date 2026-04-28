import { useEffect, useRef, useState } from 'react'
import { useChat } from '../hooks/useChat'
import { chatEnabled } from '../lib/supabase'

interface Props {
  nickname: string
  onChangeNickname: () => void
}

export function Chat({ nickname, onChangeNickname }: Props) {
  const { messages, send, connected, error } = useChat()
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    const ok = await send(nickname, text)
    if (ok) setDraft('')
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="absolute bottom-4 right-4 z-40 rounded-full bg-slate-900/80 px-4 py-2 text-sm text-slate-100 backdrop-blur border border-slate-700 hover:bg-slate-800"
      >
        Abrir chat · {messages.length}
      </button>
    )
  }

  return (
    <div className="absolute bottom-4 right-4 z-40 flex max-h-[70vh] w-80 max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/85 shadow-2xl backdrop-blur">
      <header className="flex items-center justify-between gap-2 border-b border-slate-700/60 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              connected ? 'bg-emerald-400' : 'bg-slate-500'
            }`}
            title={connected ? 'Conectado' : 'Desconectado'}
          />
          <button
            onClick={onChangeNickname}
            title="Cambiar nickname"
            className="truncate text-sm font-medium text-slate-100 hover:text-emerald-300"
          >
            {nickname}
          </button>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded px-2 py-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          aria-label="Cerrar chat"
        >
          ×
        </button>
      </header>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {!chatEnabled && (
          <p className="text-amber-300/90 text-xs">
            Chat deshabilitado. Configura las variables VITE_SUPABASE_URL y
            VITE_SUPABASE_ANON_KEY.
          </p>
        )}
        {chatEnabled && messages.length === 0 && (
          <p className="text-slate-500 text-xs">Aún no hay mensajes. Sé el primero.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="py-0.5">
            <span className="font-medium text-emerald-300">{m.nickname}</span>
            <span className="text-slate-500">: </span>
            <span className="text-slate-100 break-words">{m.content}</span>
          </div>
        ))}
        {error && <p className="mt-2 text-xs text-rose-400">{error}</p>}
      </div>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-slate-700/60 p-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          disabled={!chatEnabled}
          placeholder={chatEnabled ? 'Escribe…' : 'Chat deshabilitado'}
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!chatEnabled || !draft.trim()}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Enviar
        </button>
      </form>
    </div>
  )
}
