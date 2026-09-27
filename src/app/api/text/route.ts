import { NextResponse } from 'next/server'
import { z } from 'zod'

const requestSchema = z.object({
  message: z.string().trim().min(1).max(500),
  agentName: z.string().trim().min(1).max(48),
  missing: z.array(z.enum(['userName', 'gmail', 'task'])).max(3),
  knownUserName: z.string().trim().max(48).optional(),
  knownTask: z.string().trim().max(500).optional(),
  gmailStatus: z.string().optional(),
  transcript: z.array(z.object({
    source: z.enum(['user', 'agent']),
    text: z.string()
  })).max(30).optional(),
  phase: z.enum(['naming', 'ringing', 'collecting', 'graduated']).optional()
})

function buildSystemPrompt(
  agentName: string,
  missing: ('userName' | 'gmail' | 'task')[],
  knownUserName?: string,
  knownTask?: string,
  gmailStatus?: string
): string {
  const userName = knownUserName ? `The user's name is ${knownUserName}.` : 'You do not yet know the user\'s name.'
  const task = knownTask ? `The user wants help with: "${knownTask}".` : 'You do not yet know what the user wants help with.'
  const gmail = gmailStatus && gmailStatus !== 'empty'
    ? `Gmail status: ${gmailStatus}.`
    : 'Gmail has not been connected yet.'

  const missingStr = missing.length === 0
    ? 'All slots are filled.'
    : `Still missing: ${missing.map(s => s === 'userName' ? "the user's name" : s === 'gmail' ? 'Gmail connection' : 'what the user needs help with').join(', ')}.`

  return `You are ${agentName}, a personal AI assistant doing a first-contact onboarding conversation via iMessage.

CONTEXT:
- ${userName}
- ${task}
- ${gmail}
- ${missingStr}

YOUR GOALS (collect in any order, but don't be a form):
1. Learn the user's name if not known
2. Mention that Gmail can be connected via the button on screen (never claim actual inbox access)
3. Understand one thing the user wants help with — show them you can provide value
4. If you have enough to show value (especially if they have a concrete task), you can let them "graduate" early

PERSONALITY & TONE:
- Short, casual, iMessage-style messages (1–3 sentences max)
- Match the user's vibe — if they're casual, be casual; if professional, be professional
- No robotic phrases like "I didn't understand" or "How can I assist you today?"
- If they say "nothing" or seem disengaged, don't push hard — acknowledge and gently offer
- If they're off-topic or asking meta questions, answer briefly and naturally, then nudge back
- NEVER claim to have sent emails, booked things, or accessed their inbox
- If Gmail is needed, mention "there's a button on screen to connect it" — don't demand they say an email address
- Be human. React to what they actually said.

IMPORTANT CONSTRAINTS:
- Reply in 1–3 short sentences only
- No lists, no bullet points, no markdown
- No hollow filler ("Great!", "Sure!", "Of course!")
- If they joke around, play along briefly then get back on track
- If they say they need nothing, acknowledge it, ask if they want to chill or if anything comes to mind later`
}

async function callGroq(
  systemPrompt: string,
  transcript: Array<{source: 'user' | 'agent', text: string}>,
  userMessage: string
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not configured')
  }

  const messages: Array<{role: 'system' | 'user' | 'assistant', content: string}> = [
    { role: 'system', content: systemPrompt }
  ]

  // Add conversation history (last 10 turns for context)
  const recentTranscript = transcript.slice(-10)
  for (const item of recentTranscript) {
    messages.push({
      role: item.source === 'user' ? 'user' : 'assistant',
      content: item.text
    })
  }

  // Add current user message
  messages.push({ role: 'user', content: userMessage })

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 150,
      temperature: 0.85,
      top_p: 0.9,
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Groq API error ${response.status}: ${err}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
  }

  const reply = data.choices[0]?.message?.content?.trim()
  if (!reply) throw new Error('Empty response from Groq')
  return reply
}

function fallbackReply(
  message: string,
  agentName: string,
  missing: ('userName' | 'gmail' | 'task')[],
  knownUserName?: string
): string {
  const lower = message.toLowerCase().trim()
  const name = knownUserName ? `${knownUserName}, ` : ''

  // Refusal / skip
  if (/^(no|nope|skip|nothing|nah|not now|no thanks|pass)\.?$/i.test(lower)) {
    if (missing.includes('gmail')) {
      const rest = missing.filter(s => s !== 'gmail')
      if (rest.includes('task')) return `${name}all good. what's one thing you'd want help with?`
      return `${name}got it! anything you'd like to work on together?`
    }
    if (missing.includes('task')) return `${name}no worries. if anything comes up, just say the word.`
    return 'All good — I\'m here when you need me.'
  }

  // Has a name with known name detection
  if (missing.includes('userName')) {
    const capitalized = message.trim().replace(/\b\w/g, c => c.toUpperCase())
    if (/^[a-z]{2,24}$/i.test(message.trim())) {
      const rest = missing.filter(s => s !== 'userName')
      if (rest.includes('gmail')) return `hey ${capitalized}! you can connect Gmail via the button on screen if you'd like. what can i help you with?`
      if (rest.includes('task')) return `hey ${capitalized}! what's one thing on your plate i can help with?`
      return `hey ${capitalized}, nice to officially meet you. what's on your mind?`
    }
  }

  // Task detected
  if (/book|plan|schedule|organize|write|draft|research|find|help|need|want/i.test(lower)) {
    if (missing.includes('userName')) return `on it. just so i know — what should i call you?`
    return `${name}solid, i've sketched out a first step for that on screen. nothing's done yet — want to refine it?`
  }

  // Generic off-topic
  const nextMissing = missing[0]
  if (nextMissing === 'userName') return 'love that energy. what should i call you though?'
  if (nextMissing === 'gmail') return `${name}haha. anyway — want to connect Gmail via the screen button, or skip it?`
  if (nextMissing === 'task') return `${name}lol. but seriously — what can i help you with?`
  return `${name}i'm here. what do you need?`
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Your message could not be sent. Please try again.' }, { status: 400 })
  }

  const { message, agentName, missing, knownUserName, knownTask, gmailStatus, transcript = [] } = parsed.data

  // Try Groq first; fall back to rule-based if not configured
  if (process.env.GROQ_API_KEY) {
    try {
      const systemPrompt = buildSystemPrompt(agentName, missing, knownUserName, knownTask, gmailStatus)
      const reply = await callGroq(systemPrompt, transcript, message)
      return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      console.error('[/api/text] Groq call failed, using fallback:', err)
      // Fall through to rule-based fallback below
    }
  }

  const reply = fallbackReply(message, agentName, missing, knownUserName)
  return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
}
