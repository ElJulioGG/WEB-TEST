import { useEffect, useRef, useState } from 'react'
import {
  createPhysics,
  type EntityType,
  type FrictionMode,
  type GravityMode,
  type PhysicsHandle,
} from '../lib/physics'
import { audio } from '../lib/audio'
import { HUD } from './HUD'
import { HelpPanel } from './HelpPanel'

const KEY_TO_TYPE: Record<string, EntityType> = {
  '1': 'jp',
  '2': 'ball',
  '3': 'box',
  '4': 'triangle',
  '5': 'star',
  '6': 'bullet',
  '7': 'balloon',
}

const NEXT_GRAVITY: Record<GravityMode, GravityMode> = {
  normal: 'lunar',
  lunar: 'zero',
  zero: 'inverted',
  inverted: 'normal',
}

const NEXT_FRICTION: Record<FrictionMode, FrictionMode> = {
  normal: 'slick',
  slick: 'sticky',
  sticky: 'normal',
}

const HELD_EFFECT_KEYS = new Set(['b', 'v', 'n', 'm', 'q'])

interface PhysicsCanvasProps {
  interactive?: boolean
}

export function PhysicsCanvas({ interactive = true }: PhysicsCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const physicsRef = useRef<PhysicsHandle | null>(null)
  const downPos = useRef<{ x: number; y: number } | null>(null)
  const mousePosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const heldKeys = useRef(new Set<string>())
  const shakeRef = useRef(0)
  const lastRainRef = useRef(0)
  const toastTimerRef = useRef<number>(0)

  const [selected, setSelected] = useState<EntityType>('jp')
  const [gravity, setGravity] = useState<GravityMode>('normal')
  const [friction, setFriction] = useState<FrictionMode>('normal')
  const [collisions, setCollisions] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [paused, setPaused] = useState(false)
  const [party, setParty] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const [hudVisible, setHudVisible] = useState(true)
  const [helpOpen, setHelpOpen] = useState(false)
  const [bodyCount, setBodyCount] = useState(0)
  const [timeScale, setTimeScaleState] = useState(1)
  const [toast, setToast] = useState<string | null>(null)

  const selectedRef = useRef(selected)
  const pausedRef = useRef(paused)
  const interactiveRef = useRef(interactive)
  useEffect(() => {
    selectedRef.current = selected
  }, [selected])
  useEffect(() => {
    pausedRef.current = paused
  }, [paused])
  useEffect(() => {
    interactiveRef.current = interactive
    // Releasing held keys when leaving play mode prevents stuck effects.
    if (!interactive) heldKeys.current.clear()
  }, [interactive])

  function showToast(msg: string) {
    setToast(msg)
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(null), 1200)
  }

  // Physics bootstrap + cleanup.
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return
    const container = containerRef.current
    const canvas = canvasRef.current

    const physics = createPhysics(canvas, container.clientWidth, container.clientHeight)
    physicsRef.current = physics

    physics.onBomb(() => {
      shakeRef.current = Math.max(shakeRef.current, 14)
    })

    const observer = new ResizeObserver(() => {
      physics.resize(container.clientWidth, container.clientHeight)
    })
    observer.observe(container)

    const interval = window.setInterval(() => {
      setBodyCount(physics.getBodyCount())
    }, 300)

    return () => {
      observer.disconnect()
      window.clearInterval(interval)
      physics.destroy()
      physicsRef.current = null
    }
  }, [])

  // Continuous effects loop (held keys + screen shake).
  useEffect(() => {
    let raf = 0
    function tick() {
      const p = physicsRef.current
      const canvas = canvasRef.current
      const keys = heldKeys.current
      const { x, y } = mousePosRef.current

      if (p && !pausedRef.current) {
        if (keys.has('b')) p.blackhole(x, y)
        if (keys.has('v')) p.repulsor(x, y)
        if (keys.has('n')) p.wind(-0.0006, 0)
        if (keys.has('m')) p.wind(0.0006, 0)
        const now = performance.now()
        if (keys.has('q') && now - lastRainRef.current > 65) {
          p.spawn(selectedRef.current, x, y)
          lastRainRef.current = now
        }
      }

      if (canvas) {
        if (shakeRef.current > 0.4) {
          const a = shakeRef.current
          const dx = (Math.random() - 0.5) * a
          const dy = (Math.random() - 0.5) * a
          canvas.style.transform = `translate(${dx}px, ${dy}px)`
          shakeRef.current *= 0.86
        } else if (canvas.style.transform) {
          canvas.style.transform = ''
          shakeRef.current = 0
        }
      }

      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Keyboard input.
  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null
      return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    }

    function onKeyDown(e: KeyboardEvent) {
      if (isTyping(e.target)) return
      if (!interactiveRef.current) return
      const p = physicsRef.current
      if (!p) return

      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (HELD_EFFECT_KEYS.has(k) || k === 'z' || k === 'x') {
        heldKeys.current.add(k)
      }

      // Time-scale hold keys: apply on first keydown only.
      if (!e.repeat) {
        if (k === 'z') {
          p.setTimeScale(0.25)
          setTimeScaleState(0.25)
        } else if (k === 'x') {
          p.setTimeScale(2)
          setTimeScaleState(2)
        }
      }

      if (e.repeat) return

      // Entity selection.
      if (KEY_TO_TYPE[k]) {
        setSelected(KEY_TO_TYPE[k])
        showToast(`Seleccionado: ${KEY_TO_TYPE[k]}`)
        return
      }

      switch (k) {
        case ' ': {
          e.preventDefault()
          const { x, y } = mousePosRef.current
          p.bomb(x, y)
          break
        }
        case 'e':
          p.confetti()
          showToast('¡Confetti!')
          break
        case 'Enter':
          e.preventDefault()
          p.superBomb()
          showToast('SUPER BOMBA')
          break
        case 'r':
          p.clearDynamic()
          showToast('Reset')
          break
        case 'g': {
          setGravity((prev) => {
            const next = NEXT_GRAVITY[prev]
            p.setGravity(next)
            showToast(`Gravedad: ${labelGravity(next)}`)
            return next
          })
          break
        }
        case 'c': {
          setCollisions((prev) => {
            const next = !prev
            p.setCollisions(next)
            showToast(next ? 'Colisiones: ON' : 'Colisiones: OFF (atraviesan)')
            return next
          })
          break
        }
        case 'f': {
          setFriction((prev) => {
            const next = NEXT_FRICTION[prev]
            p.setFriction(next)
            showToast(`Fricción: ${labelFriction(next)}`)
            return next
          })
          break
        }
        case 'p': {
          setPaused((prev) => {
            const next = !prev
            p.setPaused(next)
            showToast(next ? '⏸ Pausa' : '▶ Play')
            return next
          })
          break
        }
        case 'd':
          setWireframe((prev) => {
            const next = !prev
            p.setWireframe(next)
            return next
          })
          break
        case 't':
          setParty((prev) => {
            const next = !prev
            p.setPartyMode(next)
            showToast(next ? '🎉 Modo fiesta' : 'Modo normal')
            return next
          })
          break
        case 's':
          setSoundOn((prev) => {
            const next = !prev
            audio.setEnabled(next)
            showToast(next ? '🔊 Sonido ON' : '🔇 Sonido OFF')
            return next
          })
          break
        case 'h':
          setHudVisible((v) => !v)
          break
        case '?':
        case '/':
          e.preventDefault()
          setHelpOpen((v) => !v)
          break
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (!interactiveRef.current) return
      const p = physicsRef.current
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      heldKeys.current.delete(k)
      if (!p) return
      if (k === 'z' || k === 'x') {
        const stillZ = heldKeys.current.has('z')
        const stillX = heldKeys.current.has('x')
        if (stillZ) {
          p.setTimeScale(0.25)
          setTimeScaleState(0.25)
        } else if (stillX) {
          p.setTimeScale(2)
          setTimeScaleState(2)
        } else {
          p.setTimeScale(1)
          setTimeScaleState(1)
        }
      }
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  function onMouseMove(e: React.MouseEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    mousePosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onMouseDown(e: React.MouseEvent) {
    downPos.current = { x: e.clientX, y: e.clientY }
  }

  function onMouseUp(e: React.MouseEvent) {
    const start = downPos.current
    downPos.current = null
    if (!start) return
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
    if (moved > 4) return // drag, not click

    const p = physicsRef.current
    const canvas = canvasRef.current
    if (!p || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (e.shiftKey) p.bomb(x, y)
    else p.spawn(selectedRef.current, x, y)
  }

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0 overflow-hidden">
      <canvas
        ref={canvasRef}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        className={`block h-full w-full ${interactive ? 'pointer-events-auto cursor-crosshair' : 'pointer-events-none'}`}
      />
      {party && (
        <div
          className="pointer-events-none absolute inset-0 mix-blend-overlay"
          style={{
            background:
              'linear-gradient(45deg, rgba(236,72,153,0.35), rgba(56,189,248,0.35), rgba(250,204,21,0.35))',
            animation: 'party-shift 4s linear infinite',
          }}
        />
      )}
      {hudVisible && interactive && (
        <HUD
          selected={selected}
          gravity={gravity}
          friction={friction}
          collisions={collisions}
          wireframe={wireframe}
          paused={paused}
          party={party}
          soundOn={soundOn}
          timeScale={timeScale}
          bodyCount={bodyCount}
          onOpenHelp={() => setHelpOpen(true)}
        />
      )}
      {toast && interactive && (
        <div className="pointer-events-none absolute left-1/2 top-10 -translate-x-1/2 rounded-full border border-slate-700/60 bg-slate-900/80 px-4 py-1.5 text-sm text-slate-100 shadow-lg backdrop-blur">
          {toast}
        </div>
      )}
      {helpOpen && (
        <div className="pointer-events-auto">
          <HelpPanel onClose={() => setHelpOpen(false)} />
        </div>
      )}
    </div>
  )
}

function labelGravity(g: GravityMode) {
  return g === 'normal' ? 'normal' : g === 'lunar' ? 'lunar' : g === 'zero' ? 'cero' : 'invertida'
}
function labelFriction(f: FrictionMode) {
  return f === 'normal' ? 'normal' : f === 'slick' ? 'lisa (hielo)' : 'pegajosa'
}
