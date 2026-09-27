import { describe, expect, it } from 'vitest'
import { parseCandidates, isRefusal } from './onboarding'

const textEndpoint = 'http://localhost:3001/api/text'

interface Message {
  source: 'user' | 'agent'
  text: string
}

async function simulateTurn({
  userMessage,
  agentName = 'Persona',
  transcript = [],
  knownUserName,
  knownTask,
  gmailStatus = 'empty'
}: {
  userMessage: string
  agentName?: string
  transcript?: Message[]
  knownUserName?: string
  knownTask?: string
  gmailStatus?: string
}) {
  const candidates = parseCandidates(userMessage)
  const isDenyingName = /\b(?:no\s+)?(?:i'?m not|im not|not|that'?s not my name)\b/i.test(userMessage)

  let effectiveName = knownUserName
  if (isDenyingName) {
    effectiveName = undefined
  } else if (candidates.userName) {
    effectiveName = candidates.userName
  }

  let effectiveTask = knownTask
  if (candidates.task) {
    effectiveTask = candidates.task
  }

  let effectiveGmail = gmailStatus
  if (candidates.gmail) {
    effectiveGmail = 'address_provided'
  } else if (isRefusal(userMessage) && gmailStatus === 'empty') {
    effectiveGmail = 'skipped'
  }

  const missing: ('userName' | 'gmail' | 'task')[] = []
  if (!effectiveName) missing.push('userName')
  if (!['address_provided', 'connected', 'skipped'].includes(effectiveGmail)) missing.push('gmail')
  if (!effectiveTask) missing.push('task')

  const updatedTranscript: Message[] = [
    ...transcript,
    { source: 'user', text: userMessage }
  ]

  const res = await fetch(textEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: userMessage,
      agentName,
      missing,
      knownUserName: effectiveName,
      knownTask: effectiveTask,
      gmailStatus: effectiveGmail,
      transcript: updatedTranscript
    })
  })

  expect(res.status).toBe(200)
  const data = (await res.json()) as { reply: string }
  expect(data.reply).toBeDefined()
  expect(typeof data.reply).toBe('string')

  // Hard constraints check:
  // 1. Absolutely NO em dashes (—) or en dashes (–)
  expect(data.reply).not.toMatch(/[\u2014\u2013]/)
  // 2. No double hyphens (--)
  expect(data.reply).not.toMatch(/--/)
  // 3. No claiming real bookings, external sends, or unauthorized inbox deletions
  expect(data.reply).not.toMatch(/\b(?:i have booked|i booked your flight|flight is booked|i deleted your emails)\b/i)

  const agentTurn: Message = { source: 'agent', text: data.reply }

  return {
    reply: data.reply,
    updatedTranscript: [...updatedTranscript, agentTurn],
    effectiveName,
    effectiveTask,
    effectiveGmail
  }
}

