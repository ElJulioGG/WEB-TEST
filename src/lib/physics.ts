import Matter from 'matter-js'
import { audio } from './audio'

export type EntityType = 'jp' | 'ball' | 'box' | 'triangle' | 'star' | 'bullet' | 'balloon'
export type GravityMode = 'normal' | 'zero' | 'inverted' | 'lunar'
export type FrictionMode = 'normal' | 'slick' | 'sticky'

const CAT_WALL = 0x0001
const CAT_ENTITY = 0x0002
const WALL_THICKNESS = 60

const GRAVITY_VALUES: Record<GravityMode, number> = {
  normal: 1,
  zero: 0,
  inverted: -1,
  lunar: 0.16,
}

const FRICTION_PROFILES: Record<
  FrictionMode,
  { friction: number; frictionAir: number; restitution: number }
> = {
  normal: { friction: 0.08, frictionAir: 0.005, restitution: 0.55 },
  slick: { friction: 0, frictionAir: 0, restitution: 0.9 },
  sticky: { friction: 0.9, frictionAir: 0.08, restitution: 0.05 },
}

export interface PhysicsHandle {
  engine: Matter.Engine
  render: Matter.Render
  runner: Matter.Runner
  mouseConstraint: Matter.MouseConstraint
  spawn: (type: EntityType, x: number, y: number, velocity?: Matter.Vector) => Matter.Body
  bomb: (x: number, y: number, radius?: number, power?: number) => void
  superBomb: () => void
  blackhole: (x: number, y: number) => void
  repulsor: (x: number, y: number) => void
  wind: (fx: number, fy: number) => void
  confetti: (count?: number) => void
  clearDynamic: () => void
  setGravity: (mode: GravityMode) => void
  setFriction: (mode: FrictionMode) => void
  setCollisions: (on: boolean) => void
  setWireframe: (on: boolean) => void
  setPaused: (paused: boolean) => void
  setTimeScale: (scale: number) => void
  setPartyMode: (on: boolean) => void
  resize: (w: number, h: number) => void
  getBodyCount: () => number
  onBomb: (cb: () => void) => void
  destroy: () => void
}

