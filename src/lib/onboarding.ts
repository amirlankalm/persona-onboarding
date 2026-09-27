export const ONBOARDING_STORAGE_KEY = 'persona-onboarding:v1'
export const ONBOARDING_VERSION = 1

export type Channel = 'incoming' | 'voice' | 'text'
export type Phase = 'naming' | 'ringing' | 'collecting' | 'graduated'
export type SlotStatus = 'empty' | 'candidate' | 'confirmed' | 'skipped'
export type GmailStatus = 'empty' | 'candidate' | 'address_provided' | 'connected' | 'skipped'
export type TranscriptSource = 'agent' | 'user' | 'system'

export interface Slot {
  value: string
  status: SlotStatus
}

export interface GmailSlot {
  address: string
  status: GmailStatus
}

export interface TranscriptItem {
  id: string
  source: TranscriptSource
  text: string
  final: boolean
  createdAt: number
}

export interface OnboardingState {
  version: number
  sessionId: string
  agentName: string
  userName: Slot
  gmail: GmailSlot
  task: Slot
  channel: Channel
  phase: Phase
  transcript: TranscriptItem[]
  updatedAt: number
}

export type OnboardingAction =
  | { type: 'hydrate'; state: OnboardingState }
  | { type: 'name-agent'; value: string }
  | { type: 'ring' }
  | { type: 'choose-channel'; channel: Exclude<Channel, 'incoming'> }
  | { type: 'set-user-name'; value: string; status: SlotStatus }
  | { type: 'set-gmail'; address: string; status: GmailStatus }
  | { type: 'set-task'; value: string; status: SlotStatus }
  | { type: 'skip'; slot: 'userName' | 'gmail' | 'task' }
  | { type: 'append-transcript'; item: TranscriptItem }
  | { type: 'return-to-collecting' }
  | { type: 'reset' }

function createSessionId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `demo-${Math.random().toString(36).slice(2, 12)}`
}

export function createInitialState(): OnboardingState {
  return {
    version: ONBOARDING_VERSION,
    sessionId: createSessionId(),
    agentName: '',
    userName: { value: '', status: 'empty' },
    gmail: { address: '', status: 'empty' },
    task: { value: '', status: 'empty' },
    channel: 'incoming',
    phase: 'naming',
    transcript: [],
    updatedAt: Date.now()
  }
}

function withTimestamp(state: OnboardingState, patch: Partial<OnboardingState>): OnboardingState {
  return { ...state, ...patch, updatedAt: Date.now() }
}

function becomesGraduated(state: OnboardingState, task: Slot): Phase {
  return task.status === 'confirmed' && task.value.trim().length > 3 ? 'graduated' : state.phase
}

export function onboardingReducer(state: OnboardingState, action: OnboardingAction): OnboardingState {
  switch (action.type) {
    case 'hydrate':
      return action.state.version === ONBOARDING_VERSION ? action.state : state
    case 'name-agent': {
      const agentName = sanitizeName(action.value)
      if (!agentName) return state
      return withTimestamp(state, { agentName, phase: 'ringing', channel: 'incoming' })
    }
    case 'ring':
      return state.agentName ? withTimestamp(state, { phase: 'ringing', channel: 'incoming' }) : state
    case 'choose-channel':
      return state.agentName ? withTimestamp(state, { phase: 'collecting', channel: action.channel }) : state
    case 'set-user-name':
      return withTimestamp(state, {
        userName: { value: sanitizeName(action.value), status: action.status }
      })
    case 'set-gmail':
      return withTimestamp(state, {
        gmail: { address: sanitizeEmail(action.address), status: action.status }
      })
    case 'set-task': {
      const task = { value: sanitizeTask(action.value), status: action.status }
      return withTimestamp(state, { task, phase: becomesGraduated(state, task) })
    }
    case 'skip':
      if (action.slot === 'userName') {
        return withTimestamp(state, { userName: { value: '', status: 'skipped' } })
      }
      if (action.slot === 'gmail') {
        return withTimestamp(state, { gmail: { address: '', status: 'skipped' } })
      }
      return withTimestamp(state, { task: { value: '', status: 'skipped' } })
    case 'append-transcript': {
      const existingIndex = state.transcript.findIndex((item) => item.id === action.item.id)
      const transcript = existingIndex === -1
        ? [...state.transcript, action.item].slice(-60)
        : state.transcript.map((item, index) => index === existingIndex ? action.item : item)
      return withTimestamp(state, { transcript })
    }
    case 'return-to-collecting':
      return withTimestamp(state, { phase: 'collecting' })
    case 'reset':
      return createInitialState()
    default:
      return state
  }
}