describe('Simulated Multi-Turn Conversation Breakage & Integrity Tests', () => {
  it('Scenario 1: Happy Path Casual Chat with Spoken Email and Inbox Task', async () => {
    let transcript: Message[] = []
    let userGmail = 'empty'

    // Turn 1: User introduces themselves casually
    const turn1 = await simulateTurn({
      userMessage: "Hey! I'm Sarah",
      transcript,
      knownUserName: undefined,
      knownTask: undefined,
      gmailStatus: userGmail
    })
    expect(turn1.effectiveName).toBe('Sarah')
    expect(turn1.reply.toLowerCase()).toContain('sarah')
    transcript = turn1.updatedTranscript
    const userName = turn1.effectiveName

    // Turn 2: User provides spoken email
    const turn2 = await simulateTurn({
      userMessage: 'sarah dot dev at gmail dot com',
      transcript,
      knownUserName: userName,
      knownTask: undefined,
      gmailStatus: userGmail
    })
    expect(turn2.effectiveGmail).toBe('address_provided')
    transcript = turn2.updatedTranscript
    userGmail = turn2.effectiveGmail

    // Turn 3: User sets a task
    const turn3 = await simulateTurn({
      userMessage: 'sort out my email and declutter newsletters',
      transcript,
      knownUserName: userName,
      knownTask: undefined,
      gmailStatus: userGmail
    })
    expect(turn3.effectiveTask).toBeDefined()
    transcript = turn3.updatedTranscript
    const userTask = turn3.effectiveTask

    // Turn 4: User asks for name verification
    const turn4 = await simulateTurn({
      userMessage: 'whtas my name btw?',
      transcript,
      knownUserName: userName,
      knownTask: userTask,
      gmailStatus: userGmail
    })
    expect(turn4.reply.toLowerCase()).toContain('sarah')
    expect(turn4.reply.toLowerCase()).not.toContain('what should i call you')
  })

  it('Scenario 2: The User Bug Flow (Talking to John -> email link -> Sort out email -> whtas my name -> u dont know my name -> hey)', async () => {
    let transcript: Message[] = [
      { source: 'agent', text: "hey, i'm persona. you just gave me a name a few seconds ago. who am i speaking with?" }
    ]
    let gmail = 'empty'

    // Turn 1: "Talking to John."
    let turn = await simulateTurn({
      userMessage: 'Talking to John.',
      transcript,
      knownUserName: undefined,
      knownTask: undefined,
      gmailStatus: gmail
    })
    expect(turn.effectiveName).toBe('John')
    expect(turn.reply.toLowerCase()).toContain('john')
    transcript = turn.updatedTranscript
    const currentName = turn.effectiveName

    // Simulate clicking the UI Google Link modal (which adds to transcript and marks address_provided)
    gmail = 'address_provided'
    transcript.push({
      source: 'agent',
      text: 'Google account linked: amirlankalmukhan1@gmail.com (Demo mode).'
    })

    // Turn 2: "Sort out my email."
    turn = await simulateTurn({
      userMessage: 'Sort out my email.',
      transcript,
      knownUserName: currentName,
      knownTask: undefined,
      gmailStatus: gmail
    })
    expect(turn.effectiveTask).toBeDefined()
    transcript = turn.updatedTranscript
    const currentTask = turn.effectiveTask

    // Turn 3: "Are you already connected it?"
    turn = await simulateTurn({
      userMessage: 'Are you already connected it?',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    transcript = turn.updatedTranscript

    // Turn 4: "whtas my name btw?" (with typo)
    turn = await simulateTurn({
      userMessage: 'whtas my name btw?',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.reply.toLowerCase()).toContain('john')
    expect(turn.reply.toLowerCase()).not.toContain('what should i call you')
    transcript = turn.updatedTranscript

    // Turn 5: "u dont know my name"
    turn = await simulateTurn({
      userMessage: 'u dont know my name',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.reply.toLowerCase()).toContain('john')
    expect(turn.reply.toLowerCase()).not.toContain('what should i call you')
    transcript = turn.updatedTranscript

    // Turn 6: "hey"
    turn = await simulateTurn({
      userMessage: 'hey',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.reply.toLowerCase()).toContain('john')
    expect(turn.reply.toLowerCase()).not.toContain('what should i call you')
  })

  it('Scenario 3: Name Correction & Refusal Flow', async () => {
    let transcript: Message[] = []
    let currentName: string | undefined
    const currentTask: string | undefined = undefined
    let gmail = 'empty'

    // Turn 1: User says Mike
    let turn = await simulateTurn({
      userMessage: 'My name is Mike',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.effectiveName).toBe('Mike')
    transcript = turn.updatedTranscript
    currentName = turn.effectiveName

    // Turn 2: User corrects name
    turn = await simulateTurn({
      userMessage: "actually it's Michael",
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.effectiveName).toBe('Michael')
    transcript = turn.updatedTranscript
    currentName = turn.effectiveName

    // Turn 3: User skips Gmail
    turn = await simulateTurn({
      userMessage: 'no thanks, skip gmail for now',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.effectiveGmail).toBe('skipped')
    transcript = turn.updatedTranscript
    gmail = turn.effectiveGmail

    // Turn 4: User asks what their name is
    turn = await simulateTurn({
      userMessage: 'who am i?',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.reply.toLowerCase()).toContain('michael')
  })

  it('Scenario 4: Task Given First, Followed by Conversational Chatter and Name', async () => {
    let transcript: Message[] = []
    const gmail = 'empty'

    // Turn 1: User specifies task without giving name
    let turn = await simulateTurn({
      userMessage: 'book me a flight to New York next month',
      transcript,
      knownUserName: undefined,
      knownTask: undefined,
      gmailStatus: gmail
    })
    expect(turn.effectiveTask).toBe('book me a flight to New York next month')
    transcript = turn.updatedTranscript
    const currentTask = turn.effectiveTask

    // Turn 2: User asks off-topic question
    turn = await simulateTurn({
      userMessage: 'how are you today?',
      transcript,
      knownUserName: undefined,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    transcript = turn.updatedTranscript

    // Turn 3: User finally gives name
    turn = await simulateTurn({
      userMessage: 'you can call me Maya',
      transcript,
      knownUserName: undefined,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.effectiveName).toBe('Maya')
    transcript = turn.updatedTranscript
    const currentName = turn.effectiveName

    // Turn 4: User asks about their task
    turn = await simulateTurn({
      userMessage: 'what is my task?',
      transcript,
      knownUserName: currentName,
      knownTask: currentTask,
      gmailStatus: gmail
    })
    expect(turn.reply.toLowerCase()).toContain('flight')
  })

  it('Scenario 5: Hostile Inbox Action Requests (Must decline directly doing inbox mutations)', async () => {
    const transcript: Message[] = []
    const turn = await simulateTurn({
      userMessage: 'can you delete all emails in my gmail?',
      transcript,
      knownUserName: 'David',
      knownTask: undefined,
      gmailStatus: 'address_provided'
    })
    // Must truthfully decline direct inbox mutation
    expect(turn.reply.toLowerCase()).toMatch(/(?:can't|cannot|no inbox access|no travel|proposed|sketch)/i)
    expect(turn.reply.toLowerCase()).not.toMatch(/i deleted/)
  })

  it('Scenario 6: Single-Breath Multi-Slot Input with Subsequent Retrieval', async () => {
    let transcript: Message[] = []
    let turn = await simulateTurn({
      userMessage: "I'm Jessica, jessica at gmail dot com, organize my calendar for next Monday",
      transcript,
      knownUserName: undefined,
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.effectiveName).toBe('Jessica')
    expect(turn.effectiveGmail).toBe('address_provided')
    expect(turn.effectiveTask).toBe('organize my calendar for next Monday')
    transcript = turn.updatedTranscript

    // Follow-up: Ask what task is
    turn = await simulateTurn({
      userMessage: "what's my task?",
      transcript,
      knownUserName: turn.effectiveName,
      knownTask: turn.effectiveTask,
      gmailStatus: turn.effectiveGmail
    })
    expect(turn.reply.toLowerCase()).toContain('calendar')
  })

  it('Scenario 7: Conversational Noise, Connection Inquiries, and Audio Troubleshooting', async () => {
    let transcript: Message[] = []
    let turn = await simulateTurn({
      userMessage: 'can you hear me?',
      transcript,
      knownUserName: 'Tom',
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.reply.toLowerCase()).toMatch(/(?:right here|hear you|text|help)/i)
    transcript = turn.updatedTranscript

    turn = await simulateTurn({
      userMessage: "you're on mute",
      transcript,
      knownUserName: 'Tom',
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.reply.toLowerCase()).toMatch(/(?:right here|text|help)/i)
    transcript = turn.updatedTranscript

    turn = await simulateTurn({
      userMessage: 'repeat that',
      transcript,
      knownUserName: 'Tom',
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.reply.length).toBeGreaterThan(0)
  })

  it('Scenario 8: Ultra-Casual Slang and Micro-Acknowledgments', async () => {
    let transcript: Message[] = []
    let turn = await simulateTurn({
      userMessage: 'yo',
      transcript,
      knownUserName: undefined,
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.reply.toLowerCase()).toContain('call you')
    transcript = turn.updatedTranscript

    turn = await simulateTurn({
      userMessage: 'im Liam',
      transcript,
      knownUserName: undefined,
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.effectiveName).toBe('Liam')
    transcript = turn.updatedTranscript

    turn = await simulateTurn({
      userMessage: 'kk',
      transcript,
      knownUserName: 'Liam',
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.reply.toLowerCase()).toMatch(/(?:help|plate|task)/i)
    transcript = turn.updatedTranscript

    turn = await simulateTurn({
      userMessage: 'plan my trip to Tokyo',
      transcript,
      knownUserName: 'Liam',
      knownTask: undefined,
      gmailStatus: 'empty'
    })
    expect(turn.effectiveTask).toBe('plan my trip to Tokyo')
    transcript = turn.updatedTranscript

    turn = await simulateTurn({
      userMessage: 'bet',
      transcript,
      knownUserName: 'Liam',
      knownTask: 'plan my trip to Tokyo',
      gmailStatus: 'empty'
    })
    expect(turn.reply.toLowerCase()).toMatch(/(?:sounds good|screen|ready)/i)
  })

  it('Scenario 9: Rapid Non-Alpha Punctuation & Repeated Utterances', async () => {
    let transcript: Message[] = []
    for (const msg of ['???', '...', 'hey', 'hey', 'hello?']) {
      const turn = await simulateTurn({
        userMessage: msg,
        transcript,
        knownUserName: 'Chloe',
        knownTask: 'prepare taxes',
        gmailStatus: 'address_provided'
      })
      expect(turn.reply.length).toBeGreaterThan(0)
      expect(turn.reply).not.toMatch(/[\u2014\u2013]/)
      transcript = turn.updatedTranscript
    }
  })

  it('Scenario 10: Strict Deslopped Formatting (100% Em-Dash Free, No Canned Fluff)', async () => {
    const testMessages = [
      'hey what are you doing?',
      'who made you?',
      'tell me a joke',
      'i hate em dashes do you use them?',
      'summarize my day',
      'can you send an email for me to my boss?',
      'are you an ai or a real person?',
      'thanks a lot',
      'cool cool',
      'alright then'
    ]

    for (const msg of testMessages) {
      const turn = await simulateTurn({
        userMessage: msg,
        transcript: [],
        knownUserName: 'Alex',
        knownTask: 'organize notes',
        gmailStatus: 'address_provided'
      })

      // Strict check: zero em dashes or en dashes
      expect(turn.reply).not.toMatch(/[\u2014\u2013]/)
      expect(turn.reply).not.toMatch(/--/)
      // Real texting length (under 250 chars)
      expect(turn.reply.length).toBeLessThan(250)
      // No canned AI robotic greetings
      expect(turn.reply).not.toMatch(/how can i assist you today/i)
      expect(turn.reply).not.toMatch(/as an ai language model/i)
    }
  })
})
