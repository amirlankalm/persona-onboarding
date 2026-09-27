/**
 * High-craft browser Web Audio synthesizer for phone call audio cues & Apple iMessage sounds.
 * Completely client-side, zero external assets, instant response, and clean non-blocking audio nodes.
 */

let sharedContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  type AudioContextConstructor = typeof AudioContext
  const AudioCtx: AudioContextConstructor | undefined =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  if (!AudioCtx) return null

  try {
    if (!sharedContext || sharedContext.state === 'closed') {
      sharedContext = new AudioCtx()
    }
    if (sharedContext.state === 'suspended') {
      void sharedContext.resume()
    }
    return sharedContext
  } catch {
    return null
  }
}

/**
 * Plays a calm, elegant incoming phone ring chime (D5 -> F#5 -> A5).
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
  } catch {}
}

/**
 * Authentic Apple iMessage Sent "Swoosh" / Pop sound.
 * Crisp, light, airy rising frequency.
 */
export function playMessageSentSound(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime

    // White noise puff for airy swoosh
    const bufferSize = ctx.sampleRate * 0.06
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1
    }

    const noise = ctx.createBufferSource()
    noise.buffer = buffer

    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(1200, now)
    filter.frequency.exponentialRampToValueAtTime(3200, now + 0.06)

    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(0.0001, now)
    noiseGain.gain.linearRampToValueAtTime(0.025, now + 0.01)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.06)

    noise.connect(filter)
    filter.connect(noiseGain)
    noiseGain.connect(ctx.destination)

    noise.start(now)
    noise.stop(now + 0.07)

    // Crisp high tonal pop
    const osc = ctx.createOscillator()
    const oscGain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(740, now)
    osc.frequency.exponentialRampToValueAtTime(1480, now + 0.08)

    oscGain.gain.setValueAtTime(0.0001, now)
    oscGain.gain.linearRampToValueAtTime(0.035, now + 0.01)
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)

    osc.connect(oscGain)
    oscGain.connect(ctx.destination)

    osc.start(now)
    osc.stop(now + 0.09)
  } catch {}
}

/**
 * Authentic Apple iMessage Incoming Message Chime (Tri-Tone or Note Chime).
 * Pleasant gentle two-tone chime (A5 -> D6).
 */
export function playMessageReceivedSound(): void {
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    const now = ctx.currentTime

    const notes = [
      { freq: 880.0, offset: 0, dur: 0.16 },     // A5
      { freq: 1174.66, offset: 0.1, dur: 0.28 }   // D6
    ]

    notes.forEach(({ freq, offset, dur }) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()

      osc.type = 'sine'
      osc.frequency.setValueAtTime(freq, now + offset)

      gain.gain.setValueAtTime(0.0001, now + offset)
      gain.gain.linearRampToValueAtTime(0.04, now + offset + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + dur)

      osc.connect(gain)
      gain.connect(ctx.destination)

      osc.start(now + offset)
      osc.stop(now + offset + dur + 0.02)
    })
  } catch {}
}
