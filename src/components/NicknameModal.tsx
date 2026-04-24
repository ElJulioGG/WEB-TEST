import { useState } from 'react'

interface Props {
  onSubmit: (nickname: string) => void
}

export function NicknameModal({ onSubmit }: Props) {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  const valid = trimmed.length >= 1 && trimmed.length <= 32

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) return
    onSubmit(trimmed)
  }

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900/90 p-6 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-slate-100">Elige un nickname</h2>
        <p className="mt-1 text-sm text-slate-400">
          Se mostrará en el chat global. Puedes cambiarlo luego.
        </p>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={32}
          placeholder="tu nombre"
          className="mt-4 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!valid}
          className="mt-4 w-full rounded-lg bg-emerald-500 px-4 py-2 font-medium text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Entrar
        </button>
      </form>
    </div>
  )
}
