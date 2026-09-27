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
  const [gmailInput, setGmailInput] = useState('')
  const [isGmailOpen, setIsGmailOpen] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [notice, setNotice] = useState('')
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [callSeconds, setCallSeconds] = useState(0)
  const conversationRef = useRef<VoiceConversation | null>(null)
  const stateRef = useRef(state)

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

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null
    const isLive = state.channel === 'voice' && voiceStatus !== 'ended' && voiceStatus !== 'idle'
    if (isLive) {
      timer = setInterval(() => {
        setCallSeconds((prev) => prev + 1)
      }, 1000)
    } else {
      setCallSeconds(0)
    }
    return () => {
      if (timer) clearInterval(timer)
    }
  }, [state.channel, voiceStatus])

  const progress = useMemo(() => getSlotSummary(state), [state])
  const missing = useMemo(() => progress.filter((slot) => !slot.complete && !slot.skipped).map((slot) => {
    if (slot.label === 'your name') return 'userName'
    if (slot.label === 'Gmail') return 'gmail'
    return 'task'
  }), [progress])

  function nameAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = agentNameInput.trim()
    if (!trimmed) return
    dispatch({ type: 'name-agent', value: trimmed })
  }

  function continueByText() {
    const trimmed = agentNameInput.trim()
    if (!trimmed) {
      setNotice('Give your persona a name first, then you can continue by text.')
      return
    }
    dispatch({ type: 'name-agent', value: trimmed })
    dispatch({ type: 'choose-channel', channel: 'text' })
  }

  async function startVoice() {
    if (conversationRef.current || voiceStatus === 'connecting' || state.agentName.length === 0) return
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
          // Speko agent will speak firstMessage directly over audio and stream it to onTranscript
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
          messages.forEach((message, index) => {
            const trimmed = message.text.trim()
            if (!trimmed) return
            append(dispatch, {
              id: message.segmentId ?? `${message.source}-${message.startedAt ?? index}-${trimmed}`,
              source: message.source,
              text: trimmed,
              final: message.isFinal,
              createdAt: message.startedAt ?? Date.now()
            })
            if (message.source === 'user' && message.isFinal) {
              applyCandidates(trimmed)
            }
          })
        },
        onAudioPlaybackBlocked: () => setAudioBlocked(true),
        onError: () => setNotice('Voice connection paused. You can try again or continue by text.')
      })
      conversationRef.current = conversation
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Microphone connection did not start.'
      setVoiceStatus('idle')
      dispatch({ type: 'choose-channel', channel: 'text' })
      setNotice(`${reason} Continuing by text.`)
    }
  }

  async function endVoice() {
    const conversation = conversationRef.current
    if (conversation) await conversation.endSession()
    conversationRef.current = null
    setVoiceStatus('ended')
    setIsMuted(false)
    dispatch({ type: 'choose-channel', channel: 'text' })
  }

  async function resetAll() {
    if (conversationRef.current) {
      await conversationRef.current.endSession()
      conversationRef.current = null
    }
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ONBOARDING_STORAGE_KEY)
    }
    setVoiceStatus('idle')
    setIsMuted(false)
    setNotice('')
    setAgentNameInput('')
    setTextInput('')
    setGmailInput('')
    setIsGmailOpen(false)
    dispatch({ type: 'reset' })
  }

  async function toggleMute() {
    const nextMuted = !isMuted
    await conversationRef.current?.setMicMuted(nextMuted)
    setIsMuted(nextMuted)
  }

  async function restoreAudio() {
    await conversationRef.current?.startAudioPlayback()
    setAudioBlocked(false)
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
    append(dispatch, { source: 'user', text: message, final: true })
    applyCandidates(message)

    try {
      if (conversationRef.current?.isOpen()) {
        await conversationRef.current.sendChatMessage(message)
      } else {
        const response = await fetch('/api/text', {
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
        const body = await response.json() as { reply?: string; error?: string }
        if (!response.ok || !body.reply) {
          throw new Error(body.error ?? 'The text reply did not arrive.')
        }
        append(dispatch, { source: 'agent', text: body.reply, final: true })
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Message could not be sent.')
    } finally {
      setIsSending(false)
    }
  }

  function saveGmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!isGmailAddress(gmailInput)) {
      setNotice('Please provide a valid Gmail address (name@gmail.com).')
      return
    }
    dispatch({ type: 'set-gmail', address: gmailInput, status: 'address_provided' })
    setGmailInput('')
    setIsGmailOpen(false)
    append(dispatch, {
      source: 'agent',
      text: 'Got it. Address saved for this demo—not connected to your inbox.',
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

  // SCREEN 2: SIMULATED INCOMING CALL
  if (state.phase === 'ringing') {
    return (
      <main className="page-shell" id="main-content">
        <div className="card-container incoming-stage">
          <div className="caller-avatar" aria-hidden="true">
            {state.agentName.slice(0, 1).toUpperCase()}
          </div>
          <h1 id="caller-title">{state.agentName}</h1>
          <p className="calling-sub">Persona Audio…</p>
          <div className="call-actions-row">
            <button
              className="circle-call-action decline"
              onClick={() => {
                dispatch({ type: 'choose-channel', channel: 'text' })
              }}
              type="button"
            >
              <span aria-hidden="true">×</span>
              <b>Decline</b>
            </button>
            <button className="circle-call-action accept" onClick={startVoice} type="button">
              <span aria-hidden="true"><Phone /></span>
              <b>Accept</b>
            </button>
          </div>
          <button
            className="secondary-text-btn"
            onClick={() => dispatch({ type: 'choose-channel', channel: 'text' })}
            type="button"
          >
            continue by text <Arrow />
          </button>
          {notice && <p className="notice-pill" role="status">{notice}</p>}
        </div>
      </main>
    )
  }

  // SCREEN 3: ACTIVE iOS PHONE CALL
  if (state.channel === 'voice' && voiceStatus !== 'ended') {
    const latestAgentSpeech = [...state.transcript].reverse().find((t) => t.source === 'agent')?.text
    const latestUserSpeech = [...state.transcript].reverse().find((t) => t.source === 'user')?.text

    return (
      <main className="ios-call-screen" id="main-content">
        <div className="ios-call-top">
          <div className="ios-call-avatar">
            {state.agentName.slice(0, 1).toUpperCase()}
          </div>
          <h1 className="ios-call-title">{state.agentName}</h1>
          <p className="ios-call-timer">
            {voiceStatus === 'connecting'
              ? 'connecting…'
              : voiceStatus === 'speaking'
              ? `${state.agentName} speaking…`
              : formatCallDuration(callSeconds)}
          </p>
        </div>

        {/* Live Audio Visualizer */}
        <div className="ios-call-wave-wrap" aria-label="Voice activity">
          <div className={`ios-call-waves ${voiceStatus === 'speaking' ? 'speaking' : 'listening'}`}>
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <span key={i} className="ios-wave-bar" style={{ '--i': i } as CSSProperties} />
            ))}
          </div>
        </div>

        {/* Live Subtitle Transcript */}
        <div className="ios-call-subtitles" aria-live="polite">
          {latestAgentSpeech && (
            <p className="ios-subtitle-line agent">
              <span>{latestAgentSpeech}</span>
            </p>
          )}
          {latestUserSpeech && voiceStatus !== 'speaking' && (
            <p className="ios-subtitle-line user">
              <span>{latestUserSpeech}</span>
            </p>
          )}
        </div>

        {notice && <p className="notice-pill ios-notice" role="status">{notice}</p>}
        {audioBlocked && (
          <button className="audio-unblock-bar" onClick={restoreAudio} type="button">
            tap to hear audio <Volume />
          </button>
        )}

        {/* Apple 6-Button Keypad Grid */}
        <div className="ios-call-keypad">
          <button
            className={`ios-keypad-btn ${isMuted ? 'active' : ''}`}
            onClick={toggleMute}
            type="button"
            aria-label={isMuted ? 'Unmute' : 'Mute'}
          >
            <div className="ios-keypad-icon">{isMuted ? <MicOff /> : <Mic />}</div>
            <span>{isMuted ? 'unmute' : 'mute'}</span>
          </button>

          <button
            className="ios-keypad-btn"
            onClick={() => void endVoice()}
            type="button"
            aria-label="Messages"
          >
            <div className="ios-keypad-icon"><Text /></div>
            <span>messages</span>
          </button>

          <button
            className={`ios-keypad-btn ${audioBlocked ? 'active' : ''}`}
            onClick={audioBlocked ? restoreAudio : undefined}
            type="button"
            aria-label="Speaker"
          >
            <div className="ios-keypad-icon"><Volume /></div>
            <span>speaker</span>
          </button>
        </div>

        {/* End Call Button */}
        <div className="ios-call-bottom">
          <button
            className="ios-end-call-btn"
            onClick={() => void endVoice()}
            type="button"
            aria-label="End call"
          >
            <Phone />
          </button>
        </div>
      </main>
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

      {/* Progress metadata pill */}
      <ProgressStrip progress={progress} onGmail={() => setIsGmailOpen(true)} />

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
          <div className="imessage-empty-state">
            <p>{getNextQuestion(state)}</p>
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
        <GmailModal
          gmailInput={gmailInput}
          onChange={setGmailInput}
          onClose={() => setIsGmailOpen(false)}
          onSave={saveGmail}
          onSkip={() => {
            dispatch({ type: 'skip', slot: 'gmail' })
            setIsGmailOpen(false)
          }}
        />
      )}
    </main>
  )
}

