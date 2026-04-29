import type { EntityType, FrictionMode, GravityMode } from '../lib/physics'

interface Props {
  selected: EntityType
  gravity: GravityMode
  friction: FrictionMode
  collisions: boolean
  wireframe: boolean
  paused: boolean
  party: boolean
  soundOn: boolean
  timeScale: number
  bodyCount: number
  onOpenHelp: () => void
}

const ENTITIES: { key: string; type: EntityType; label: string; emoji: string }[] = [
  { key: '1', type: 'jp', label: 'jp', emoji: '🖼️' },
  { key: '2', type: 'ball', label: 'Pelota', emoji: '⚽' },
  { key: '3', type: 'box', label: 'Caja', emoji: '📦' },
  { key: '4', type: 'triangle', label: 'Triángulo', emoji: '🔺' },
  { key: '5', type: 'star', label: 'Estrella', emoji: '⭐' },
  { key: '6', type: 'bullet', label: 'Bala', emoji: '💨' },
  { key: '7', type: 'balloon', label: 'Globo', emoji: '🎈' },
]

export function HUD({
  selected,
  gravity,
  friction,
  collisions,
  wireframe,
  paused,
  party,
  soundOn,
  timeScale,
  bodyCount,
  onOpenHelp,
}: Props) {
  return (
    <div className="pointer-events-none absolute inset-0 px-4 pb-4 pt-16">
      {/* Top-left: entity selector (sits below the mode toggle) */}
      <div className="flex flex-wrap gap-2">
        {ENTITIES.map((e) => (
          <EntityCard key={e.key} entity={e} active={selected === e.type} />
        ))}
      </div>

      {/* Bottom-left: status bar */}
      <div className="absolute bottom-4 left-4 flex flex-wrap items-center gap-2 text-xs">
        <Pill>
          <span className="opacity-60">Entidades:</span>
          <span className="font-mono text-slate-100">{bodyCount}</span>
        </Pill>
        <Pill>
          <kbd className="font-mono opacity-60">G</kbd>
          <span>Grav: {labelGravity(gravity)}</span>
        </Pill>
        <Pill>
          <kbd className="font-mono opacity-60">F</kbd>
          <span>Roce: {labelFriction(friction)}</span>
        </Pill>
        <Pill active={!collisions} warn={!collisions}>
          <kbd className="font-mono opacity-60">C</kbd>
          <span>{collisions ? 'Colisiones ON' : 'Sin colisión'}</span>
        </Pill>
        {timeScale !== 1 && (
          <Pill active>
            <span>{timeScale < 1 ? '⏳ Slow' : '⏩ Fast'} ×{timeScale}</span>
          </Pill>
        )}
        {paused && <Pill active>⏸ Pausa</Pill>}
        {party && <Pill active>🎉 Party</Pill>}
        {wireframe && <Pill active>Debug</Pill>}
        {!soundOn && <Pill warn>🔇 Mute</Pill>}
      </div>

      {/* Top-right: help button */}
      <button
        onClick={onOpenHelp}
        className="pointer-events-auto absolute right-4 top-4 rounded-full border border-slate-700/60 bg-slate-900/70 px-3 py-1 text-xs text-slate-200 backdrop-blur hover:bg-slate-800"
        title="Ver todas las teclas (?)"
      >
        <kbd className="font-mono opacity-70">?</kbd>
        <span className="ml-1.5">Ayuda</span>
      </button>

      {/* Subtle hint (bottom-center) */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-slate-500">
        Click para spawnear · Shift+Click bomba · H oculta HUD
      </div>
    </div>
  )
}

function EntityCard({
  entity,
  active,
}: {
  entity: { key: string; label: string; emoji: string }
  active: boolean
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition ${
        active
          ? 'scale-105 border-emerald-400/60 bg-emerald-500/20 text-emerald-50 shadow-lg shadow-emerald-500/20'
          : 'border-slate-700/60 bg-slate-900/60 text-slate-300'
      } backdrop-blur`}
    >
      <kbd
        className={`font-mono text-[10px] ${
          active ? 'text-emerald-200' : 'text-slate-500'
        }`}
      >
        {entity.key}
      </kbd>
      <span aria-hidden>{entity.emoji}</span>
      <span className="font-medium">{entity.label}</span>
    </div>
  )
}

function Pill({
  children,
  active = false,
  warn = false,
}: {
  children: React.ReactNode
  active?: boolean
  warn?: boolean
}) {
  const style = warn
    ? 'border-amber-400/50 bg-amber-500/15 text-amber-100'
    : active
      ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-100'
      : 'border-slate-700/60 bg-slate-900/60 text-slate-200'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 backdrop-blur ${style}`}
    >
      {children}
    </span>
  )
}

function labelGravity(g: GravityMode) {
  return g === 'normal' ? 'normal' : g === 'lunar' ? 'lunar' : g === 'zero' ? 'cero' : 'invertida'
}
function labelFriction(f: FrictionMode) {
  return f === 'normal' ? 'normal' : f === 'slick' ? 'hielo' : 'pegajosa'
}
