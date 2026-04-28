import { useEffect, useState } from 'react'
import { DrawCanvas } from './DrawCanvas'
import { PhysicsCanvas } from './PhysicsCanvas'

type Mode = 'draw' | 'play'
const MODE_KEY = 'pp:mode'

interface Props {
  nickname: string
}

export function Playground({ nickname }: Props) {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(MODE_KEY)
    return saved === 'play' ? 'play' : 'draw'
  })

  useEffect(() => {
    localStorage.setItem(MODE_KEY, mode)
  }, [mode])

  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null
      return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    }
    function onKey(e: KeyboardEvent) {
      if (isTyping(e.target)) return
      if (e.key === 'Tab') {
        e.preventDefault()
        setMode((m) => (m === 'draw' ? 'play' : 'draw'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      {/* Drawing canvas — bottom layer (white background + persistent strokes). */}
      <DrawCanvas nickname={nickname} interactive={mode === 'draw'} />

      {/* Physics canvas — top layer (transparent, renders bodies on top). */}
      <PhysicsCanvas interactive={mode === 'play'} />

      {/* Mode toggle */}
      <div className="pointer-events-auto absolute left-4 top-4 z-50 flex rounded-xl border border-slate-300 bg-white/95 p-1 shadow-md backdrop-blur">
        <ModeButton active={mode === 'draw'} onClick={() => setMode('draw')} title="Dibujar (Tab)">
          <span aria-hidden>✏️</span>
          <span>Dibujar</span>
        </ModeButton>
        <ModeButton active={mode === 'play'} onClick={() => setMode('play')} title="Jugar (Tab)">
          <span aria-hidden>🎮</span>
          <span>Jugar</span>
        </ModeButton>
      </div>
    </>
  )
}

function ModeButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-slate-900 text-white shadow'
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      {children}
    </button>
  )
}