function ProgressStrip({
  progress,
  onGmail
}: {
  progress: ReturnType<typeof getSlotSummary>
  onGmail: () => void
}) {
  return (
    <nav className="progress-strip" aria-label="Onboarding progress">
      {progress.map((slot) => {
        const isGmail = slot.label === 'Gmail'
        return (
          <button
            key={slot.label}
            className={`chip ${slot.complete ? 'complete' : ''} ${slot.skipped ? 'skipped' : ''} ${isGmail ? 'clickable' : ''}`}
            onClick={isGmail ? onGmail : undefined}
            type="button"
            disabled={!isGmail}
            aria-label={`${slot.label}: ${slot.complete ? 'Completed' : slot.skipped ? 'Skipped' : 'Pending'}`}
          >
            <span>{slot.complete ? '✓' : slot.skipped ? '—' : '○'}</span>
            {slot.label}
          </button>
        )
      })}
    </nav>
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

function GmailModal({
  gmailInput,
  onChange,
  onClose,
  onSave,
  onSkip
}: {
  gmailInput: string
  onChange: (value: string) => void
  onClose: () => void
  onSave: (event: FormEvent<HTMLFormElement>) => void
  onSkip: () => void
}) {
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-gmail-title">
      <div className="modal-card">
        <button className="modal-close-btn" onClick={onClose} type="button" aria-label="Close modal">
          ×
        </button>
        <h2 id="modal-gmail-title">Add Gmail address</h2>
        <p className="modal-desc">
          This saves an address for the demo only. It does not connect Gmail or grant inbox access.
        </p>
        <form className="modal-form" onSubmit={onSave}>
          <label className="sr-only" htmlFor="gmail-modal-input">Gmail address</label>
          <input
            id="gmail-modal-input"
            type="email"
            inputMode="email"
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            placeholder="name@gmail.com"
            value={gmailInput}
            className="modal-input"
          />
          <div className="modal-actions">
            <button className="secondary-text-btn" onClick={onSkip} type="button">
              skip for now
            </button>
            <button className="primary-pill-btn" type="submit" disabled={!gmailInput.trim()}>
              save <Arrow />
            </button>
          </div>
        </form>
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

function Text() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
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
