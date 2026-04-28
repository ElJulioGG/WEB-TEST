import { useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, chatEnabled } from '../lib/supabase'

interface Point { x: number; y: number }

export interface Stroke {
  id: string
  client_id: string
  nickname: string
  color: string
  width: number
  points: Point[]
}

interface Cursor {
  client_id: string
  nickname: string
  color: string
  x: number
  y: number
  drawing: boolean
  updatedAt: number
}

const PALETTE = [
  '#0f172a', '#ef4444', '#f97316', '#facc15',
  '#22c55e', '#0ea5e9', '#8b5cf6', '#ec4899',
]
const SIZES = [2, 4, 8, 16]
const HISTORY_LIMIT = 1000
const CURSOR_TTL_MS = 5000
const ZOOM_MIN = 0.1
const ZOOM_MAX = 8

function stableColor(seed: string) {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  const palette = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']
  return palette[Math.abs(h) % palette.length]
}

function newId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function genClientId() {
  const cached = sessionStorage.getItem('pp:clientId')
  if (cached) return cached
  const id = newId()
  sessionStorage.setItem('pp:clientId', id)
  return id
}

interface Props {
  nickname: string
}

export function DrawCanvas({ nickname }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const clientId = useMemo(() => genClientId(), [])
  const myColor = useMemo(() => stableColor(clientId), [clientId])

  const [color, setColor] = useState<string>(myColor)
  const [width, setWidthState] = useState<number>(4)
  const [zoom, setZoomState] = useState<number>(1)
  const [pan, setPanState] = useState<Point>({ x: 0, y: 0 })
  const [hover, setHover] = useState<{ stroke: Stroke; sx: number; sy: number } | null>(null)
  const [, setCursorTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [spaceDown, setSpaceDownState] = useState(false)

  // refs that mirror state for use inside event handlers / RAF loop
  const colorRef = useRef(color)
  const widthRef = useRef(width)
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  const spaceDownRef = useRef(false)

  useEffect(() => { colorRef.current = color }, [color])
  useEffect(() => { widthRef.current = width }, [width])

  // Drawing/transport state held in refs (no React re-renders).
  const strokesRef = useRef<Stroke[]>([])
  const liveStrokesRef = useRef<Map<string, Stroke>>(new Map())
  const myStrokeRef = useRef<Stroke | null>(null)
  const cursorsRef = useRef<Map<string, Cursor>>(new Map())

  const channelRef = useRef<RealtimeChannel | null>(null)
  const lastCursorBroadcast = useRef(0)
  const lastProgressBroadcast = useRef(0)

  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const renderPendingRef = useRef(false)
  const panStateRef = useRef<{ active: boolean; sx: number; sy: number; startPan: Point } | null>(null)

  function setZoom(v: number) {
    zoomRef.current = v
    setZoomState(v)
  }
  function setPan(p: Point) {
    panRef.current = p
    setPanState(p)
  }
  function setWidth(w: number) {
    widthRef.current = w
    setWidthState(w)
  }

  function requestRender() {
    if (renderPendingRef.current) return
    renderPendingRef.current = true
    requestAnimationFrame(() => {
      renderPendingRef.current = false
      render()
    })
  }

  function render() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h, dpr } = sizeRef.current

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)

    const z = zoomRef.current
    const p = panRef.current
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * -p.x * z, dpr * -p.y * z)

    for (const s of strokesRef.current) drawStroke(ctx, s)
    for (const s of liveStrokesRef.current.values()) drawStroke(ctx, s)
    if (myStrokeRef.current) drawStroke(ctx, myStrokeRef.current)
  }

  function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    const pts = s.points
    if (pts.length === 0) return
    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color
    ctx.lineWidth = s.width
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (pts.length === 1) {
      ctx.beginPath()
      ctx.arc(pts[0].x, pts[0].y, s.width / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
    ctx.stroke()
  }

  // Resize observer keeps canvas in sync with container size and DPR.
  useEffect(() => {
    if (!containerRef.current || !canvasRef.current) return
    const container = containerRef.current
    const canvas = canvasRef.current

    const update = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      sizeRef.current = { w, h, dpr }
      requestRender()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Supabase: load history, subscribe to realtime channel.
  useEffect(() => {
    if (!supabase) return
    let cancelled = false

    supabase
      .from('strokes')
      .select('id, client_id, nickname, color, width, points')
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
      .then(({ data, error: err }) => {
        if (cancelled) return
        if (err) {
          setError(err.message)
          return
        }
        if (data) {
          strokesRef.current = (data as Stroke[]).reverse()
          requestRender()
        }
      })

    const ch = supabase
      .channel('whiteboard', { config: { broadcast: { self: false } } })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'strokes' },
        (payload) => {
          const s = payload.new as Stroke
          if (s.client_id === clientId) return
          liveStrokesRef.current.delete(s.client_id)
          strokesRef.current.push(s)
          if (strokesRef.current.length > HISTORY_LIMIT) strokesRef.current.shift()
          requestRender()
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'strokes' },
        (payload) => {
          const oldId = (payload.old as { id?: string })?.id
          if (!oldId) return
          strokesRef.current = strokesRef.current.filter((s) => s.id !== oldId)
          requestRender()
        },
      )
      .on('broadcast', { event: 'cursor' }, ({ payload }) => {
        if (!payload || payload.client_id === clientId) return
        cursorsRef.current.set(payload.client_id, {
          client_id: payload.client_id,
          nickname: payload.nickname,
          color: payload.color,
          x: payload.x,
          y: payload.y,
          drawing: !!payload.drawing,
          updatedAt: Date.now(),
        })
        setCursorTick((t) => t + 1)
      })
      .on('broadcast', { event: 'stroke-progress' }, ({ payload }) => {
        if (!payload || payload.client_id === clientId) return
        liveStrokesRef.current.set(payload.client_id, payload as Stroke)
        requestRender()
      })
      .on('broadcast', { event: 'stroke-end' }, ({ payload }) => {
        if (!payload) return
        liveStrokesRef.current.delete(payload.client_id)
        requestRender()
      })
      .on('broadcast', { event: 'clear-mine' }, ({ payload }) => {
        if (!payload?.client_id) return
        strokesRef.current = strokesRef.current.filter((s) => s.client_id !== payload.client_id)
        liveStrokesRef.current.delete(payload.client_id)
        requestRender()
      })
      .subscribe()
    channelRef.current = ch

    return () => {
      cancelled = true
      ch.unsubscribe()
      channelRef.current = null
    }
  }, [clientId])

  // Sweep stale cursors.
  useEffect(() => {
    const id = window.setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [k, c] of cursorsRef.current) {
        if (now - c.updatedAt > CURSOR_TTL_MS) {
          cursorsRef.current.delete(k)
          changed = true
        }
      }
      if (changed) setCursorTick((t) => t + 1)
    }, 1500)
    return () => window.clearInterval(id)
  }, [])

  function screenToWorld(sx: number, sy: number): Point {
    const z = zoomRef.current
    const p = panRef.current
    return { x: sx / z + p.x, y: sy / z + p.y }
  }
  function worldToScreen(p: Point): Point {
    const z = zoomRef.current
    const pn = panRef.current
    return { x: (p.x - pn.x) * z, y: (p.y - pn.y) * z }
  }

  function broadcastCursor(world: Point, drawing: boolean, force = false) {
    if (!channelRef.current) return
    const now = performance.now()
    if (!force && now - lastCursorBroadcast.current < 35) return
    lastCursorBroadcast.current = now
    channelRef.current.send({
      type: 'broadcast',
      event: 'cursor',
      payload: {
        client_id: clientId,
        nickname,
        color: myColor,
        x: world.x,
        y: world.y,
        drawing,
      },
    })
  }

  function broadcastProgress(force = false) {
    if (!channelRef.current || !myStrokeRef.current) return
    const now = performance.now()
    if (!force && now - lastProgressBroadcast.current < 60) return
    lastProgressBroadcast.current = now
    channelRef.current.send({
      type: 'broadcast',
      event: 'stroke-progress',
      payload: { ...myStrokeRef.current },
    })
  }

  function broadcastEnd() {
    if (!channelRef.current) return
    channelRef.current.send({
      type: 'broadcast',
      event: 'stroke-end',
      payload: { client_id: clientId },
    })
  }

  function startPan(sx: number, sy: number, target: HTMLElement, pointerId: number) {
    panStateRef.current = { active: true, sx, sy, startPan: { ...panRef.current } }
    try { target.setPointerCapture(pointerId) } catch { /* noop */ }
  }

  function onPointerDown(e: React.PointerEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    if (e.button === 1 || e.button === 2 || spaceDownRef.current) {
      e.preventDefault()
      startPan(sx, sy, e.target as HTMLElement, e.pointerId)
      return
    }
    if (e.button !== 0) return

    const world = screenToWorld(sx, sy)
    myStrokeRef.current = {
      id: newId(),
      client_id: clientId,
      nickname,
      color: colorRef.current,
      width: widthRef.current,
      points: [world],
    }
    setHover(null)
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId) } catch { /* noop */ }
    requestRender()
    broadcastProgress(true)
    broadcastCursor(world, true, true)
  }

  function onPointerMove(e: React.PointerEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top

    if (panStateRef.current?.active) {
      const ps = panStateRef.current
      const z = zoomRef.current
      setPan({
        x: ps.startPan.x - (sx - ps.sx) / z,
        y: ps.startPan.y - (sy - ps.sy) / z,
      })
      requestRender()
      return
    }

    const world = screenToWorld(sx, sy)

    if (myStrokeRef.current) {
      const last = myStrokeRef.current.points[myStrokeRef.current.points.length - 1]
      const minStep = 0.5 / zoomRef.current
      if (Math.abs(last.x - world.x) > minStep || Math.abs(last.y - world.y) > minStep) {
        myStrokeRef.current.points.push(world)
        requestRender()
        broadcastProgress()
      }
      broadcastCursor(world, true)
      return
    }

    broadcastCursor(world, false)
    const hit = hitTestStroke(sx, sy)
    if (hit) {
      setHover((prev) =>
        prev && prev.stroke.id === hit.id && prev.sx === sx && prev.sy === sy
          ? prev
          : { stroke: hit, sx, sy },
      )
    } else if (hover) {
      setHover(null)
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (panStateRef.current?.active) {
      panStateRef.current = null
      try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
      return
    }
    const stroke = myStrokeRef.current
    if (!stroke) return
    myStrokeRef.current = null
    strokesRef.current.push(stroke)
    if (strokesRef.current.length > HISTORY_LIMIT) strokesRef.current.shift()
    requestRender()
    broadcastEnd()

    if (supabase) {
      supabase
        .from('strokes')
        .insert({
          id: stroke.id,
          client_id: stroke.client_id,
          nickname: stroke.nickname,
          color: stroke.color,
          width: stroke.width,
          points: stroke.points,
        })
        .then(({ error: err }) => {
          if (err) {
            setError(err.message)
            console.warn('stroke insert failed:', err.message)
          }
        })
    }
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
  }

  function onWheel(e: React.WheelEvent) {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const sx = e.clientX - rect.left
    const sy = e.clientY - rect.top
    const before = screenToWorld(sx, sy)
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current * factor))
    setZoom(next)
    setPan({ x: before.x - sx / next, y: before.y - sy / next })
    requestRender()
  }

  function hitTestStroke(sx: number, sy: number): Stroke | null {
    const world = screenToWorld(sx, sy)
    const tol = 4 / zoomRef.current
    for (let i = strokesRef.current.length - 1; i >= 0; i--) {
      const s = strokesRef.current[i]
      const r = s.width / 2 + tol
      const r2 = r * r
      const pts = s.points
      if (pts.length === 1) {
        const dx = pts[0].x - world.x
        const dy = pts[0].y - world.y
        if (dx * dx + dy * dy <= r2) return s
        continue
      }
      for (let j = 0; j < pts.length - 1; j++) {
        if (segDist2(pts[j], pts[j + 1], world) <= r2) return s
      }
    }
    return null
  }

  function segDist2(a: Point, b: Point, p: Point) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    if (len2 === 0) {
      const ex = p.x - a.x
      const ey = p.y - a.y
      return ex * ex + ey * ey
    }
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    const cx = a.x + t * dx
    const cy = a.y + t * dy
    const ex = p.x - cx
    const ey = p.y - cy
    return ex * ex + ey * ey
  }

  // Keyboard: space-to-pan, +/- zoom, 0 reset.
  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null
      return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    }
    function down(e: KeyboardEvent) {
      if (isTyping(e.target)) return
      if (e.key === ' ') {
        e.preventDefault()
        if (!spaceDownRef.current) {
          spaceDownRef.current = true
          setSpaceDownState(true)
        }
        return
      }
      if (e.key === '+' || e.key === '=') {
        e.preventDefault()
        zoomBy(1.2)
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        zoomBy(1 / 1.2)
      } else if (e.key === '0') {
        e.preventDefault()
        resetView()
      }
    }
    function up(e: KeyboardEvent) {
      if (e.key === ' ') {
        spaceDownRef.current = false
        setSpaceDownState(false)
      }
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  function zoomBy(factor: number) {
    const { w, h } = sizeRef.current
    const sx = w / 2
    const sy = h / 2
    const before = screenToWorld(sx, sy)
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomRef.current * factor))
    setZoom(next)
    setPan({ x: before.x - sx / next, y: before.y - sy / next })
    requestRender()
  }

  function resetView() {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    requestRender()
  }

  async function clearMine() {
    if (!supabase) return
    if (!window.confirm('¿Borrar todos tus trazos?')) return
    strokesRef.current = strokesRef.current.filter((s) => s.client_id !== clientId)
    requestRender()
    channelRef.current?.send({
      type: 'broadcast',
      event: 'clear-mine',
      payload: { client_id: clientId },
    })
    const { error: err } = await supabase.from('strokes').delete().eq('client_id', clientId)
    if (err) setError(err.message)
  }

  const cursors = [...cursorsRef.current.values()]
  const cursorClass = panStateRef.current?.active || spaceDown ? 'cursor-grabbing' : 'cursor-crosshair'

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-white">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(e) => {
          if (myStrokeRef.current) onPointerUp(e)
          else if (hover) setHover(null)
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        className={`block h-full w-full touch-none select-none ${cursorClass}`}
      />

      {/* Remote cursors overlay */}
      <div className="pointer-events-none absolute inset-0">
        {cursors.map((c) => {
          const s = worldToScreen({ x: c.x, y: c.y })
          if (s.x < -40 || s.y < -40) return null
          return (
            <div
              key={c.client_id}
              className="absolute will-change-transform"
              style={{ transform: `translate(${s.x}px, ${s.y}px)` }}
            >
              <CursorIcon color={c.color} />
              <span
                className="ml-3 -mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium text-white shadow"
                style={{ background: c.color }}
              >
                {c.nickname}
                {c.drawing && <span className="ml-1 opacity-80">✎</span>}
              </span>
            </div>
          )
        })}
      </div>

      {/* Author tooltip while hovering a stroke */}
      {hover && !myStrokeRef.current && (
        <div
          className="pointer-events-none absolute z-30 rounded-md border border-slate-300 bg-white/95 px-2 py-1 text-[11px] text-slate-800 shadow"
          style={{ left: hover.sx + 14, top: hover.sy + 14 }}
        >
          <span
            className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full align-middle"
            style={{ background: hover.stroke.color }}
          />
          Trazo de <strong>{hover.stroke.nickname}</strong>
        </div>
      )}

      {/* Toolbar */}
      <Toolbar
        color={color}
        onColor={setColor}
        width={width}
        onWidth={setWidth}
        zoom={zoom}
        onZoomIn={() => zoomBy(1.25)}
        onZoomOut={() => zoomBy(1 / 1.25)}
        onResetView={resetView}
        onClearMine={clearMine}
        canClear={chatEnabled}
      />

      {/* Bottom hint */}
      <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-slate-500">
        Click para dibujar · Rueda zoom · Espacio o Click derecho para mover · 0 reset
      </div>

      {!chatEnabled && (
        <div className="pointer-events-none absolute left-4 top-20 max-w-xs rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow">
          Realtime deshabilitado. Configura <code>VITE_SUPABASE_URL</code> y
          <code> VITE_SUPABASE_ANON_KEY</code> y aplica <code>supabase/schema.sql</code>.
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute left-4 top-20 max-w-xs rounded-lg border border-rose-300 bg-rose-50/95 px-3 py-2 text-xs text-rose-900 shadow">
          {error}
        </div>
      )}
    </div>
  )
}

