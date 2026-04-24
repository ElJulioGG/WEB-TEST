// Synthesized audio — no external assets. Sounds are generated on-the-fly
// with the Web Audio API so deploys stay light and no licensing worries.

class AudioEngine {
  private ctx: AudioContext | null = null
  enabled = true
  private lastBounce = 0

  private get context(): AudioContext | null {
    if (!this.enabled) return null
    if (!this.ctx) {
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext
        if (Ctx) this.ctx = new Ctx()
      } catch {
        return null
      }
    }
    if (this.ctx?.state === 'suspended') this.ctx.resume()
    return this.ctx
  }

  setEnabled(on: boolean) {
    this.enabled = on
    if (!on && this.ctx?.state === 'running') this.ctx.suspend()
    if (on && this.ctx?.state === 'suspended') this.ctx.resume()
  }

  /** Wall / corner bounce — pitch scales with impact velocity. */
  bounce(intensity: number) {
    const ctx = this.context
    if (!ctx) return
    // rate-limit: skip if we just played one (prevents flurry on pile-up)
    const now = performance.now()
    if (now - this.lastBounce < 20) return
    this.lastBounce = now

    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const freq = 160 + Math.min(intensity, 25) * 40
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(Math.max(freq * 0.6, 80), t + 0.08)
    osc.type = 'triangle'
    const vol = 0.05 + Math.min(intensity, 15) / 250
    gain.gain.setValueAtTime(vol, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.13)
  }

  spawn() {
    const ctx = this.context
    if (!ctx) return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(900, t)
    osc.frequency.exponentialRampToValueAtTime(1500, t + 0.04)
    gain.gain.setValueAtTime(0.03, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.09)
  }

  bomb() {
    const ctx = this.context
    if (!ctx) return
    const t = ctx.currentTime
    const duration = 0.5
    const bufSize = Math.floor(ctx.sampleRate * duration)
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < bufSize; i++) {
      const decay = Math.pow(1 - i / bufSize, 2.2)
      data[i] = (Math.random() * 2 - 1) * decay
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buf
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.35, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(1200, t)
    filter.frequency.exponentialRampToValueAtTime(80, t + duration)
    noise.connect(filter).connect(gain).connect(ctx.destination)
    noise.start(t)
  }

  confetti() {
    const ctx = this.context
    if (!ctx) return
    const notes = [523.25, 659.25, 783.99, 1046.5]
    const t0 = ctx.currentTime
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = f
      const t = t0 + i * 0.06
      gain.gain.setValueAtTime(0.04, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.13)
    })
  }

  toggle(): boolean {
    const click = this.context
    this.setEnabled(!this.enabled)
    // short click so the user confirms the toggle audibly when turning ON
    if (this.enabled && click) {
      const t = click.currentTime
      const osc = click.createOscillator()
      const gain = click.createGain()
      osc.frequency.value = 660
      gain.gain.setValueAtTime(0.05, t)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
      osc.connect(gain).connect(click.destination)
      osc.start(t)
      osc.stop(t + 0.09)
    }
    return this.enabled
  }
}

export const audio = new AudioEngine()