export function sanitizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 48)
}

export function sanitizeEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, 254)
}

export function sanitizeTask(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 500)
}

export function isGmailAddress(value: string): boolean {
  return /^[^\s@]+@gmail\.com$/i.test(sanitizeEmail(value))
}

export function getSlotSummary(state: OnboardingState): Array<{ label: string; complete: boolean; skipped: boolean }> {
  return [
    { label: 'your name', complete: state.userName.status === 'confirmed', skipped: state.userName.status === 'skipped' },
    { label: 'Gmail', complete: ['address_provided', 'connected'].includes(state.gmail.status), skipped: state.gmail.status === 'skipped' },
    { label: 'first task', complete: state.task.status === 'confirmed', skipped: state.task.status === 'skipped' }
  ]
}

export function getNextQuestion(state: OnboardingState): string {
  if (state.userName.status === 'empty') return 'What should I call you?'
  if (state.gmail.status === 'empty') return 'Want to add a Gmail address for this demo, or skip it for now?'
  if (state.task.status === 'empty') return 'What is one thing you would like help with first?'
  return 'What would you like to adjust?'
}

export function taskFirstStep(task: string): { title: string; detail: string } {
  const cleanTask = sanitizeTask(task)
  const lower = cleanTask.toLowerCase()
  if (/flight|travel|trip/.test(lower)) {
    return { title: 'Shape the travel brief', detail: 'Proposed: collect origin, destination, timing, and budget before comparing options. No travel has been booked.' }
  }
  if (/email|inbox|gmail/.test(lower)) {
    return { title: 'Define an inbox pass', detail: 'Proposed: identify the senders, dates, or decisions to review. No inbox access has been granted.' }
  }
  if (/meeting|calendar|schedule/.test(lower)) {
    return { title: 'Clarify the meeting outcome', detail: 'Proposed: capture attendees, desired outcome, and timing before drafting a plan. Nothing has been scheduled.' }
  }
  return { title: 'Turn this into a first move', detail: `Proposed: break “${cleanTask}” into the smallest useful next action and identify any missing detail. Nothing has been done outside this demo.` }
}