function CursorIcon({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="drop-shadow">
      <path
        d="M3 2 L17 9 L10 11 L8 18 Z"
        fill={color}
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface ToolbarProps {
  color: string
  onColor: (c: string) => void
  width: number
  onWidth: (w: number) => void
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onResetView: () => void
  onClearMine: () => void
  canClear: boolean
}

function Toolbar({
  color,
  onColor,
  width,
  onWidth,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetView,
  onClearMine,
  canClear,
}: ToolbarProps) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2">
      <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-2xl border border-slate-300 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
        <div className="flex items-center gap-1">
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => onColor(c)}
              className={`h-6 w-6 rounded-full border transition ${
                color === c
                  ? 'border-slate-900 ring-2 ring-slate-900/30'
                  : 'border-slate-300 hover:scale-110'
              }`}
              style={{ background: c }}
              title={c}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>

        <div className="h-6 w-px bg-slate-200" />

        <div className="flex items-center gap-1">
          {SIZES.map((s) => (
            <button
              key={s}
              onClick={() => onWidth(s)}
              className={`flex h-7 w-7 items-center justify-center rounded-lg border text-slate-700 transition ${
                width === s ? 'border-slate-900 bg-slate-100' : 'border-slate-300 hover:bg-slate-50'
              }`}
              title={`Grosor ${s}`}
              aria-label={`Grosor ${s}`}
            >
              <span
                className="block rounded-full bg-current"
                style={{ width: Math.min(s, 16), height: Math.min(s, 16) }}
              />
            </button>
          ))}
        </div>

        <div className="h-6 w-px bg-slate-200" />

        <div className="flex items-center gap-1 text-slate-700">
          <button
            onClick={onZoomOut}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-300 text-base hover:bg-slate-50"
            title="Zoom out (-)"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={onResetView}
            className="min-w-[3.25rem] rounded-lg border border-slate-300 px-2 py-1 text-xs font-mono hover:bg-slate-50"
            title="Reset view (0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={onZoomIn}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-300 text-base hover:bg-slate-50"
            title="Zoom in (+)"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>

        <div className="h-6 w-px bg-slate-200" />

        <button
          onClick={onClearMine}
          disabled={!canClear}
          className="rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="Borrar mis trazos"
        >
          Borrar míos
        </button>
      </div>
    </div>
  )
}
