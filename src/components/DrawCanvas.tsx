import { useEffect, useMemo, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, chatEnabled } from '../lib/supabase'

interface Point { x: number; y: number }
type Tool = 'paint' | 'erase' | 'stamp'

interface StampData {
  // Rasterized image buffer used both for stamping and the preview
  // overlay. `bitmap` is an HTMLCanvasElement created via toCanvas().
  bitmap: HTMLCanvasElement
  width: number
  height: number
  data: Uint8ClampedArray
  name: string
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

interface PixelMeta {
  color: string
  client_id: string
  nickname: string
}

interface PixelChange {
  idx: number
  before: PixelMeta | null // null = pixel was empty (white) before
  after: PixelMeta | null  // null = pixel is now empty
}

const PALETTE = [
  '#0f172a', '#ef4444', '#f97316', '#facc15',
  '#22c55e', '#0ea5e9', '#8b5cf6', '#ec4899',
]
const SIZES = [1, 2, 4, 8]
const STAMP_SIZES = [32, 64, 128, 256]
const CURSOR_TTL_MS = 5000
const CANVAS_SIZE = 4000
const ZOOM_MIN = 0.05
const ZOOM_MAX = 32
const INITIAL_ZOOM = 0.5
// PostgREST caps single-response row counts (default 1000 in Supabase). We
// page in chunks of 1000 and keep going until the server returns an empty
// page — never trust `data.length < HISTORY_PAGE` as "end of stream".
const HISTORY_PAGE = 1000
// Realtime pacing
const BATCH_INTERVAL_MS = 50
const CURSOR_INTERVAL_MS = 35
// DB chunking
const UPSERT_CHUNK = 1000
const DELETE_CHUNK = 200
// Stamp broadcasts use multi-color batches; same chunk size as upserts.
const MULTI_BATCH_CHUNK = 2000
const UNDO_LIMIT = 30

function idxOf(x: number, y: number) {
  return x * CANVAS_SIZE + y
}
function xFromIdx(i: number) {
  return Math.floor(i / CANVAS_SIZE)
}
function yFromIdx(i: number) {
  return i - Math.floor(i / CANVAS_SIZE) * CANVAS_SIZE
}
function clampPx(v: number) {
  if (v < 0) return 0
  if (v >= CANVAS_SIZE) return CANVAS_SIZE - 1
  return Math.floor(v)
}
function isInsideCanvas(x: number, y: number) {
  return x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE
}

function rgbToHex(r: number, g: number, b: number) {
  const v = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
  return '#' + v.toString(16).padStart(6, '0')
}

function rasterizeStamp(img: HTMLImageElement, maxSize: number, name: string): StampData {
  const ratio = Math.min(maxSize / img.width, maxSize / img.height, 1)
  const w = Math.max(1, Math.round(img.width * ratio))
  const h = Math.max(1, Math.round(img.height * ratio))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(img, 0, 0, w, h)
  return {
    bitmap: c,
    width: w,
    height: h,
    data: ctx.getImageData(0, 0, w, h).data,
    name,
  }
}

function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = (e) => {
      URL.revokeObjectURL(url)
      reject(e)
    }
    img.src = url
  })
}

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
  interactive?: boolean
}