export function isRefusal(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return /^(?:no|nope|skip|not now|skip it|skip this|no thanks|no thank you|don't want to|dont want to|pass|later|never mind)/i.test(normalized)
}

export function parseCandidates(message: string): { userName?: string; gmail?: string; task?: string } {
  const safeMessage = message.slice(0, 1000)
  const normalized = safeMessage.replace(/\s+/g, ' ').trim()
  const COMMON_FILLERS = /^(?:sure|ok|okay|yes|yeah|yep|yup|right|fine|alright|uh|um|hmm|cool|thanks|thank you|hello|hi|hey|yo)[.!?]*$/i
  if (!normalized || isRefusal(normalized) || COMMON_FILLERS.test(normalized)) {
    return {}
  }

  // 1. Spoken or typed Gmail extraction
  let gmailCandidate: string | undefined
  let emailRawMatch = ''
  
  // Handle spoken email with "at/@" and optional "dot/."
  const spokenEmailMatch = normalized.match(/([a-zA-Z0-9._%+-]+(?:\s+(?:dot|\.)\s+[a-zA-Z0-9._%+-]+)*)\s+(?:at|@)\s+([a-zA-Z0-9.-]+(?:\s+(?:dot|\.)\s+[a-zA-Z0-9.-]+)*)/i)
  if (spokenEmailMatch) {
    const userPart = spokenEmailMatch[1].replace(/\s+(?:dot|\.)\s+/gi, '.').replace(/\s+/g, '')
    const domainPart = spokenEmailMatch[2].replace(/\s+(?:dot|\.)\s+/gi, '.').replace(/\s+/g, '')
    const full = `${userPart}@${domainPart}`.toLowerCase()
    if (/^[^\s@]+@gmail\.com$/i.test(full)) {
      gmailCandidate = sanitizeEmail(full)
      emailRawMatch = spokenEmailMatch[0]
    }
  }
  if (!gmailCandidate) {
    const directMatch = normalized.match(/[a-zA-Z0-9._%+-]+@gmail\.com/i)
    if (directMatch) {
      gmailCandidate = sanitizeEmail(directMatch[0])
      emailRawMatch = directMatch[0]
    }
  }

  // 2. Name extraction
  let nameCandidate: string | undefined
  let nameRawMatch = ''
  const isNegativeCall = /(?:can't|cannot|don't|dont|won't|wont|not)\s+(?:call me|call)\b/i.test(normalized)

  if (!isNegativeCall) {
    const nameIntroMatch = normalized.match(/(?:my name is|i am|i'm|im|it's|its|this is|call me(?!\s+(?:on|later|back|at|if|when|up|tomorrow)))\s+([a-zA-Z][a-zA-Z' -]{0,46})/i)
    if (nameIntroMatch) {
      nameRawMatch = nameIntroMatch[0]
      const rawName = nameIntroMatch[1].split(/(?:,|\. | and |, and | at |@| can | please | help | book | organize | schedule | i need)/i)[0]
      if (rawName && rawName.trim().length >= 2) {
        const clean = sanitizeName(rawName)
        nameCandidate = clean.charAt(0).toUpperCase() + clean.slice(1)
      }
    }
  }

  // Handle "Amirlan here" pattern
  if (!nameCandidate && !isNegativeCall) {
    const hereMatch = normalized.match(/^([a-zA-Z][a-zA-Z' -]{1,30})\s+here[.!?]*$/i)
    if (hereMatch && !/^(?:i am|i'm|it's|its)/i.test(hereMatch[1])) {
      const raw = sanitizeName(hereMatch[1])
      nameCandidate = raw.charAt(0).toUpperCase() + raw.slice(1)
      nameRawMatch = hereMatch[0]
    }
  }

  // Single word or full name answer (e.g. user simply says "Amirlan" or "Amirlan Kalmukhan")
  const taskActionVerbs = /^(?:book|plan|organize|schedule|summarize|clean|find|draft|write|check|set up|setup|remind|track|cancel|triage|buy|order|look up|prepare|create|manage|sort|filter|review)\b/i
  if (!nameCandidate && !gmailCandidate && !isNegativeCall && !taskActionVerbs.test(normalized)) {
    const singleNameMatch = normalized.match(/^[a-zA-Z]{2,24}(?:[ -][a-zA-Z]{1,24}){0,2}$/)
    if (singleNameMatch && !/^(?:yes|yeah|sure|okay|skip|help|flight|inbox|gmail|persona|demo|not now|nope|fine|good|great|nothing)$/i.test(normalized)) {
      const raw = sanitizeName(normalized)
      nameCandidate = raw.split(' ').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ')
      nameRawMatch = normalized
    }
  }

  // 3. Task extraction
  let taskCandidate: string | undefined
  const explicitTaskMatch = normalized.match(/(?:help (?:me )?(?:with|to)|i need (?:help )?(?:with|to)?|can you|please|could you)\s+(.+)/i)
  if (explicitTaskMatch) {
    const raw = explicitTaskMatch[1]
    if (!/(?:call me on|hang up|talk later)/i.test(raw)) {
      taskCandidate = sanitizeTask(raw)
    }
  } else if (emailRawMatch) {
    // Single breath candidate: extract remainder after stripping email and name
    let remainder = normalized.replace(emailRawMatch, '')
    if (nameRawMatch) remainder = remainder.replace(nameRawMatch, '')
    remainder = remainder.replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').replace(/^(?:and|also|plus|then)\s+/i, '').trim()
    
    if (remainder.length >= 6 && !COMMON_FILLERS.test(remainder)) {
      taskCandidate = sanitizeTask(remainder)
    }
  } else {
    // Standalone action task without explicit intro (e.g. "book me a flight Friday", "organize my inbox")
    const taskActionVerbs = /^(?:book|plan|organize|schedule|summarize|clean|find|draft|write|check|set up|setup|remind|track|cancel|triage|buy|order|look up|prepare|create|manage|sort|filter|review)\b/i
    if (taskActionVerbs.test(normalized)) {
      taskCandidate = sanitizeTask(normalized)
    }
  }

  return {
    userName: nameCandidate,
    gmail: gmailCandidate,
    task: taskCandidate
  }
}

export function readStoredState(value: string | null): OnboardingState | null {
  if (!value) return null
  try {
    const state = JSON.parse(value) as OnboardingState
    return state.version === ONBOARDING_VERSION && typeof state.agentName === 'string' ? state : null
  } catch {
    return null
  }
}
