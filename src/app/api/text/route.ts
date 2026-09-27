import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isRefusal, parseCandidates } from '@/lib/onboarding'

const requestSchema = z.object({
  message: z.string().trim().min(1).max(500),
  agentName: z.string().trim().min(1).max(48),
  missing: z.array(z.enum(['userName', 'gmail', 'task'])).max(3),
  knownUserName: z.string().trim().max(48).optional(),
  knownTask: z.string().trim().max(500).optional(),
  phase: z.enum(['naming', 'ringing', 'collecting', 'graduated']).optional()
})

function generateReply(
  message: string,
  agentName: string,
  missing: ('userName' | 'gmail' | 'task')[],
  knownUserName?: string
): string {
  const candidates = parseCandidates(message)
  const isDeclining = isRefusal(message)

  // 1. Handle refusal / skip
  if (isDeclining) {
    const skippedSlot = missing[0]
    const skippedName = skippedSlot === 'gmail' ? 'Gmail' : skippedSlot === 'userName' ? 'your name' : 'that'
    const remainingMissing = missing.slice(1)
    return `No problem, I’ll mark ${skippedName} as skipped for now. ${nextPrompt(agentName, remainingMissing, knownUserName || candidates.userName)}`
  }

  // 2. Handle one-breath multi-slot or combined utterance
  if (candidates.userName && candidates.task) {
    const greeting = `Nice to meet you, ${candidates.userName}.`
    const emailNotice = candidates.gmail ? ' I have your email candidate ready to confirm.' : ''
    return `${greeting}${emailNotice} I’ve prepared a proposed plan for “${candidates.task}” on screen—nothing has been booked.`
  }

  // 3. Handle task-specific input
  if (candidates.task) {
    const lower = candidates.task.toLowerCase()
    if (/flight|travel|trip/.test(lower)) {
      return `That’s concrete enough to start. I’ve put a proposed travel brief on screen—no tickets are booked. ${nextPrompt(agentName, missing, knownUserName)}`
    }
    if (/inbox|email|gmail/.test(lower)) {
      return `Understood. I’ve proposed an inbox pass on screen—no inbox access is granted. ${nextPrompt(agentName, missing, knownUserName)}`
    }
    return `Got it. I’ve set up a proposed first step for “${candidates.task}” on screen. ${nextPrompt(agentName, missing, knownUserName)}`
  }

  // 4. Handle email-only candidate
  if (candidates.gmail) {
    const nextMissing = missing.filter((s) => s !== 'gmail')
    return `I noted ${candidates.gmail} as a demo candidate. You can confirm it on screen. ${nextPrompt(agentName, nextMissing, knownUserName)}`
  }

  // 5. Handle name-only candidate
  if (candidates.userName) {
    const nextMissing = missing.filter((s) => s !== 'userName')
    return `Nice to meet you, ${candidates.userName}. ${nextPrompt(agentName, nextMissing, candidates.userName)}`
  }

  // 6. Handle single standalone name response when userName is missing
  if (missing.includes('userName') && /^[A-Z][a-z]{1,24}(?:\s+[A-Z][a-z]{1,24})?$/.test(message.trim())) {
    const nextMissing = missing.filter((s) => s !== 'userName')
    return `Nice to meet you, ${message.trim()}. ${nextPrompt(agentName, nextMissing, message.trim())}`
  }

  // 7. Conversational off-topic: one gentle redirect, never stock "I didn't understand"
  return `I’m here to help with that once we’re set up. ${nextPrompt(agentName, missing, knownUserName)}`
}

function nextPrompt(agentName: string, missing: ('userName' | 'gmail' | 'task')[], userName?: string): string {
  const prefix = userName ? `${userName}, ` : ''
  if (missing.includes('userName')) {
    return 'What should I call you?'
  }
  if (missing.includes('gmail')) {
    return `${prefix}would you like to add a Gmail address for this demo, or skip it for now?`
  }
  if (missing.includes('task')) {
    return `${prefix}what is one thing you need help with first?`
  }
  return 'Everything is set. What would you like to refine?'
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Your message could not be sent. Please try again.' }, { status: 400 })
  }
  const { message, agentName, missing, knownUserName } = parsed.data
  return NextResponse.json(
    { reply: generateReply(message, agentName, missing, knownUserName) },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}

