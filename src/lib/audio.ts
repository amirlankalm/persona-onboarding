/**
 * High-craft browser Web Audio synthesizer for phone call audio cues.
 * Completely client-side, zero external assets, instant response, and clean teardown.
 */

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  type AudioContextConstructor = typeof AudioContext
  const AudioCtx: AudioContextConstructor | undefined =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  if (!AudioCtx) return null
  try {
    return new AudioCtx()
  } catch {
    return null
  }
}

/**
 * Plays a calm, elegant incoming phone ring chime (D5 -> F#5 -> A5)
 * Repeats every 2.8s until the returned cleanup callback is invoked.
 */
export function playIncomingRingTone(): () => void {
  const ctx = getAudioContext()
  if (!ctx) return () => {}

  let active = true

  const playChime = () => {
    if (!active || ctx.state === 'closed') return

    try {
      if (ctx.state === 'suspended') {
        void ctx.resume()
      }

      const now = ctx.currentTime
      const notes = [
        { freq: 587.33, offset: 0, dur: 0.28 },     // D5
        { freq: 739.99, offset: 0.12, dur: 0.32 },  // F#5
        { freq: 880.0, offset: 0.25, dur: 0.55 }    // A5
      ]

      notes.forEach(({ freq, offset, dur }) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()

        osc.type = 'sine'
        osc.frequency.setValueAtTime(freq, now + offset)

        // Soft, gentle non-piercing volume
        gain.gain.setValueAtTime(0.0001, now + offset)
        gain.gain.linearRampToValueAtTime(0.05, now + offset + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + dur)

        osc.connect(gain)
        gain.connect(ctx.destination)

        osc.start(now + offset)
        osc.stop(now + offset + dur + 0.05)
      })
    } catch {
      // Audio autoplay policy or hardware muted
    }
  }

  playChime()
  const interval = setInterval(() => {
    if (active) playChime()
  }, 2800)

  return () => {
    active = false
    clearInterval(interval)
    void ctx.close().catch(() => {})
  }
}

/**
 * Tactile audio cue when answering an incoming call (A5 -> D6).
 */
export function playConnectTone(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(880, now)
    osc.frequency.exponentialRampToValueAtTime(1174.66, now + 0.09) // A5 -> D6

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(0.045, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.18)

    setTimeout(() => {
      void ctx.close().catch(() => {})
    }, 250)
  } catch {}
}

/**
 * Soft tone when ending a call (D5 -> A4).
 */
export function playEndCallTone(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()

    osc.type = 'sine'
    osc.frequency.setValueAtTime(587.33, now)
    osc.frequency.exponentialRampToValueAtTime(440.0, now + 0.12) // D5 -> A4

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(0.04, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2)

    osc.connect(gain)
    gain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.22)

    setTimeout(() => {
      void ctx.close().catch(() => {})
    }, 280)
  } catch {}
}
