import { useEffect } from 'react'

interface Section {
  title: string
  rows: { keys: string[]; label: string; hint?: string }[]
}

const SECTIONS: Section[] = [
  {
    title: 'Entidades',
    rows: [
      { keys: ['1'], label: 'jp (tu foto)' },
      { keys: ['2'], label: 'Pelota elástica' },
      { keys: ['3'], label: 'Caja' },
      { keys: ['4'], label: 'Triángulo' },
      { keys: ['5'], label: 'Estrella' },
      { keys: ['6'], label: 'Bala', hint: 'rápida y densa' },
      { keys: ['7'], label: 'Globo', hint: 'flota' },
    ],
  },
  {
    title: 'Mouse',
    rows: [
      { keys: ['Click'], label: 'Spawnear entidad seleccionada' },
      { keys: ['Shift', '+', 'Click'], label: 'Bomba en el cursor' },
      { keys: ['Arrastrar'], label: 'Mover una entidad' },
    ],
  },
  {
    title: 'Acciones (un toque)',
    rows: [
      { keys: ['Space'], label: 'Bomba en el cursor' },
      { keys: ['E'], label: 'Lluvia de confetti' },
      { keys: ['Enter'], label: 'SUPER bomba central' },
      { keys: ['R'], label: 'Limpiar todo' },
    ],
  },
  {
    title: 'Mantener pulsada',
    rows: [
      { keys: ['B'], label: 'Agujero negro en el cursor' },
      { keys: ['V'], label: 'Empuje desde el cursor' },
      { keys: ['N'], label: 'Viento hacia la izquierda' },
      { keys: ['M'], label: 'Viento hacia la derecha' },
      { keys: ['Q'], label: 'Lluvia continua', hint: 'spawnea donde apuntes' },
      { keys: ['Z'], label: 'Slow motion (×0.25)' },
      { keys: ['X'], label: 'Fast forward (×2)' },
    ],
  },
  {
    title: 'Mundo',
    rows: [
      { keys: ['G'], label: 'Ciclar gravedad', hint: 'normal → lunar → 0 → invertida' },
      { keys: ['C'], label: 'Colisiones ON/OFF', hint: 'al apagar, las entidades se atraviesan' },
      { keys: ['F'], label: 'Ciclar fricción', hint: 'normal → hielo → pegajosa' },
      { keys: ['P'], label: 'Pausa / play' },
    ],
  },
  {
    title: 'Interfaz',
    rows: [
      { keys: ['T'], label: 'Modo fiesta' },
      { keys: ['D'], label: 'Wireframe debug' },
      { keys: ['S'], label: 'Sonido ON/OFF' },
      { keys: ['H'], label: 'Ocultar / mostrar HUD' },
      { keys: ['?'], label: 'Mostrar esta ayuda' },
    ],
  },
]

export function HelpPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [onClose])

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900/95 p-6 shadow-2xl"
      >
        <header className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Controles</h2>
            <p className="text-xs text-slate-400">Todas las teclas disponibles</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
          >
            Cerrar · Esc
          </button>
        </header>

        <div className="grid gap-5 sm:grid-cols-2">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3 className="mb-2 text-xs uppercase tracking-widest text-emerald-300/80">
                {s.title}
              </h3>
              <ul className="space-y-1.5">
                {s.rows.map((r, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    <span className="flex shrink-0 items-center gap-0.5">
                      {r.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="rounded border border-slate-700 bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-200"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                    <span className="flex-1 text-slate-200">
                      {r.label}
                      {r.hint && <span className="text-slate-500"> — {r.hint}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