export function DrawCanvas({ nickname, interactive = true }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)

  const clientId = useMemo(() => genClientId(), [])
  const myColor = useMemo(() => stableColor(clientId), [clientId])

  const [color, setColor] = useState<string>('#0f172a')
  const [tool, setTool] = useState<Tool>('paint')
  const [width, setWidthState] = useState<number>(2)
  const [zoom, setZoomState] = useState<number>(INITIAL_ZOOM)
  const [pan, setPanState] = useState<Point>({ x: 0, y: 0 })
  const [hover, setHover] = useState<{ meta: PixelMeta; x: number; y: number; sx: number; sy: number } | null>(null)
  const [, setCursorTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [spaceDown, setSpaceDownState] = useState(false)
  const [loading, setLoading] = useState(false)
  const [stamp, setStampState] = useState<StampData | null>(null)
  const [stampSize, setStampSizeState] = useState<number>(128)
  const [stamping, setStamping] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveStats, setSaveStats] = useState<{ paints: number; erases: number; ts: number } | null>(null)
  const [historyCount, setHistoryCount] = useState(0)

  const colorRef = useRef(color)
  const widthRef = useRef(width)
  const toolRef = useRef(tool)
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  const spaceDownRef = useRef(false)
  const interactiveRef = useRef(interactive)
  const stampRef = useRef<StampData | null>(null)
  const stampSizeRef = useRef(128)
  const stampSourceRef = useRef<HTMLImageElement | null>(null)
  // Cursor world position when in stamp mode (for the live preview).
  const stampHoverRef = useRef<Point | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pixel attribution: idx -> {color, client_id, nickname}
  const attributionRef = useRef<Map<number, PixelMeta>>(new Map())
  // Pixels affected by the in-flight stroke that haven't been broadcast yet.
  const pendingRef = useRef<{
    color: string | null // null = erase
    pixels: Map<number, [number, number]>
  } | null>(null)
  // All pixels touched by the current stroke (deduped by idx). Persisted on stroke-end.
  const sessionDirtyRef = useRef<Map<number, { x: number; y: number; color: string | null }>>(new Map())
  // Snapshot of attribution before the current stroke modified each pixel,
  // used to build undo entries.
  const sessionBeforeRef = useRef<Map<number, PixelMeta | null>>(new Map())
  // Local-only undo stack of past stroke/stamp changes.
  const undoStackRef = useRef<PixelChange[][]>([])
  const drawingRef = useRef(false)
  const lastPaintRef = useRef<{ x: number; y: number } | null>(null)

  const cursorsRef = useRef<Map<string, Cursor>>(new Map())
  const channelRef = useRef<RealtimeChannel | null>(null)
  const lastCursorBroadcast = useRef(0)
  const lastBatchBroadcast = useRef(0)

  const sizeRef = useRef({ w: 0, h: 0, dpr: 1 })
  const renderPendingRef = useRef(false)
  const panStateRef = useRef<{ active: boolean; sx: number; sy: number; startPan: Point } | null>(null)
  const fittedRef = useRef(false)

  useEffect(() => { colorRef.current = color }, [color])
  useEffect(() => { widthRef.current = width }, [width])
  useEffect(() => { toolRef.current = tool }, [tool])
  useEffect(() => { stampRef.current = stamp }, [stamp])
  useEffect(() => { stampSizeRef.current = stampSize }, [stampSize])
  useEffect(() => {
    interactiveRef.current = interactive
    if (!interactive) {
      if (drawingRef.current) endStroke()
      spaceDownRef.current = false
      setSpaceDownState(false)
      panStateRef.current = null
      stampHoverRef.current = null
      requestRender()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive])

  // Init the offscreen 4000x4000 raster used as the source-of-truth.
  useEffect(() => {
    const c = document.createElement('canvas')
    c.width = CANVAS_SIZE
    c.height = CANVAS_SIZE
    offscreenRef.current = c
    requestRender()
  }, [])

  function getOffCtx(): CanvasRenderingContext2D | null {
    return offscreenRef.current?.getContext('2d') ?? null
  }

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
    const off = offscreenRef.current
    const { w, h, dpr } = sizeRef.current

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#e2e8f0'
    ctx.fillRect(0, 0, w, h)

    const z = zoomRef.current
    const p = panRef.current
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * -p.x * z, dpr * -p.y * z)

    // Always paint the white page underneath so erased pixels reveal white.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)

    if (off) {
      // Crisp pixels when zoomed in; smooth resampling when zoomed out.
      ctx.imageSmoothingEnabled = z < 1
      ctx.drawImage(off, 0, 0)
    }

    // Stamp preview overlay (local-only, semi-transparent at cursor).
    const sd = stampRef.current
    const hover = stampHoverRef.current
    if (toolRef.current === 'stamp' && sd && hover) {
      ctx.imageSmoothingEnabled = false
      ctx.globalAlpha = 0.55
      const sx = Math.round(hover.x - sd.width / 2)
      const sy = Math.round(hover.y - sd.height / 2)
      ctx.drawImage(sd.bitmap, sx, sy)
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.6)'
      ctx.lineWidth = Math.max(1 / z, 0.5)
      ctx.strokeRect(sx + 0.5, sy + 0.5, sd.width - 1, sd.height - 1)
    }

    ctx.imageSmoothingEnabled = true
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.25)'
    ctx.lineWidth = Math.max(1 / z, 0.5)
    ctx.strokeRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
  }

  // ---- Pixel ops ---------------------------------------------------------
  function paintPixelLocal(x: number, y: number, c: string, meta: { client_id: string; nickname: string }) {
    const ctx = getOffCtx()
    if (!ctx) return
    ctx.fillStyle = c
    ctx.fillRect(x, y, 1, 1)
    attributionRef.current.set(idxOf(x, y), { color: c, client_id: meta.client_id, nickname: meta.nickname })
  }

  function erasePixelLocal(x: number, y: number) {
    const ctx = getOffCtx()
    if (!ctx) return
    ctx.clearRect(x, y, 1, 1)
    attributionRef.current.delete(idxOf(x, y))
  }

  // For local actions (paint/erase/stamp): record the pixel's prior state the
  // first time it's touched in the current stroke, so we can undo later.
  function capturePixelBefore(x: number, y: number) {
    const key = idxOf(x, y)
    const before = sessionBeforeRef.current
    if (before.has(key)) return
    const prev = attributionRef.current.get(key)
    before.set(key, prev ? { ...prev } : null)
  }

  function commitUndoEntry() {
    const before = sessionBeforeRef.current
    if (before.size === 0) return
    const entry: PixelChange[] = []
    for (const [key, b] of before) {
      const a = attributionRef.current.get(key)
      // Skip pixels whose state is unchanged (e.g. you painted the same color
      // they already had).
      if (b && a && b.color === a.color && b.client_id === a.client_id) continue
      if (!b && !a) continue
      entry.push({ idx: key, before: b, after: a ? { ...a } : null })
    }
    sessionBeforeRef.current = new Map()
    if (entry.length === 0) return
    undoStackRef.current.push(entry)
    while (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift()
    setUndoCount(undoStackRef.current.length)
  }

  function applyBrush(
    cx: number,
    cy: number,
    isErase: boolean,
    c: string,
    meta: { client_id: string; nickname: string },
    dirty: Map<number, [number, number]>,
  ) {
    const w = widthRef.current
    const half = Math.floor(w / 2)
    for (let dy = 0; dy < w; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const px = cx - half + dx
        const py = cy - half + dy
        if (!isInsideCanvas(px, py)) continue
        const key = idxOf(px, py)
        if (dirty.has(key)) continue
        dirty.set(key, [px, py])
        capturePixelBefore(px, py)
        if (isErase) erasePixelLocal(px, py)
        else paintPixelLocal(px, py, c, meta)
      }
    }
  }

  function* linePoints(x0: number, y0: number, x1: number, y1: number): Generator<[number, number]> {
    let cx = x0, cy = y0
    const dx = Math.abs(x1 - cx)
    const dy = -Math.abs(y1 - cy)
    const sx = cx < x1 ? 1 : -1
    const sy = cy < y1 ? 1 : -1
    let err = dx + dy
    // Safety bound: 4000+4000 = 8000 max steps.
    for (let i = 0; i <= 8200; i++) {
      yield [cx, cy]
      if (cx === x1 && cy === y1) return
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; cx += sx }
      if (e2 <= dx) { err += dx; cy += sy }
    }
  }

  function paintAt(cx: number, cy: number) {
    const pending = pendingRef.current
    if (!pending) return
    const isErase = toolRef.current === 'erase'
    const c = colorRef.current
    const meta = { client_id: clientId, nickname }

    const last = lastPaintRef.current
    if (last) {
      for (const [x, y] of linePoints(last.x, last.y, cx, cy)) {
        applyBrush(x, y, isErase, c, meta, pending.pixels)
      }
    } else {
      applyBrush(cx, cy, isErase, c, meta, pending.pixels)
    }
    lastPaintRef.current = { x: cx, y: cy }

    // Mirror to the session-dirty set for end-of-stroke persistence.
    for (const [key, [x, y]] of pending.pixels) {
      sessionDirtyRef.current.set(key, { x, y, color: isErase ? null : c })
    }

    requestRender()
    maybeBroadcastBatch()
  }

  function startStroke(cx: number, cy: number) {
    drawingRef.current = true
    pendingRef.current = {
      color: toolRef.current === 'erase' ? null : colorRef.current,
      pixels: new Map(),
    }
    lastPaintRef.current = null
    paintAt(cx, cy)
  }

  function endStroke() {
    if (!drawingRef.current) return
    drawingRef.current = false
    flushBatch()
    pendingRef.current = null
    lastPaintRef.current = null
    commitUndoEntry()
    flushPersist()
  }

  // ---- Realtime broadcast ------------------------------------------------
  function maybeBroadcastBatch() {
    const now = performance.now()
    if (now - lastBatchBroadcast.current < BATCH_INTERVAL_MS) return
    flushBatch()
  }

  function flushBatch() {
    const ch = channelRef.current
    const pending = pendingRef.current
    if (!ch || !pending || pending.pixels.size === 0) return
    lastBatchBroadcast.current = performance.now()
    const ops = Array.from(pending.pixels.values())
    pending.pixels.clear()
    ch.send({
      type: 'broadcast',
      event: 'pixel-batch',
      payload: {
        client_id: clientId,
        nickname,
        color: pending.color, // null means erase
        ops,
      },
    })
  }

  function broadcastCursor(world: Point, drawing: boolean, force = false) {
    if (!channelRef.current) return
    const now = performance.now()
    if (!force && now - lastCursorBroadcast.current < CURSOR_INTERVAL_MS) return
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

  // ---- Persistence (chunked) --------------------------------------------
  // Sort rows by `idx` so every client takes row locks in the same order —
  // prevents deadlocks when two users upsert overlapping pixels at the same
  // time. Retries the chunk once on serialization failures (40001) and
  // deadlocks (40P01) before surfacing the error.
  async function upsertWithRetry(
    rows: Array<{ idx: number; x: number; y: number; color: string; client_id: string; nickname: string }>,
  ): Promise<{ error: { message: string; code?: string } | null }> {
    rows.sort((a, b) => a.idx - b.idx)
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error: err } = await supabase!
        .from('pixels')
        .upsert(rows, { onConflict: 'idx' })
      if (!err) return { error: null }
      const code = (err as { code?: string }).code
      console.warn(`[draw] upsert attempt ${attempt + 1} failed:`, err.message, 'code=', code, err)
      if (code !== '40001' && code !== '40P01') return { error: err }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
    return { error: { message: 'upsert failed after retry', code: 'retry-exhausted' } }
  }

  async function deleteWithRetry(ids: number[]): Promise<{ error: { message: string; code?: string } | null }> {
    ids.sort((a, b) => a - b)
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error: err } = await supabase!.from('pixels').delete().in('idx', ids)
      if (!err) return { error: null }
      const code = (err as { code?: string }).code
      console.warn(`[draw] delete attempt ${attempt + 1} failed:`, err.message, 'code=', code, err)
      if (code !== '40001' && code !== '40P01') return { error: err }
      await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
    }
    return { error: { message: 'delete failed after retry', code: 'retry-exhausted' } }
  }

  async function flushPersist() {
    if (!supabase) {
      sessionDirtyRef.current.clear()
      return
    }
    const items = Array.from(sessionDirtyRef.current.values())
    sessionDirtyRef.current = new Map()
    if (items.length === 0) return

    const paints = items.filter((it) => it.color !== null)
    const erases = items.filter((it) => it.color === null)

    setSaving(true)
    let savedPaints = 0
    let savedErases = 0
    try {
      for (let i = 0; i < paints.length; i += UPSERT_CHUNK) {
        const slice = paints.slice(i, i + UPSERT_CHUNK)
        const rows = slice.map((it) => ({
          idx: idxOf(it.x, it.y),
          x: it.x,
          y: it.y,
          color: it.color as string,
          client_id: clientId,
          nickname,
        }))
        const { error: err } = await upsertWithRetry(rows)
        if (err) {
          setError(`Upsert: ${err.message}${err.code ? ` (${err.code})` : ''}`)
          console.error('[draw] flushPersist upsert failed; sample row:', rows[0])
          return
        }
        savedPaints += rows.length
      }
      for (let i = 0; i < erases.length; i += DELETE_CHUNK) {
        const slice = erases.slice(i, i + DELETE_CHUNK)
        const ids = slice.map((it) => idxOf(it.x, it.y))
        const { error: err } = await deleteWithRetry(ids)
        if (err) {
          setError(`Delete: ${err.message}${err.code ? ` (${err.code})` : ''}`)
          return
        }
        savedErases += ids.length
      }
      if (savedPaints + savedErases > 0) {
        console.log(`[draw] persisted ${savedPaints} paints, ${savedErases} erases`)
        setSaveStats({ paints: savedPaints, erases: savedErases, ts: Date.now() })
      }
    } finally {
      setSaving(false)
    }
  }

  // ---- Resize / fit ------------------------------------------------------
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
      if (!fittedRef.current && w > 0 && h > 0) {
        fittedRef.current = true
        resetView()
        return
      }
      requestRender()
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Initial / reset view: 50% zoom, page centered in the viewport.
  function resetView() {
    const { w, h } = sizeRef.current
    if (w <= 0 || h <= 0) return
    const next = INITIAL_ZOOM
    setZoom(next)
    setPan({
      x: -(w - CANVAS_SIZE * next) / 2 / next,
      y: -(h - CANVAS_SIZE * next) / 2 / next,
    })
    requestRender()
  }

  // ---- History load + realtime subscribe --------------------------------
  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    setLoading(true)

    ;(async () => {
      const t0 = performance.now()
      const off = offscreenRef.current
      const offCtx = off?.getContext('2d') ?? null
      if (!off || !offCtx) return

      // Get the exact row count first so we can fan out parallel range
      // requests instead of paging sequentially. PostgREST caps responses at
      // 1000 rows, so for thousands of pixels the sequential loop is the
      // dominant cost — many round-trips at ~100-300ms each.
      const { count, error: countErr } = await supabase!
        .from('pixels')
        .select('*', { count: 'exact', head: true })
      if (cancelled) return
      if (countErr) {
        console.error('[draw] history count failed:', countErr.message, countErr)
        setError(`No se pudo cargar el historial: ${countErr.message}`)
        if (!cancelled) setLoading(false)
        return
      }
      const totalRows = count ?? 0
      if (totalRows === 0) {
        console.log('[draw] history load complete: 0 pixels')
        if (!cancelled) setLoading(false)
        return
      }

      // Build a single ImageData buffer for the offscreen canvas; writing
      // pixel bytes directly is dramatically faster than thousands of
      // fillRect calls. We blit it once at the end.
      const imageData = offCtx.createImageData(CANVAS_SIZE, CANVAS_SIZE)
      const px = imageData.data
      const totalPages = Math.ceil(totalRows / HISTORY_PAGE)
      let loaded = 0
      let pageCursor = 0
      let aborted = false
      const CONCURRENCY = 6

      async function fetchPage(pageIdx: number) {
        const fromRow = pageIdx * HISTORY_PAGE
        const { data, error: err } = await supabase!
          .from('pixels')
          .select('x, y, color, client_id, nickname')
          .order('idx', { ascending: true })
          .range(fromRow, fromRow + HISTORY_PAGE - 1)
        if (err) {
          console.error('[draw] history page', pageIdx, 'failed:', err.message, err)
          setError(`No se pudo cargar el historial: ${err.message}`)
          aborted = true
          return
        }
        if (!data) return
        const rows = data as { x: number; y: number; color: string; client_id: string; nickname: string }[]
        for (const row of rows) {
          // Hex like "#rrggbb" -> bytes
          const v = parseInt(row.color.slice(1), 16) | 0
          const i = (row.y * CANVAS_SIZE + row.x) * 4
          px[i] = (v >> 16) & 0xff
          px[i + 1] = (v >> 8) & 0xff
          px[i + 2] = v & 0xff
          px[i + 3] = 255
          attributionRef.current.set(idxOf(row.x, row.y), {
            color: row.color,
            client_id: row.client_id,
            nickname: row.nickname,
          })
        }
        loaded += rows.length
        setHistoryCount(loaded)
      }

      async function worker() {
        while (!cancelled && !aborted) {
          const i = pageCursor++
          if (i >= totalPages) return
          await fetchPage(i)
        }
      }

      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
      if (cancelled) return

      // Single blit: WAY cheaper than tens of thousands of fillRect calls.
      offCtx.putImageData(imageData, 0, 0)
      requestRender()

      const ms = Math.round(performance.now() - t0)
      console.log(`[draw] history load complete: ${loaded} pixels in ${ms}ms`)
      if (!cancelled) setLoading(false)
    })()

    const ch = supabase
      .channel('whiteboard', { config: { broadcast: { self: false } } })
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
      .on('broadcast', { event: 'pixel-batch' }, ({ payload }) => {
        if (!payload || payload.client_id === clientId) return
        const c: string | null = payload.color
        const ops = payload.ops as [number, number][] | undefined
        if (!ops || ops.length === 0) return
        const isErase = c === null
        const meta = { client_id: payload.client_id, nickname: payload.nickname }
        for (const [x, y] of ops) {
          if (!isInsideCanvas(x, y)) continue
          if (isErase) erasePixelLocal(x, y)
          else paintPixelLocal(x, y, c as string, meta)
        }
        requestRender()
      })
      .on('broadcast', { event: 'pixel-batch-multi' }, ({ payload }) => {
        if (!payload || payload.client_id === clientId) return
        const ops = payload.ops as [number, number, string][] | undefined
        if (!ops || ops.length === 0) return
        const meta = { client_id: payload.client_id, nickname: payload.nickname }
        for (const [x, y, c] of ops) {
          if (!isInsideCanvas(x, y)) continue
          paintPixelLocal(x, y, c, meta)
        }
        requestRender()
      })
      .on('broadcast', { event: 'clear-mine' }, ({ payload }) => {
        const cid = payload?.client_id
        if (!cid) return
        const toErase: number[] = []
        for (const [key, meta] of attributionRef.current) {
          if (meta.client_id === cid) toErase.push(key)
        }
        for (const key of toErase) erasePixelLocal(xFromIdx(key), yFromIdx(key))
        if (toErase.length > 0) requestRender()
      })
      .subscribe()
    channelRef.current = ch

    return () => {
      cancelled = true
      ch.unsubscribe()
      channelRef.current = null
    }
  }, [clientId])

  // Auto-dismiss the save confirmation toast after a few seconds.
  useEffect(() => {
    if (!saveStats) return
    const id = window.setTimeout(() => setSaveStats(null), 2500)
    return () => window.clearTimeout(id)
  }, [saveStats])

  // Sweep stale cursors
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

  function startPan(sx: number, sy: number, target: HTMLElement, pointerId: number) {
    panStateRef.current = { active: true, sx, sy, startPan: { ...panRef.current } }
    try { target.setPointerCapture(pointerId) } catch { /* noop */ }
  }

  // ---- Stamp tool --------------------------------------------------------
  async function pickStampFile(file: File) {
    try {
      const img = await loadImageFile(file)
      stampSourceRef.current = img
      const data = rasterizeStamp(img, stampSizeRef.current, file.name)
      setStampState(data)
      setTool('stamp')
    } catch (err) {
      setError('No se pudo leer la imagen.')
      console.warn('stamp load failed', err)
    }
  }

  function rebuildStampAtSize(maxSize: number) {
    const img = stampSourceRef.current
    if (!img) return
    const data = rasterizeStamp(img, maxSize, stampRef.current?.name ?? 'imagen')
    setStampState(data)
  }

  function setStampSize(size: number) {
    setStampSizeState(size)
    rebuildStampAtSize(size)
  }

  function clearStamp() {
    stampSourceRef.current = null
    setStampState(null)
    if (toolRef.current === 'stamp') setTool('paint')
    requestRender()
  }

  async function stampAt(cx: number, cy: number) {
    const sd = stampRef.current
    if (!sd) return
    setStamping(true)
    try {
      const { data, width: w, height: h } = sd
      const startX = Math.round(cx - w / 2)
      const startY = Math.round(cy - h / 2)
      const ops: [number, number, string][] = []
      const meta = { client_id: clientId, nickname }
      const dirty = sessionDirtyRef.current
      for (let iy = 0; iy < h; iy++) {
        for (let ix = 0; ix < w; ix++) {
          const i = (iy * w + ix) * 4
          if (data[i + 3] < 128) continue // skip transparent
          const px = startX + ix
          const py = startY + iy
          if (!isInsideCanvas(px, py)) continue
          const c = rgbToHex(data[i], data[i + 1], data[i + 2])
          capturePixelBefore(px, py)
          paintPixelLocal(px, py, c, meta)
          ops.push([px, py, c])
          dirty.set(idxOf(px, py), { x: px, y: py, color: c })
        }
      }
      if (ops.length === 0) {
        setStamping(false)
        sessionBeforeRef.current = new Map()
        return
      }
      requestRender()
      commitUndoEntry()

      // Broadcast in chunks (multi-color batch).
      const ch = channelRef.current
      if (ch) {
        for (let i = 0; i < ops.length; i += MULTI_BATCH_CHUNK) {
          ch.send({
            type: 'broadcast',
            event: 'pixel-batch-multi',
            payload: {
              client_id: clientId,
              nickname,
              ops: ops.slice(i, i + MULTI_BATCH_CHUNK),
            },
          })
        }
      }
      await flushPersist()
    } finally {
      setStamping(false)
    }
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
    if (!isInsideCanvas(world.x, world.y)) {
      broadcastCursor(world, false, true)
      return
    }

    // Stamp tool: a single click stamps the loaded image, no drag stroke.
    if (toolRef.current === 'stamp' && stampRef.current) {
      setHover(null)
      broadcastCursor(world, true, true)
      stampAt(clampPx(world.x), clampPx(world.y))
      return
    }

    setHover(null)
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId) } catch { /* noop */ }
    startStroke(clampPx(world.x), clampPx(world.y))
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

    if (drawingRef.current) {
      if (isInsideCanvas(world.x, world.y)) {
        paintAt(clampPx(world.x), clampPx(world.y))
      } else {
        // Out of canvas: keep stroke alive but skip this point.
      }
      broadcastCursor(world, true)
      return
    }

    broadcastCursor(world, false)

    // Live stamp preview when stamp tool is active.
    if (toolRef.current === 'stamp' && stampRef.current) {
      if (isInsideCanvas(world.x, world.y)) {
        stampHoverRef.current = { x: world.x, y: world.y }
      } else {
        stampHoverRef.current = null
      }
      requestRender()
      if (hover) setHover(null)
      return
    } else if (stampHoverRef.current) {
      stampHoverRef.current = null
      requestRender()
    }

    // Hover attribution: show who painted the pixel under the cursor.
    const hx = Math.floor(world.x)
    const hy = Math.floor(world.y)
    if (isInsideCanvas(hx, hy)) {
      const meta = attributionRef.current.get(idxOf(hx, hy))
      if (meta) {
        setHover((prev) => {
          if (prev && prev.x === hx && prev.y === hy) return { ...prev, sx, sy }
          return { meta, x: hx, y: hy, sx, sy }
        })
      } else if (hover) {
        setHover(null)
      }
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
    if (drawingRef.current) {
      endStroke()
      try { (e.target as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* noop */ }
    }
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

  // Keyboard: space=pan, +/- zoom, 0 fit, e=erase, b=paint
  useEffect(() => {
    function isTyping(t: EventTarget | null) {
      const el = t as HTMLElement | null
      return !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable))
    }
    function down(e: KeyboardEvent) {
      if (isTyping(e.target)) return
      if (!interactiveRef.current) return
      if (e.key === ' ') {
        e.preventDefault()
        if (!spaceDownRef.current) {
          spaceDownRef.current = true
          setSpaceDownState(true)
        }
        return
      }
      // Ctrl+Z / Cmd+Z = undo. Don't trigger redo on Ctrl+Shift+Z.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
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
      } else if (e.key.toLowerCase() === 'e') {
        setTool('erase')
      } else if (e.key.toLowerCase() === 'b') {
        setTool('paint')
      } else if (e.key.toLowerCase() === 's') {
        if (stampRef.current) setTool('stamp')
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

  async function clearMine() {
    if (!supabase) return
    if (!window.confirm('¿Borrar todos tus píxeles?')) return
    const toErase: number[] = []
    for (const [key, meta] of attributionRef.current) {
      if (meta.client_id === clientId) toErase.push(key)
    }
    for (const key of toErase) erasePixelLocal(xFromIdx(key), yFromIdx(key))
    if (toErase.length > 0) requestRender()
    // Clear-mine wipes the local undo stack — those changes are no longer
    // reversible without a full reload from the server.
    undoStackRef.current = []
    setUndoCount(0)
    channelRef.current?.send({
      type: 'broadcast',
      event: 'clear-mine',
      payload: { client_id: clientId },
    })
    const { error: err } = await supabase.from('pixels').delete().eq('client_id', clientId)
    if (err) setError(err.message)
  }

  async function undo() {
    const entry = undoStackRef.current.pop()
    setUndoCount(undoStackRef.current.length)
    if (!entry) return

    const paintOps: [number, number, string][] = []
    const eraseOps: [number, number][] = []
    const upsertRows: Array<{
      idx: number
      x: number
      y: number
      color: string
      client_id: string
      nickname: string
    }> = []
    const deleteIds: number[] = []

    for (const { idx: key, before } of entry) {
      const x = xFromIdx(key)
      const y = yFromIdx(key)
      if (before) {
        paintPixelLocal(x, y, before.color, {
          client_id: before.client_id,
          nickname: before.nickname,
        })
        paintOps.push([x, y, before.color])
        upsertRows.push({
          idx: key,
          x,
          y,
          color: before.color,
          // Restore the original author so the DB row keeps correct attribution.
          client_id: before.client_id,
          nickname: before.nickname,
        })
      } else {
        erasePixelLocal(x, y)
        eraseOps.push([x, y])
        deleteIds.push(key)
      }
    }
    requestRender()

    const ch = channelRef.current
    if (ch) {
      for (let i = 0; i < paintOps.length; i += MULTI_BATCH_CHUNK) {
        ch.send({
          type: 'broadcast',
          event: 'pixel-batch-multi',
          payload: {
            client_id: clientId,
            nickname,
            ops: paintOps.slice(i, i + MULTI_BATCH_CHUNK),
          },
        })
      }
      if (eraseOps.length > 0) {
        for (let i = 0; i < eraseOps.length; i += MULTI_BATCH_CHUNK) {
          ch.send({
            type: 'broadcast',
            event: 'pixel-batch',
            payload: {
              client_id: clientId,
              nickname,
              color: null,
              ops: eraseOps.slice(i, i + MULTI_BATCH_CHUNK),
            },
          })
        }
      }
    }

    if (!supabase) return
    setSaving(true)
    try {
      for (let i = 0; i < upsertRows.length; i += UPSERT_CHUNK) {
        const slice = upsertRows.slice(i, i + UPSERT_CHUNK)
        const { error: err } = await upsertWithRetry(slice)
        if (err) {
          setError(`Undo upsert: ${err.message}${err.code ? ` (${err.code})` : ''}`)
          return
        }
      }
      for (let i = 0; i < deleteIds.length; i += DELETE_CHUNK) {
        const slice = deleteIds.slice(i, i + DELETE_CHUNK)
        const { error: err } = await deleteWithRetry(slice)
        if (err) {
          setError(`Undo delete: ${err.message}${err.code ? ` (${err.code})` : ''}`)
          return
        }
      }
    } finally {
      setSaving(false)
    }
  }

  const cursors = [...cursorsRef.current.values()]
  const cursorClass = panStateRef.current?.active || spaceDown ? 'cursor-grabbing' : 'cursor-crosshair'

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden bg-slate-200">
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={(e) => {
          if (drawingRef.current) onPointerUp(e)
          else if (hover) setHover(null)
          if (stampHoverRef.current) {
            stampHoverRef.current = null
            requestRender()
          }
        }}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        className={`block h-full w-full touch-none select-none ${
          interactive ? cursorClass : 'pointer-events-none'
        }`}
      />

      {/* Remote cursors overlay */}
      <div className="pointer-events-none absolute inset-0">
        {cursors.map((c) => {
          const s = worldToScreen({ x: c.x, y: c.y })
          const { w, h } = sizeRef.current
          if (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 40) return null
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

      {/* Author tooltip while hovering a painted pixel */}
      {hover && !drawingRef.current && (
        <div
          className="pointer-events-none absolute z-30 rounded-md border border-slate-300 bg-white/95 px-2 py-1 text-[11px] text-slate-800 shadow"
          style={{ left: hover.sx + 14, top: hover.sy + 14 }}
        >
          <span
            className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm border border-slate-400/40 align-middle"
            style={{ background: hover.meta.color }}
          />
          ({hover.x},{hover.y}) · <strong>{hover.meta.nickname}</strong>
        </div>
      )}

      {/* Toolbar */}
      {interactive && (
        <Toolbar
          color={color}
          onColor={(c) => { setColor(c); setTool('paint') }}
          width={width}
          onWidth={setWidth}
          tool={tool}
          onTool={(t) => {
            if (t === 'stamp') {
              if (stampRef.current) setTool('stamp')
              else fileInputRef.current?.click()
            } else {
              setTool(t)
            }
          }}
          zoom={zoom}
          onZoomIn={() => zoomBy(1.25)}
          onZoomOut={() => zoomBy(1 / 1.25)}
          onResetView={resetView}
          onClearMine={clearMine}
          canClear={chatEnabled}
          stamp={stamp}
          stampSize={stampSize}
          onStampSize={setStampSize}
          onPickStamp={() => fileInputRef.current?.click()}
          onClearStamp={clearStamp}
          canUndo={undoCount > 0}
          onUndo={undo}
        />
      )}

      {/* Hidden file input used by the stamp tool */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) pickStampFile(file)
          // Reset so picking the same file twice fires onChange.
          e.target.value = ''
        }}
      />

      {/* Bottom hint */}
      {interactive && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-[10px] uppercase tracking-widest text-slate-500">
          Lienzo {CANVAS_SIZE}×{CANVAS_SIZE} · B pintar · E borrar · S estampar · Ctrl+Z deshacer · Rueda zoom · Espacio mueve · 0 ajusta
        </div>
      )}

      {(stamping || loading || saving) && (
        <div className="pointer-events-none absolute right-4 top-20 rounded-lg border border-slate-300 bg-white/95 px-3 py-2 text-xs text-slate-700 shadow">
          {stamping
            ? 'Estampando…'
            : loading
              ? `Cargando lienzo… ${historyCount > 0 ? `(${historyCount.toLocaleString()} px)` : ''}`
              : 'Guardando…'}
        </div>
      )}

      {!stamping && !loading && !saving && saveStats && (
        <div className="pointer-events-none absolute right-4 top-20 rounded-lg border border-emerald-300 bg-emerald-50/95 px-3 py-2 text-xs text-emerald-800 shadow">
          ✓ Guardado: {saveStats.paints > 0 && `${saveStats.paints} px`}
          {saveStats.paints > 0 && saveStats.erases > 0 && ', '}
          {saveStats.erases > 0 && `${saveStats.erases} borrados`}
        </div>
      )}

      {!chatEnabled && (
        <div className="pointer-events-none absolute left-4 top-20 max-w-xs rounded-lg border border-amber-300 bg-amber-50/95 px-3 py-2 text-xs text-amber-900 shadow">
          Realtime deshabilitado. Configura <code>VITE_SUPABASE_URL</code> y
          <code> VITE_SUPABASE_ANON_KEY</code> y aplica <code>supabase/schema.sql</code>.
        </div>
      )}
      {error && (
        <div className="pointer-events-auto absolute left-4 top-20 max-w-md rounded-lg border border-rose-300 bg-rose-50/95 px-3 py-2 text-xs text-rose-900 shadow">
          <strong>Error de Supabase:</strong> {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 rounded px-1 text-rose-700 hover:bg-rose-100"
          >
            ×
          </button>
          <div className="mt-1 text-[10px] text-rose-700/80">Mirá la consola del navegador (F12) para más detalles.</div>
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
  tool: Tool
  onTool: (t: Tool) => void
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onResetView: () => void
  onClearMine: () => void
  canClear: boolean
  stamp: StampData | null
  stampSize: number
  onStampSize: (size: number) => void
  onPickStamp: () => void
  onClearStamp: () => void
  canUndo: boolean
  onUndo: () => void
}

function Toolbar({
  color,
  onColor,
  width,
  onWidth,
  tool,
  onTool,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetView,
  onClearMine,
  canClear,
  stamp,
  stampSize,
  onStampSize,
  onPickStamp,
  onClearStamp,
  canUndo,
  onUndo,
}: ToolbarProps) {
  const dimColors = tool !== 'paint'
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2">
      <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-2xl border border-slate-300 bg-white/95 px-3 py-2 shadow-lg backdrop-blur">
        <div className={`flex items-center gap-1 transition ${dimColors ? 'opacity-50' : ''}`}>
          {PALETTE.map((c) => (
            <button
              key={c}
              onClick={() => onColor(c)}
              className={`h-6 w-6 rounded-full border transition ${
                color === c && !dimColors
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
          <button
            onClick={() => onTool('paint')}
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
              tool === 'paint'
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
            title="Pintar (B)"
          >
            <span aria-hidden>✏️</span>
            <span>Pintar</span>
          </button>
          <button
            onClick={() => onTool('erase')}
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
              tool === 'erase'
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
            title="Borrar (E)"
          >
            <span aria-hidden>🧽</span>
            <span>Borrar</span>
          </button>
          <button
            onClick={() => onTool('stamp')}
            className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
              tool === 'stamp'
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
            title="Estampar imagen (S)"
          >
            <span aria-hidden>🖼️</span>
            <span>Estampar imagen</span>
          </button>
        </div>

        {tool === 'stamp' && (
          <>
            <div className="h-6 w-px bg-slate-200" />
            <div className="flex items-center gap-2">
              {stamp ? (
                <>
                  <div className="flex items-center gap-1 rounded-lg border border-slate-300 bg-slate-50 px-1.5 py-0.5">
                    <img
                      src={stamp.bitmap.toDataURL()}
                      alt={stamp.name}
                      className="h-6 w-6 rounded object-contain"
                      style={{ imageRendering: 'pixelated' }}
                    />
                    <span className="max-w-[7rem] truncate text-[11px] text-slate-700">{stamp.name}</span>
                    <button
                      onClick={onClearStamp}
                      className="rounded px-1 text-[11px] text-slate-500 hover:bg-slate-200"
                      title="Quitar estampa"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex items-center gap-1">
                    {STAMP_SIZES.map((s) => (
                      <button
                        key={s}
                        onClick={() => onStampSize(s)}
                        className={`flex h-7 min-w-[2.25rem] items-center justify-center rounded-lg border px-1 text-[11px] font-mono transition ${
                          stampSize === s
                            ? 'border-slate-900 bg-slate-100 text-slate-900'
                            : 'border-slate-300 text-slate-700 hover:bg-slate-50'
                        }`}
                        title={`Tamaño ${s} px`}
                      >
                        {s}px
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <button
                  onClick={onPickStamp}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                >
                  Cargar imagen…
                </button>
              )}
            </div>
          </>
        )}

        <div className="h-6 w-px bg-slate-200" />

        <div className={`flex items-center gap-1 transition ${tool === 'stamp' ? 'opacity-50' : ''}`}>
          {SIZES.map((s) => (
            <button
              key={s}
              onClick={() => onWidth(s)}
              className={`flex h-7 min-w-[1.75rem] items-center justify-center rounded-lg border px-1 text-[11px] font-mono transition ${
                width === s
                  ? 'border-slate-900 bg-slate-100 text-slate-900'
                  : 'border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
              title={`Brocha ${s} px`}
              aria-label={`Brocha ${s} px`}
            >
              {s}px
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
            title="Restablecer vista al 50% (0)"
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
          onClick={onUndo}
          disabled={!canUndo}
          className="flex items-center gap-1 rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="Deshacer última acción (Ctrl+Z)"
        >
          <span aria-hidden>↶</span>
          <span>Deshacer</span>
        </button>

        <button
          onClick={onClearMine}
          disabled={!canClear}
          className="rounded-lg border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
          title="Borrar mis píxeles"
        >
          Borrar míos
        </button>
      </div>
    </div>
  )
}