export function createPhysics(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): PhysicsHandle {
  const engine = Matter.Engine.create()
  const world = engine.world

  const render = Matter.Render.create({
    canvas,
    engine,
    options: {
      width,
      height,
      wireframes: false,
      background: '#0f172a',
      pixelRatio: window.devicePixelRatio || 1,
    },
  })

  const wallStyle = { fillStyle: '#1e293b' }
  let walls: Matter.Body[] = buildWalls(width, height, wallStyle)
  Matter.World.add(world, walls)

  const mouse = Matter.Mouse.create(canvas)
  const mouseConstraint = Matter.MouseConstraint.create(engine, {
    mouse,
    constraint: { stiffness: 0.2, render: { visible: false } },
  })
  Matter.World.add(world, mouseConstraint)
  render.mouse = mouse

  const runner = Matter.Runner.create()
  Matter.Runner.run(runner, engine)
  Matter.Render.run(render)

  let collisionsOn = true
  let friction: FrictionMode = 'normal'
  let partyMode = false
  const bombCallbacks: (() => void)[] = []

  // Wall / corner hit sound — triggers for any entity-vs-static collision.
  Matter.Events.on(engine, 'collisionStart', (event) => {
    for (const pair of event.pairs) {
      const { bodyA, bodyB } = pair
      const wall = bodyA.isStatic ? bodyA : bodyB.isStatic ? bodyB : null
      if (!wall) continue
      const other = wall === bodyA ? bodyB : bodyA
      if (other.isStatic) continue
      const speed = Math.hypot(other.velocity.x, other.velocity.y)
      if (speed > 1.2) audio.bounce(speed)
    }
  })

  // Custom per-body gravity (for balloons) — Matter.js applies global gravity
  // uniformly, so we add a per-body correction force each tick.
  Matter.Events.on(engine, 'beforeUpdate', () => {
    const g = engine.gravity
    const bodies = Matter.Composite.allBodies(world)
    for (const b of bodies) {
      const scale = (b as unknown as { gravityScale?: number }).gravityScale
      if (b.isStatic || scale === undefined || scale === 1) continue
      const delta = (scale - 1) * g.y * g.scale * b.mass
      Matter.Body.applyForce(b, b.position, { x: 0, y: delta })
    }
  })

  // Party mode: shimmering background hue.
  Matter.Events.on(render, 'beforeRender', () => {
    if (partyMode) {
      const hue = (performance.now() / 18) % 360
      render.options.background = `hsl(${hue}, 40%, 12%)`
    }
  })

  function entityFilter(): Matter.ICollisionFilter {
    return {
      category: CAT_ENTITY,
      mask: CAT_WALL | (collisionsOn ? CAT_ENTITY : 0),
      group: 0,
    }
  }

  function applyFrictionTo(b: Matter.Body) {
    const p = FRICTION_PROFILES[friction]
    Matter.Body.set(b, 'friction', p.friction)
    Matter.Body.set(b, 'frictionAir', p.frictionAir)
    Matter.Body.set(b, 'restitution', p.restitution)
  }

  function spawn(type: EntityType, x: number, y: number, velocity?: Matter.Vector): Matter.Body {
    const p = FRICTION_PROFILES[friction]
    const base: Matter.IBodyDefinition = {
      friction: p.friction,
      frictionAir: p.frictionAir,
      restitution: p.restitution,
      density: 0.001,
      collisionFilter: entityFilter(),
      render: { opacity: collisionsOn ? 1 : 0.55 },
    }
    let body: Matter.Body
    switch (type) {
      case 'jp': {
        const r = 28
        body = Matter.Bodies.circle(x, y, r, {
          ...base,
          render: {
            ...base.render,
            sprite: {
              texture: '/jp.png',
              xScale: (r * 2) / 256,
              yScale: (r * 2) / 256,
            },
          },
        })
        break
      }
      case 'ball':
        body = Matter.Bodies.circle(x, y, 16 + Math.random() * 14, {
          ...base,
          restitution: Math.max(p.restitution, 0.8),
          render: { ...base.render, fillStyle: randomHue() },
        })
        break
      case 'box':
        body = Matter.Bodies.rectangle(x, y, 36, 36, {
          ...base,
          render: { ...base.render, fillStyle: randomHue(60, 55) },
        })
        break
      case 'triangle':
        body = Matter.Bodies.polygon(x, y, 3, 26, {
          ...base,
          render: { ...base.render, fillStyle: randomHue() },
        })
        break
      case 'star': {
        const verts = starVertices(5, 30, 14)
        body = Matter.Bodies.fromVertices(x, y, [verts], {
          ...base,
          render: { ...base.render, fillStyle: randomHue(80, 65) },
        })
        break
      }
      case 'bullet':
        body = Matter.Bodies.circle(x, y, 6, {
          ...base,
          density: 0.015,
          restitution: 0.3,
          render: { ...base.render, fillStyle: '#fbbf24' },
        })
        if (!velocity) {
          const a = Math.random() * Math.PI * 2
          velocity = { x: Math.cos(a) * 18, y: Math.sin(a) * 18 }
        }
        break
      case 'balloon':
        body = Matter.Bodies.circle(x, y, 24, {
          ...base,
          density: 0.0002,
          frictionAir: 0.03,
          restitution: 0.7,
          render: { ...base.render, fillStyle: `hsl(${Math.random() * 360}, 85%, 72%)` },
        })
        ;(body as unknown as { gravityScale: number }).gravityScale = -0.6
        break
    }
    if (velocity) {
      Matter.Body.setVelocity(body, velocity)
    } else {
      Matter.Body.setVelocity(body, { x: (Math.random() - 0.5) * 2, y: 0 })
    }
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.1)
    Matter.World.add(world, body)
    audio.spawn()
    return body
  }

  function bomb(x: number, y: number, radius = 220, power = 0.08) {
    Matter.Composite.allBodies(world).forEach((b) => {
      if (b.isStatic) return
      const dx = b.position.x - x
      const dy = b.position.y - y
      const d = Math.hypot(dx, dy)
      if (d >= radius || d === 0) return
      const f = (1 - d / radius) * power
      Matter.Body.applyForce(b, b.position, {
        x: (dx / d) * f * b.mass,
        y: (dy / d) * f * b.mass,
      })
    })
    audio.bomb()
    bombCallbacks.forEach((cb) => cb())
  }

  function superBomb() {
    const w = render.options.width ?? width
    const h = render.options.height ?? height
    bomb(w / 2, h / 2, Math.max(w, h), 0.18)
  }

  function blackhole(x: number, y: number) {
    const radius = 450
    const strength = 0.0018
    Matter.Composite.allBodies(world).forEach((b) => {
      if (b.isStatic) return
      const dx = x - b.position.x
      const dy = y - b.position.y
      const d = Math.hypot(dx, dy)
      if (d >= radius || d < 4) return
      const f = strength * (1 - d / radius)
      Matter.Body.applyForce(b, b.position, {
        x: (dx / d) * f * b.mass,
        y: (dy / d) * f * b.mass,
      })
    })
  }

  function repulsor(x: number, y: number) {
    const radius = 320
    const strength = 0.003
    Matter.Composite.allBodies(world).forEach((b) => {
      if (b.isStatic) return
      const dx = b.position.x - x
      const dy = b.position.y - y
      const d = Math.hypot(dx, dy)
      if (d >= radius || d < 4) return
      const f = strength * (1 - d / radius)
      Matter.Body.applyForce(b, b.position, {
        x: (dx / d) * f * b.mass,
        y: (dy / d) * f * b.mass,
      })
    })
  }

  function wind(fx: number, fy: number) {
    Matter.Composite.allBodies(world).forEach((b) => {
      if (b.isStatic) return
      Matter.Body.applyForce(b, b.position, { x: fx * b.mass, y: fy * b.mass })
    })
  }

  function confetti(count = 32) {
    const types: EntityType[] = ['ball', 'box', 'triangle', 'star']
    const w = render.options.width ?? width
    const h = render.options.height ?? height
    for (let i = 0; i < count; i++) {
      const t = types[Math.floor(Math.random() * types.length)]
      spawn(t, Math.random() * w, Math.random() * h * 0.25, {
        x: (Math.random() - 0.5) * 10,
        y: Math.random() * -4,
      })
    }
    audio.confetti()
  }

  function clearDynamic() {
    const removes = Matter.Composite.allBodies(world).filter((b) => !b.isStatic)
    removes.forEach((b) => Matter.Composite.remove(world, b))
  }

  function setGravity(mode: GravityMode) {
    engine.gravity.y = GRAVITY_VALUES[mode]
  }

  function setFriction(mode: FrictionMode) {
    friction = mode
    Matter.Composite.allBodies(world).forEach((b) => {
      if (!b.isStatic) applyFrictionTo(b)
    })
  }

  function setCollisions(on: boolean) {
    collisionsOn = on
    const mask = CAT_WALL | (on ? CAT_ENTITY : 0)
    Matter.Composite.allBodies(world).forEach((b) => {
      if (b.isStatic) return
      b.collisionFilter.mask = mask
      if (b.render) b.render.opacity = on ? 1 : 0.55
    })
  }

  function setWireframe(on: boolean) {
    render.options.wireframes = on
  }

  function setPaused(paused: boolean) {
    if (paused) Matter.Runner.stop(runner)
    else Matter.Runner.run(runner, engine)
  }

  function setTimeScale(scale: number) {
    engine.timing.timeScale = scale
  }

  function setPartyMode(on: boolean) {
    partyMode = on
    if (!on) render.options.background = '#0f172a'
  }

  function resize(w: number, h: number) {
    render.canvas.width = w
    render.canvas.height = h
    render.options.width = w
    render.options.height = h
    Matter.Render.setPixelRatio(render, window.devicePixelRatio || 1)
    walls.forEach((wall) => Matter.Composite.remove(world, wall))
    walls = buildWalls(w, h, wallStyle)
    Matter.World.add(world, walls)
  }

  function getBodyCount() {
    return Matter.Composite.allBodies(world).filter((b) => !b.isStatic).length
  }

  function onBomb(cb: () => void) {
    bombCallbacks.push(cb)
  }

  function destroy() {
    Matter.Render.stop(render)
    Matter.Runner.stop(runner)
    Matter.World.clear(world, false)
    Matter.Engine.clear(engine)
  }

  return {
    engine,
    render,
    runner,
    mouseConstraint,
    spawn,
    bomb,
    superBomb,
    blackhole,
    repulsor,
    wind,
    confetti,
    clearDynamic,
    setGravity,
    setFriction,
    setCollisions,
    setWireframe,
    setPaused,
    setTimeScale,
    setPartyMode,
    resize,
    getBodyCount,
    onBomb,
    destroy,
  }
}

function buildWalls(w: number, h: number, style: Matter.IBodyRenderOptions): Matter.Body[] {
  const t = WALL_THICKNESS
  const opts = {
    isStatic: true,
    render: style,
    collisionFilter: { category: CAT_WALL, mask: 0xffffffff, group: 0 },
  }
  return [
    Matter.Bodies.rectangle(w / 2, -t / 2, w, t, opts),
    Matter.Bodies.rectangle(w / 2, h + t / 2, w, t, opts),
    Matter.Bodies.rectangle(-t / 2, h / 2, t, h, opts),
    Matter.Bodies.rectangle(w + t / 2, h / 2, t, h, opts),
  ]
}

function starVertices(points: number, outer: number, inner: number): Matter.Vector[] {
  const verts: Matter.Vector[] = []
  const step = Math.PI / points
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = i * step - Math.PI / 2
    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
  }
  return verts
}

function randomHue(sat = 70, light = 60): string {
  return `hsl(${Math.floor(Math.random() * 360)}, ${sat}%, ${light}%)`
}
