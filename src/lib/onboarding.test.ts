import { describe, expect, it } from 'vitest'
import {
  createInitialState,
  getNextQuestion,
  getSlotSummary,
  isGmailAddress,
  isRefusal,
  onboardingReducer,
  parseCandidates,
  readStoredState,
  taskFirstStep
} from './onboarding'

describe('Persona onboarding 12 acceptance test cases', () => {
  // 1. Normal voice path: naming -> ringing -> voice -> confirmations -> graduated
  it('(1) normal voice path: naming -> ringing -> voice call accepted -> slots filled -> graduated', () => {
    let state = createInitialState()
    expect(state.phase).toBe('naming')

    state = onboardingReducer(state, { type: 'name-agent', value: 'Sol' })
    expect(state.phase).toBe('ringing')
    expect(state.agentName).toBe('Sol')

    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    expect(state.channel).toBe('voice')
    expect(state.phase).toBe('collecting')

    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })
    state = onboardingReducer(state, { type: 'set-gmail', address: 'amir@gmail.com', status: 'address_provided' })
    state = onboardingReducer(state, { type: 'set-task', value: 'Plan my launch', status: 'confirmed' })

    expect(state.phase).toBe('graduated')
    expect(state.userName).toEqual({ value: 'Amir', status: 'confirmed' })
    expect(state.gmail).toEqual({ address: 'amir@gmail.com', status: 'address_provided' })
    expect(state.task).toEqual({ value: 'Plan my launch', status: 'confirmed' })
  })

  // 2. Everything in one utterance: "I'm Amir, amir at gmail dot com, book me a flight Friday"
  it('(2) parses all three candidates from a single one-breath utterance without confirming automatically', () => {
    const candidates = parseCandidates("I'm Amir, amir at gmail dot com, book me a flight Friday")
    expect(candidates).toEqual({
      userName: 'Amir',
      gmail: 'amir@gmail.com',
      task: 'book me a flight Friday'
    })

    // Now verify reducer handles them as candidates
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'set-user-name', value: candidates.userName!, status: 'candidate' })
    state = onboardingReducer(state, { type: 'set-gmail', address: candidates.gmail!, status: 'candidate' })
    state = onboardingReducer(state, { type: 'set-task', value: candidates.task!, status: 'candidate' })

    expect(state.phase).toBe('ringing') // does not auto-graduate until task is confirmed
    expect(state.userName.status).toBe('candidate')
    expect(state.gmail.status).toBe('candidate')
    expect(state.task.status).toBe('candidate')

    // Confirming task graduates
    state = onboardingReducer(state, { type: 'set-task', value: candidates.task!, status: 'confirmed' })
    expect(state.phase).toBe('graduated')
  })

  // 3. Hang up after name and resume text
  it('(3) hang up after name preserves progress and allows continuing via text', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })

    // Simulate hangup and switch to text
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    expect(state.channel).toBe('text')
    expect(state.userName).toEqual({ value: 'Amir', status: 'confirmed' })
    expect(getNextQuestion(state)).toContain('Gmail')
  })

  // 4. Decline from ring screen
  it('(4) decline from ring screen switches immediately to text conversation', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    expect(state.phase).toBe('ringing')

    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    expect(state.phase).toBe('collecting')
    expect(state.channel).toBe('text')
    expect(state.agentName).toBe('Sol')
  })

  // 5. Deny mic: graceful recovery
  it('(5) mic denial/failure transitions safely to text without losing state', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    // On mic failure, component transitions to text channel
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    expect(state.channel).toBe('text')
    expect(state.agentName).toBe('Sol')
    expect(state.phase).toBe('collecting')
  })

  // 6. Refresh mid-flow
  it('(6) restores state from localStorage and verifies version compatibility', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })

    const serialized = JSON.stringify(state)
    const restored = readStoredState(serialized)
    expect(restored).not.toBeNull()
    expect(restored?.agentName).toBe('Sol')
    expect(restored?.userName.value).toBe('Amir')

    // Invalid version test
    const outdated = JSON.stringify({ ...state, version: 999 })
    expect(readStoredState(outdated)).toBeNull()
  })

  // 7. Gmail refusal
  it('(7) skips Gmail when user declines without blocking progression to task', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })
    state = onboardingReducer(state, { type: 'skip', slot: 'gmail' })

    expect(state.gmail.status).toBe('skipped')
    expect(getNextQuestion(state)).toContain('help with')
    expect(isRefusal('no thanks')).toBe(true)
    expect(isRefusal('skip')).toBe(true)
    expect(isRefusal('not now')).toBe(true)
  })

  // 8. Task before name
  it('(8) allows task to be set first without clobbering name collection', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    state = onboardingReducer(state, { type: 'set-task', value: 'Book me a flight Friday', status: 'confirmed' })

    // Task confirmed moves to graduated early
    expect(state.phase).toBe('graduated')
    expect(state.userName.status).toBe('empty')

    // Can still set user name in graduated phase
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })
    expect(state.userName.value).toBe('Amir')
    expect(state.task.value).toBe('Book me a flight Friday')
  })

  // 9. Ambiguous Gmail correction
  it('(9) allows correcting an ambiguous Gmail address before saving', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    // First candidate
    state = onboardingReducer(state, { type: 'set-gmail', address: 'typo@gmail.com', status: 'candidate' })
    expect(state.gmail).toEqual({ address: 'typo@gmail.com', status: 'candidate' })

    // User corrects it
    state = onboardingReducer(state, { type: 'set-gmail', address: 'correct@gmail.com', status: 'candidate' })
    expect(state.gmail).toEqual({ address: 'correct@gmail.com', status: 'candidate' })

    // User confirms
    state = onboardingReducer(state, { type: 'set-gmail', address: 'correct@gmail.com', status: 'address_provided' })
    expect(state.gmail.status).toBe('address_provided')
  })

  // 10. Nonsense / off-topic
  it('(10) handles off-topic or conversational noise without corrupting slot state', () => {
    const candidates = parseCandidates('hello there good morning how are you')
    expect(candidates.userName).toBeUndefined()
    expect(candidates.gmail).toBeUndefined()
    expect(candidates.task).toBeUndefined()
  })

  // 11. Repeated quick accept/hangup
  it('(11) repeated quick channel changes are idempotent and preserve state', () => {
    let state = onboardingReducer(createInitialState(), { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })

    // Rapid switches
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })

    expect(state.userName.value).toBe('Amir')
    expect(state.channel).toBe('text')
    expect(state.phase).toBe('collecting')
  })

  // 12. Mobile viewport / slot summary & validation constraints
  it('(12) derives accurate slot summaries and strictly distinguishes address provided from connected', () => {
    let state = createInitialState()
    expect(isGmailAddress('user@gmail.com')).toBe(true)
    expect(isGmailAddress('user@yahoo.com')).toBe(false)

    state = onboardingReducer(state, { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'set-gmail', address: 'user@gmail.com', status: 'address_provided' })
    
    // Explicitly verify slot summaries
    const summary = getSlotSummary(state)
    expect(summary[1]).toEqual({ label: 'Gmail', complete: true, skipped: false })
    expect(state.gmail.status).toBe('address_provided') // NOT 'connected'

    // Verify task first step generation
    const travelStep = taskFirstStep('book me a flight to Paris')
    expect(travelStep.title).toBe('Shape the travel brief')
    expect(travelStep.detail).toContain('No travel has been booked')
  })

  it('(13) reset clears state back to initial state cleanly', () => {
    let state = createInitialState()
    state = onboardingReducer(state, { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amir', status: 'confirmed' })
    expect(state.agentName).toBe('Sol')

    const resetState = onboardingReducer(state, { type: 'reset' })
    expect(resetState.phase).toBe('naming')
    expect(resetState.agentName).toBe('')
    expect(resetState.userName.value).toBe('')
    expect(resetState.transcript).toHaveLength(0)
  })

  it('(14) robustly parses spoken and informal user name formats', () => {
    expect(parseCandidates('amirlan').userName).toBe('Amirlan')
    expect(parseCandidates("it's amirlan").userName).toBe('Amirlan')
    expect(parseCandidates('this is Amirlan').userName).toBe('Amirlan')
    expect(parseCandidates('Amirlan here').userName).toBe('Amirlan')
    expect(parseCandidates('call me Amir').userName).toBe('Amir')
  })

  it('(15) transitioning from voice to text cleanly switches channel while retaining all confirmed slots and progress', () => {
    let state = createInitialState()
    state = onboardingReducer(state, { type: 'name-agent', value: 'Sol' })
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'voice' })
    state = onboardingReducer(state, { type: 'set-user-name', value: 'Amirlan', status: 'confirmed' })
    state = onboardingReducer(state, { type: 'set-gmail', address: 'amir@gmail.com', status: 'address_provided' })

    expect(state.channel).toBe('voice')
    expect(state.userName.value).toBe('Amirlan')
    expect(state.gmail.address).toBe('amir@gmail.com')

    // Switch to text
    state = onboardingReducer(state, { type: 'choose-channel', channel: 'text' })
    expect(state.channel).toBe('text')
    expect(state.userName.value).toBe('Amirlan')
    expect(state.userName.status).toBe('confirmed')
    expect(state.gmail.address).toBe('amir@gmail.com')
    expect(state.gmail.status).toBe('address_provided')
  })
})

