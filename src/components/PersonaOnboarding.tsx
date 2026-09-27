'use client'

import type { VoiceConversation } from '@spekoai/client'
import {
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  createInitialState,
  getNextQuestion,
  getSlotSummary,
  isGmailAddress,
  isRefusal,
  ONBOARDING_STORAGE_KEY,
  onboardingReducer,
  parseCandidates,
  readStoredState,
  taskFirstStep,
  type OnboardingState,
  type TranscriptItem
} from '@/lib/onboarding'
import {
  playConnectTone,
  playEndCallTone,
  playIncomingRingTone,
  playMessageReceivedSound,
  playMessageSentSound,
  unlockAudioPlayback
} from '@/lib/audio'

type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'listening' | 'speaking' | 'ended'

function makeMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function append(
  dispatch: Dispatch<Parameters<typeof onboardingReducer>[1]>,
  item: Omit<TranscriptItem, 'id' | 'createdAt'> & Partial<Pick<TranscriptItem, 'id' | 'createdAt'>>
) {
  dispatch({
    type: 'append-transcript',
    item: {
      id: item.id ?? makeMessageId(item.source),
      source: item.source,
      text: item.text,
      final: item.final,
      createdAt: item.createdAt ?? Date.now()
    }
  })
}

function formatCallDuration(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0')
  const s = (seconds % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

export function PersonaOnboarding() {
  const [state, dispatch] = useReducer(onboardingReducer, undefined, createInitialState)
  const [hydrated, setHydrated] = useState(false)
  const [agentNameInput, setAgentNameInput] = useState('')
  const [textInput, setTextInput] = useState('')
  const [isGmailOpen, setIsGmailOpen] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [notice, setNotice] = useState('')
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [callSeconds, setCallSeconds] = useState(0)
  const [liveSpeaker, setLiveSpeaker] = useState<'agent' | 'user' | null>(null)
  const [liveSpeechText, setLiveSpeechText] = useState('')
  const conversationRef = useRef<VoiceConversation | null>(null)
  const stateRef = useRef(state)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  // Incoming call ringtone cue
  useEffect(() => {
    if (state.phase === 'ringing') {
      const stopRing = playIncomingRingTone()
      return () => {
        stopRing()
      }
    }
  }, [state.phase])

  // Initial agent greeting when entering text mode with an empty conversation
  useEffect(() => {
    if (hydrated && state.channel === 'text' && state.transcript.length === 0 && state.agentName) {
      append(dispatch, {
        source: 'agent',
        text: `Hey! I'm ${state.agentName}. What should I call you?`,
        final: true
      })
      playMessageReceivedSound()
    }
  }, [hydrated, state.channel, state.transcript.length, state.agentName])

  // Smooth auto-scroll for iMessage transcript
  useEffect(() => {
    if (state.channel === 'text') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [state.transcript, state.channel, isSending, state.phase])

  useEffect(() => {
    const restored = readStoredState(window.localStorage.getItem(ONBOARDING_STORAGE_KEY))
    if (restored) dispatch({ type: 'hydrate', state: restored })
    const frame = window.requestAnimationFrame(() => setHydrated(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    if (hydrated) {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state))
    }
  }, [hydrated, state])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => () => {
    void conversationRef.current?.endSession()
  }, [])

  // Absolute voice isolation: when channel is text, synchronize external WebRTC session and DOM audio
  useEffect(() => {
    if (state.channel === 'text') {
      if (conversationRef.current) {
        const active = conversationRef.current
        conversationRef.current = null
        void active.endSession().catch(() => {})
      }
      if (typeof document !== 'undefined') {
        document.querySelectorAll('audio').forEach((el) => {
          try {
            el.pause()
            el.srcObject = null
          } catch {}
        })
      }
    }
  }, [state.channel])

  useEffect(() => {
    const isLive = state.channel === 'voice' && voiceStatus !== 'ended' && voiceStatus !== 'idle'
    if (!isLive) return

    const timer = setInterval(() => {
      setCallSeconds((prev) => prev + 1)
    }, 1000)

    return () => {
      clearInterval(timer)
    }
  }, [state.channel, voiceStatus])

  // Automatically unblock voice audio on ANY user tap, click, or keypress
  useEffect(() => {
    if (!audioBlocked) return
    const unblockOnInteraction = () => {
      void restoreAudio()
    }
    window.addEventListener('click', unblockOnInteraction)
    window.addEventListener('touchstart', unblockOnInteraction)
    window.addEventListener('keydown', unblockOnInteraction)
    return () => {
      window.removeEventListener('click', unblockOnInteraction)
      window.removeEventListener('touchstart', unblockOnInteraction)
      window.removeEventListener('keydown', unblockOnInteraction)
    }
  }, [audioBlocked])

  const progress = useMemo(() => getSlotSummary(state), [state])
  const missing = useMemo(() => progress.filter((slot) => !slot.complete && !slot.skipped).map((slot) => {
    if (slot.label === 'your name') return 'userName'
    if (slot.label === 'Gmail') return 'gmail'
    return 'task'
  }), [progress])

  // Show Gmail connector card only when Gmail connection is actually relevant / requested, NOT at the beginning
  const isGmailNeeded = useMemo(() => {
    if (state.phase === 'graduated') return false
    if (state.gmail.status !== 'empty' && state.gmail.status !== 'candidate') return false
    const nameHandled = state.userName.status === 'confirmed' || state.userName.status === 'skipped'
    const candidateDetected = state.gmail.status === 'candidate'
    const emailMentioned = state.transcript.some((t) => /\b(?:gmail|email|google|inbox)\b/i.test(t.text))
    return nameHandled || candidateDetected || emailMentioned
  }, [state.phase, state.gmail.status, state.userName.status, state.transcript])

  function nameAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = agentNameInput.trim()
    if (!trimmed) return
    dispatch({ type: 'name-agent', value: trimmed })
  }

  function switchToText() {
    setVoiceStatus('idle')
    setLiveSpeaker(null)
    setLiveSpeechText('')
    dispatch({ type: 'choose-channel', channel: 'text' })
  }

  function continueByText() {
    const trimmed = agentNameInput.trim()
    if (!trimmed) {
      setNotice('Give your persona a name first, then you can continue by text.')
      return
    }
    dispatch({ type: 'name-agent', value: trimmed })
    switchToText()
  }

  async function startVoice() {
    if (conversationRef.current || voiceStatus === 'connecting' || state.agentName.length === 0) return
    // Synchronously activate document media privileges within the click gesture
    unlockAudioPlayback()
    playConnectTone()
    setCallSeconds(0)
    setNotice('')
    setVoiceStatus('connecting')
    dispatch({ type: 'choose-channel', channel: 'voice' })
    try {
      const sessionResponse = await fetch('/api/voice-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          demoSessionId: state.sessionId,
          agentName: state.agentName,
          userName: state.userName.value || undefined,
          gmailStatus: state.gmail.status,
          task: state.task.value || undefined
        })
      })
      const session = await sessionResponse.json() as { transportToken?: string; transportUrl?: string; error?: string }
      if (!sessionResponse.ok || !session.transportToken || !session.transportUrl) {
        throw new Error(session.error ?? 'Voice room could not start.')
      }

      const { VoiceConversation } = await import('@spekoai/client')
      const conversation = await VoiceConversation.create({
        transportToken: session.transportToken,
        transportUrl: session.transportUrl,
        onConnect: () => {
          setVoiceStatus('connected')
          // Auto-resume audio immediately on connection (safe ref access to avoid TDZ ReferenceError)
          void conversationRef.current?.startAudioPlayback().catch(() => {})
        },
        onDisconnect: () => {
          conversationRef.current = null
          setVoiceStatus('ended')
          setIsMuted(false)
          dispatch({ type: 'choose-channel', channel: 'text' })
        },
        onStatusChange: (status) => {
          setVoiceStatus(status === 'disconnected' ? 'ended' : status)
        },
        onModeChange: (mode) => setVoiceStatus(mode),
        onTranscript: (messages) => {
          if (!messages || messages.length === 0) return
          const last = messages[messages.length - 1]
          if (last) {
            const trimmed = last.text.trim()
            if (trimmed) {
              setLiveSpeaker(last.source)
              setLiveSpeechText(trimmed)
            }
          }
          messages.forEach((message, index) => {
            if (message.isFinal) {
              const trimmed = message.text.trim()
              if (!trimmed) return
              append(dispatch, {
                id: message.segmentId ?? `${message.source}-${message.startedAt ?? index}`,
                source: message.source,
                text: trimmed,
                final: true,
                createdAt: message.startedAt ?? Date.now()
              })
              if (message.source === 'user') {
                applyCandidates(trimmed)
              }
            }
          })
        },
        onAudioPlaybackBlocked: () => setAudioBlocked(true),
        onError: () => setNotice('Voice connection paused. You can try again or continue by text.')
      })

      // If user switched away to text while connection was being established, end immediately
      if (stateRef.current.channel === 'text') {
        void conversation.endSession().catch(() => {})
        return
      }

      conversationRef.current = conversation
      // Proactively trigger startAudioPlayback in case tracks were mounted
      void conversation.startAudioPlayback().catch(() => {})
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Microphone connection did not start.'
      if (conversationRef.current) {
        const conv = conversationRef.current
        conversationRef.current = null
        void conv.endSession().catch(() => {})
      }
      if (typeof document !== 'undefined') {
        document.querySelectorAll('audio').forEach((el) => {
          try {
            el.pause()
            el.srcObject = null
          } catch {}
        })
      }
      setVoiceStatus('idle')
      dispatch({ type: 'choose-channel', channel: 'text' })
      setNotice(`${reason} Continuing by text.`)
    }
  }

  async function endVoice() {
    playEndCallTone()
    setLiveSpeaker(null)
    setLiveSpeechText('')
    const conversation = conversationRef.current
    conversationRef.current = null
    if (conversation) {
      await conversation.endSession().catch(() => {})
    }
    if (typeof document !== 'undefined') {
      document.querySelectorAll('audio').forEach((el) => {
        try {
          el.pause()
          el.srcObject = null
        } catch {}
      })
    }
    setVoiceStatus('ended')
    setIsMuted(false)
    dispatch({ type: 'choose-channel', channel: 'text' })
  }

  async function resetAll() {
    if (conversationRef.current) {
      const conv = conversationRef.current
      conversationRef.current = null
      await conv.endSession().catch(() => {})
    }
    if (typeof document !== 'undefined') {
      document.querySelectorAll('audio').forEach((el) => {
        try {
          el.pause()
          el.srcObject = null
        } catch {}
      })
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY)
    }
    setVoiceStatus('idle')
    setCallSeconds(0)
    setLiveSpeaker(null)
    setLiveSpeechText('')
    setIsMuted(false)
    setNotice('')
    setAgentNameInput('')
    setTextInput('')
    setIsGmailOpen(false)
    dispatch({ type: 'reset' })
  }

  async function toggleMute() {
    const nextMuted = !isMuted
    await conversationRef.current?.setMicMuted(nextMuted)
    setIsMuted(nextMuted)
  }

  async function restoreAudio() {
    setAudioBlocked(false)
    try {
      if (conversationRef.current) {
        await conversationRef.current.startAudioPlayback()
      }
    } catch {}
    if (typeof document !== 'undefined') {
      document.querySelectorAll('audio').forEach((el) => {
        void el.play().catch(() => {})
      })
    }
  }

  function applyCandidates(message: string) {
    if (isRefusal(message)) {
      const current = stateRef.current
      if (current.gmail.status === 'empty' || current.gmail.status === 'candidate') {
        dispatch({ type: 'skip', slot: 'gmail' })
      } else if (current.userName.status === 'empty' || current.userName.status === 'candidate') {
        dispatch({ type: 'skip', slot: 'userName' })
      } else if (current.task.status === 'empty' || current.task.status === 'candidate') {
        dispatch({ type: 'skip', slot: 'task' })
      }
      return
    }

    const candidates = parseCandidates(message)
    const current = stateRef.current
    if (candidates.userName && (current.userName.status === 'empty' || current.userName.status === 'candidate')) {
      dispatch({ type: 'set-user-name', value: candidates.userName, status: 'confirmed' })
    }
    if (candidates.gmail && (current.gmail.status === 'empty' || current.gmail.status === 'candidate')) {
      dispatch({ type: 'set-gmail', address: candidates.gmail, status: 'address_provided' })
    }
    if (candidates.task && (current.task.status === 'empty' || current.task.status === 'candidate')) {
      dispatch({ type: 'set-task', value: candidates.task, status: 'confirmed' })
    }
  }

  async function sendText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = textInput.trim()
    if (!message || isSending) return
    setNotice('')
    setTextInput('')
    setIsSending(true)
    playMessageSentSound()
    append(dispatch, { source: 'user', text: message, final: true })
    applyCandidates(message)

    try {
      if (state.channel === 'voice' && conversationRef.current?.isOpen()) {
        await conversationRef.current.sendChatMessage(message)
      } else {
        const textFetchPromise = fetch('/api/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message,
            agentName: state.agentName,
            missing,
            knownUserName: state.userName.value || undefined,
            knownTask: state.task.value || undefined,
            phase: state.phase
          })
        })

        // Authentic human conversational delay (reading + typing time): 850ms - 1300ms
        const minTypingDuration = new Promise((resolve) =>
          setTimeout(resolve, Math.min(1300, Math.max(850, message.length * 20)))
        )

        const [response] = await Promise.all([textFetchPromise, minTypingDuration])
        const body = (await response.json()) as { reply?: string; error?: string }
        if (!response.ok || !body.reply) {
          throw new Error(body.error ?? 'The text reply did not arrive.')
        }

        const replyText = body.reply

        // Brief finishing pause if long reply for realistic human rhythm
        if (replyText.length > 60) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(400, (replyText.length - 60) * 6))
          )
        }

        playMessageReceivedSound()
        append(dispatch, { source: 'agent', text: replyText, final: true })
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Message could not be sent.')
    } finally {
      setIsSending(false)
    }
  }

  function handleSelectGoogleAccount(email: string) {
    dispatch({ type: 'set-gmail', address: email, status: 'address_provided' })
    setIsGmailOpen(false)
    playMessageReceivedSound()
    append(dispatch, {
      source: 'agent',
      text: `Google account linked: ${email} (Demo mode).`,
      final: true
    })
  }

  if (!hydrated) {
    return <main className="page-shell" aria-busy="true" />
  }

  // SCREEN 1: NAMING
  if (state.phase === 'naming') {
    return (
      <main className="page-shell" id="main-content">
        <div className="card-container naming-stage">
          <h1 id="naming-title">your persona doesn&apos;t<br />have a name yet.</h1>
          <form className="name-input-group" onSubmit={nameAgent}>
            <div className="input-pill-wrapper">
              <label className="sr-only" htmlFor="agent-name">Your persona&apos;s name</label>
              <input
                id="agent-name"
                autoFocus
                autoComplete="off"
                maxLength={48}
                onChange={(event) => setAgentNameInput(event.target.value)}
                placeholder="give it a name"
                value={agentNameInput}
                className="name-input"
              />
              <button className="primary-pill-btn" type="submit" disabled={!agentNameInput.trim()}>
                name it <Arrow />
              </button>
            </div>
            <button className="secondary-text-btn" onClick={continueByText} type="button">
              continue by text <Arrow />
            </button>
          </form>
          {notice && <p className="notice-pill" role="status">{notice}</p>}
        </div>
      </main>
    )
  }

  // SCREEN 2: SIMULATED INCOMING CALL (Full-Screen White Apple iOS Call)
  if (state.phase === 'ringing') {
    return (
      <div className="ios-screen-backdrop">
        <main className="ios-incoming-screen" id="main-content">
          <div className="ios-call-top">
            <p className="ios-call-sub-top">mobile</p>
            <h1 className="ios-call-title" id="caller-title">{state.agentName}</h1>
          </div>

          <div className="ios-call-center-spacer" />

          {notice && <p className="notice-pill ios-notice" role="status">{notice}</p>}

          {/* Apple iOS Incoming Call Actions matching screenshot */}
          <div className="ios-incoming-cluster">
            {/* Row 1: Message (left) & Remind Me (right) */}
            <div className="ios-incoming-row">
              <button
                className="ios-call-round-btn"
                onClick={switchToText}
                type="button"
                aria-label="Message"
              >
                <div className="ios-round-circle util">
                  <MessageCircle />
                </div>
                <span className="ios-round-label">Message</span>
              </button>

              <button
                className="ios-call-round-btn"
                onClick={() => setNotice('Reminder set for after onboarding.')}
                type="button"
                aria-label="Remind Me"
              >
                <div className="ios-round-circle util">
                  <Clock />
                </div>
                <span className="ios-round-label">Remind Me</span>
              </button>
            </div>

            {/* Row 2: Decline (left) & Accept (right) */}
            <div className="ios-incoming-row actions-row">
              <button
                className="ios-call-round-btn"
                onClick={switchToText}
                type="button"
                aria-label="Decline call and continue by text"
              >
                <div className="ios-round-circle decline">
                  <Phone />
                </div>
                <span className="ios-round-label">Decline</span>
              </button>

              <button
                className="ios-call-round-btn"
                onClick={startVoice}
                type="button"
                aria-label={`Accept call from ${state.agentName}`}
              >
                <div className="ios-round-circle accept">
                  <Phone />
                </div>
                <span className="ios-round-label">Accept</span>
              </button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  // SCREEN 3: ACTIVE iOS PHONE CALL
  if (state.channel === 'voice' && voiceStatus !== 'ended') {
    return (
      <div className="ios-screen-backdrop">
        <main className="ios-call-screen" id="main-content">
          <div className="ios-call-top">
            <p className="ios-call-sub-top timer">
              {voiceStatus === 'connecting'
                ? 'connecting…'
                : voiceStatus === 'speaking'
                ? `${state.agentName} speaking…`
                : formatCallDuration(callSeconds)}
            </p>
            <h1 className="ios-call-title">{state.agentName}</h1>
          </div>

          {/* Smooth In-Call Gmail Connector Banner & Live Captions */}
          <div className="ios-call-middle-area">
            {(isGmailNeeded || state.gmail.status === 'address_provided' || state.gmail.status === 'connected') && (
              <div className="ios-call-gmail-wrap">
                {isGmailNeeded ? (
                  <div className="ios-call-gmail-card" onClick={() => setIsGmailOpen(true)} role="button" tabIndex={0}>
                    <div className="ios-call-gmail-left">
                      <div className="ios-call-gmail-badge">
                        <GoogleIcon />
                      </div>
                      <div className="ios-call-gmail-info">
                        <span className="ios-call-gmail-title">Connect Google Account</span>
                        <span className="ios-call-gmail-desc">Link Gmail for this demo</span>
                      </div>
                    </div>
                    <div className="ios-call-gmail-right">
                      <button
                        className="ios-call-gmail-btn"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          setIsGmailOpen(true)
                        }}
                      >
                        Connect
                      </button>
                      <button
                        className="ios-call-gmail-skip"
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          dispatch({ type: 'skip', slot: 'gmail' })
                        }}
                        title="Skip for now"
                        aria-label="Skip Gmail"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ) : state.gmail.status === 'address_provided' || state.gmail.status === 'connected' ? (
                  <div className="ios-call-gmail-card connected" onClick={() => setIsGmailOpen(true)} role="button" tabIndex={0}>
                    <div className="ios-call-gmail-left">
                      <div className="ios-call-gmail-badge success">
                        <CheckIcon />
                      </div>
                      <div className="ios-call-gmail-info">
                        <span className="ios-call-gmail-title">{state.gmail.address}</span>
                        <span className="ios-call-gmail-desc">Google Account Linked</span>
                      </div>
                    </div>
                    <button
                      className="ios-call-gmail-change-btn"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        setIsGmailOpen(true)
                      }}
                    >
                      Change
                    </button>
                  </div>
                ) : null}
              </div>
            )}

            {/* Live Audio Visualizer */}
            <div className="ios-call-wave-wrap" aria-label="Voice activity">
              <div className={`ios-call-waves ${voiceStatus === 'speaking' ? 'speaking' : 'listening'}`}>
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                  <span key={i} className="ios-wave-bar" style={{ '--i': i } as CSSProperties} />
                ))}
              </div>
            </div>

            {/* Live Subtitle Transcript / Apple-Style Live Captions */}
            <div className="ios-call-subtitles" aria-live="polite">
              <div className="ios-captions-header">
                <span className="ios-captions-label">Live Captions</span>
                <span className={`ios-live-dot ${voiceStatus === 'speaking' ? 'speaking' : 'listening'}`} />
              </div>

              {liveSpeechText ? (
                <div className="ios-caption-bubble">
                  <span className={`ios-caption-speaker ${liveSpeaker === 'user' ? 'user' : 'agent'}`}>
                    {liveSpeaker === 'user' ? (state.userName.value || 'You') : state.agentName}:
                  </span>
                  <span className="ios-caption-content">
                    “{liveSpeechText}”
                  </span>
                </div>
              ) : (
                <div className="ios-caption-idle">
                  <span>{voiceStatus === 'connecting' ? 'connecting audio…' : 'listening to you…'}</span>
                </div>
              )}
            </div>

            {notice && <p className="notice-pill ios-notice" role="status">{notice}</p>}
            {audioBlocked && (
              <button className="ios-audio-unblock-banner" onClick={restoreAudio} type="button">
                <div className="ios-unblock-pulsing-icon">
                  <Volume />
                </div>
                <div className="ios-unblock-details">
                  <span className="ios-unblock-primary">Tap anywhere to hear {state.agentName}</span>
                  <span className="ios-unblock-sub">Browser paused call audio</span>
                </div>
              </button>
            )}
          </div>

          {/* Apple 2x3 Keypad Grid matching Screenshot: Speaker, FaceTime, Mute | More, End, Keypad */}
          <div className="ios-active-keypad-grid">
            {/* Row 1: Speaker | FaceTime | Mute */}
            <button
              className="ios-call-round-btn"
              onClick={restoreAudio}
              type="button"
              aria-label="Speaker"
            >
              <div className="ios-round-circle util">
                <Volume />
              </div>
              <span className="ios-round-label">Speaker</span>
            </button>

            <button
              className="ios-call-round-btn disabled"
              type="button"
              aria-label="FaceTime"
              disabled
            >
              <div className="ios-round-circle util disabled">
                <Video />
              </div>
              <span className="ios-round-label">FaceTime</span>
            </button>

            <button
              className="ios-call-round-btn"
              onClick={toggleMute}
              type="button"
              aria-label={isMuted ? 'Unmute' : 'Mute'}
            >
              <div className={`ios-round-circle util ${isMuted ? 'active' : ''}`}>
                {isMuted ? <MicOff /> : <Mic />}
              </div>
              <span className="ios-round-label">Mute</span>
            </button>

            {/* Row 2: More | End | Keypad */}
            <button
              className="ios-call-round-btn"
              onClick={() => void endVoice()}
              type="button"
              aria-label="More options (continue by text)"
            >
              <div className="ios-round-circle util">
                <MoreHorizontal />
              </div>
              <span className="ios-round-label">More</span>
            </button>

            <button
              className="ios-call-round-btn"
              onClick={() => void endVoice()}
              type="button"
              aria-label="End call"
            >
              <div className="ios-round-circle decline">
                <Phone />
              </div>
              <span className="ios-round-label">End</span>
            </button>

            <button
              className="ios-call-round-btn"
              type="button"
              onClick={() => setNotice('Voice active — speak naturally.')}
              aria-label="Keypad"
            >
              <div className="ios-round-circle util">
                <Keypad />
              </div>
              <span className="ios-round-label">Keypad</span>
            </button>
          </div>

          {/* In-Call Google OAuth Modal */}
          {isGmailOpen && (
            <GoogleOAuthModal
              userName={state.userName.value}
              onClose={() => setIsGmailOpen(false)}
              onSelectAccount={(email) => {
                handleSelectGoogleAccount(email)
                setIsGmailOpen(false)
              }}
              onSkip={() => {
                dispatch({ type: 'skip', slot: 'gmail' })
                setIsGmailOpen(false)
              }}
            />
          )}
        </main>
      </div>
    )
  }

  // SCREEN 4: APPLE iMESSAGE CONVERSATION
  return (
    <main className="imessage-shell" id="main-content">
      {/* iOS iMessage Navigation Header */}
      <header className="imessage-nav">
        <button
          className="imessage-back-btn"
          onClick={() => void resetAll()}
          type="button"
          aria-label="Start over"
          title="Start over"
        >
          ‹ Messages
        </button>

        <div className="imessage-contact-card">
          <div className="imessage-avatar">
            {state.agentName.slice(0, 1).toUpperCase()}
          </div>
          <span className="imessage-name">{state.agentName}</span>
          <span className="imessage-sub">Persona ›</span>
        </div>

        <button
          className="imessage-call-action"
          onClick={startVoice}
          disabled={voiceStatus === 'connecting'}
          type="button"
          aria-label={`Call ${state.agentName}`}
          title={`Call ${state.agentName}`}
        >
          <Phone />
        </button>
      </header>

      {/* iMessage Message Stream */}
      <section className="imessage-transcript" aria-live="polite" aria-label="Messages">
        {state.phase === 'graduated' && (
          <GraduationCard
            state={state}
            onAdjust={() => {
              dispatch({ type: 'return-to-collecting' })
              dispatch({ type: 'choose-channel', channel: 'text' })
            }}
          />
        )}

        {state.transcript.length === 0 && state.phase !== 'graduated' ? (
          <div className="imessage-bubble-row received">
            <div className="imessage-bubble bubble-gray">
              {state.userName.value
                ? `hey ${state.userName.value}, i'm ${state.agentName}. ${getNextQuestion(state)}`
                : `hey, i'm ${state.agentName}. who am i speaking with?`}
            </div>
          </div>
        ) : (
          state.transcript.map((item, idx) => {
            const isLast = idx === state.transcript.length - 1
            const isUser = item.source === 'user'
            return (
              <div className={`imessage-bubble-row ${isUser ? 'sent' : 'received'}`} key={item.id}>
                <div className={`imessage-bubble ${isUser ? 'bubble-blue' : 'bubble-gray'}`}>
                  {item.text}
                </div>
                {isUser && isLast && <span className="imessage-delivered">Delivered</span>}
              </div>
            )
          })
        )}

        {/* Inline Google OAuth Action Card - only shown when Gmail connection is needed */}
        {isGmailNeeded && (
          <div className="imessage-oauth-card" role="region" aria-label="Connect Google Account">
            <div className="oauth-card-top">
              <GoogleIcon />
              <div className="oauth-card-info">
                <span className="oauth-card-title">Google Account</span>
                <span className="oauth-card-desc">Sign in with Google to link Gmail for this demo</span>
              </div>
            </div>
            <div className="oauth-card-actions">
              <button
                className="google-signin-btn"
                onClick={() => setIsGmailOpen(true)}
                type="button"
              >
                <GoogleIcon />
                <span>Sign in with Google</span>
              </button>
              <button
                className="oauth-skip-btn"
                onClick={() => dispatch({ type: 'skip', slot: 'gmail' })}
                type="button"
              >
                skip
              </button>
            </div>
          </div>
        )}

        {isSending && (
          <div className="imessage-bubble-row received">
            <div className="imessage-bubble bubble-gray typing-indicator" aria-label={`${state.agentName} is typing`}>
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </section>

      {notice && <p className="notice-pill" role="status">{notice}</p>}

      {/* iOS iMessage Composer */}
      <form className="imessage-composer" onSubmit={sendText}>
        <div className="imessage-plus-btn" aria-hidden="true">+</div>
        <input
          id="text-message"
          autoComplete="off"
          disabled={isSending}
          onChange={(event) => setTextInput(event.target.value)}
          placeholder="iMessage"
          value={textInput}
          className="imessage-input"
        />
        {textInput.trim() ? (
          <button className="imessage-send-btn" disabled={isSending} type="submit" aria-label="Send">
            <ArrowUp />
          </button>
        ) : (
          <button className="imessage-mic-btn" onClick={startVoice} type="button" aria-label="Voice call">
            <Mic />
          </button>
        )}
      </form>

      {isGmailOpen && (
        <GoogleOAuthModal
          userName={state.userName.value}
          onClose={() => setIsGmailOpen(false)}
          onSelectAccount={handleSelectGoogleAccount}
          onSkip={() => {
            dispatch({ type: 'skip', slot: 'gmail' })
            setIsGmailOpen(false)
          }}
        />
      )}
    </main>
  )
}

function GraduationCard({
  state,
  onAdjust
}: {
  state: OnboardingState
  onAdjust: () => void
}) {
  const step = taskFirstStep(state.task.value)

  return (
    <article className="graduation-card" aria-labelledby="graduation-title">
      <div className="grad-header">
        <span className="grad-badge">Proposed First Step</span>
      </div>

      <div className="proposed-plan-box">
        <h3>{step.title}</h3>
        <p>{step.detail}</p>
      </div>

      <div className="slot-recap">
        <div className="recap-item">
          <span>Name</span>
          <strong>{state.userName.value || (state.userName.status === 'skipped' ? 'Skipped' : '—')}</strong>
        </div>
        <div className="recap-item">
          <span>Gmail</span>
          <strong>
            {state.gmail.address
              ? `${state.gmail.address} (Demo address)`
              : state.gmail.status === 'skipped'
              ? 'Skipped'
              : '—'}
          </strong>
        </div>
        <div className="recap-item">
          <span>Task</span>
          <strong>{state.task.value || '—'}</strong>
        </div>
      </div>

      <button className="secondary-text-btn" onClick={onAdjust} style={{ marginTop: '0.65rem' }} type="button">
        edit <Arrow />
      </button>
    </article>
  )
}

function GoogleOAuthModal({
  userName,
  onClose,
  onSelectAccount,
  onSkip
}: {
  userName: string
  onClose: () => void
  onSelectAccount: (email: string) => void
  onSkip: () => void
}) {
  const [isConnecting, setIsConnecting] = useState(false)
  const [showCustomInput, setShowCustomInput] = useState(false)
  const [customEmail, setCustomEmail] = useState('')
  const [error, setError] = useState('')

  const displayName = userName.trim() || 'Amirlan Kalmukhan'
  const defaultEmail = 'amirlankalmukhan1@gmail.com'

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handleChooseDefault() {
    setIsConnecting(true)
    setTimeout(() => {
      onSelectAccount(defaultEmail)
    }, 600)
  }

  function handleCustomSubmit(e: FormEvent) {
    e.preventDefault()
    if (!isGmailAddress(customEmail)) {
      setError('Please enter a valid Gmail address (name@gmail.com)')
      return
    }
    setIsConnecting(true)
    setTimeout(() => {
      onSelectAccount(customEmail.trim().toLowerCase())
    }, 500)
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="google-auth-title">
      <div className="google-oauth-box">
        <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close modal">
          ×
        </button>

        <div className="google-header">
          <GoogleIcon />
          <h2 id="google-auth-title">Sign in with Google</h2>
          <p className="google-subtitle">Choose an account to continue to <b>Persona</b></p>
        </div>

        {isConnecting ? (
          <div className="google-connecting-state">
            <div className="google-spinner" />
            <p>Connecting Google Account…</p>
          </div>
        ) : !showCustomInput ? (
          <div className="google-accounts-list">
            <button className="google-account-row" onClick={handleChooseDefault} type="button">
              <div className="google-avatar-circle">
                {displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="google-account-details">
                <span className="google-account-name">{displayName}</span>
                <span className="google-account-email">{defaultEmail}</span>
              </div>
            </button>

            <button
              className="google-account-row add-account"
              onClick={() => setShowCustomInput(true)}
              type="button"
            >
              <div className="google-avatar-circle add">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </div>
              <div className="google-account-details">
                <span className="google-account-name">Use another account</span>
                <span className="google-account-email">Enter a different Gmail address</span>
              </div>
            </button>

            <div className="google-footer-notice">
              <p>Demo placeholder: saves address to Persona demo state without requesting Google OAuth scopes.</p>
              <button className="secondary-text-btn" onClick={onSkip} style={{ margin: '0.65rem auto 0' }} type="button">
                skip for now
              </button>
            </div>
          </div>
        ) : (
          <form className="google-custom-form" onSubmit={handleCustomSubmit}>
            <label className="google-input-label" htmlFor="custom-gmail-input">
              Enter your Gmail address
            </label>
            <input
              id="custom-gmail-input"
              type="email"
              inputMode="email"
              autoFocus
              autoComplete="email"
              placeholder="name@gmail.com"
              value={customEmail}
              onChange={(e) => {
                setCustomEmail(e.target.value)
                setError('')
              }}
              className="modal-input"
            />
            {error && <p className="google-error-text">{error}</p>}
            <div className="google-form-actions">
              <button
                className="secondary-text-btn"
                onClick={() => setShowCustomInput(false)}
                type="button"
              >
                ‹ Back
              </button>
              <button
                className="primary-pill-btn"
                type="submit"
                disabled={!customEmail.trim()}
              >
                continue <Arrow />
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function Arrow() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10h12M11 5l5 5-5 5" />
    </svg>
  )
}

function ArrowUp() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 15V5M5 10l5-5 5 5" />
    </svg>
  )
}

function Phone() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function Mic() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function MicOff() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}


function Volume() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

function GoogleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.8-2.4 3.67v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.16z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.24v3.15C3.26 21.36 7.33 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.24C.45 8.16 0 9.97 0 12s.45 3.84 1.24 5.42l4.04-3.15z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.33 0 3.26 2.64 1.24 6.58l4.04 3.15c.95-2.83 3.6-4.98 6.72-4.98z"
      />
    </svg>
  )
}


function MessageCircle() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

function Keypad() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="5" r="2" />
      <circle cx="12" cy="5" r="2" />
      <circle cx="19" cy="5" r="2" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="12" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
    </svg>
  )
}

function Video() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  )
}


function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function Clock() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function MoreHorizontal() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
    </svg>
  )
}
