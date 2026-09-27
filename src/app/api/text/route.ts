import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseCandidates, isRefusal } from '@/lib/onboarding'

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

/**
 * Hard enforcement: strip or replace ALL em dashes (—), en dashes (–), and double hyphens (--).
 * The user explicitly requested NO em dashes under any circumstances.
 */
function cleanReply(text: string): string {
  return text
    .replace(/[\u2014\u2013]/g, ', ')
    .replace(/\s*--\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/\s*,\s*\./g, '.')
    .trim()
}

function detectUserStyle(userMessages: string[]): { isAllLower: boolean; styleInstructions: string } {
  if (userMessages.length === 0) return { isAllLower: false, styleInstructions: '' }

  const all = userMessages.join(' ')
  const signals: string[] = []

  const isAllLower = userMessages.every(m => m === m.toLowerCase())
  const noPunctuation = userMessages.every(m => !/[.!?,;:]$/.test(m.trim()))
  if (isAllLower && noPunctuation) {
    signals.push('very casual: all lowercase, no ending punctuation. Match this exact relaxed lowercase feel.')
  }

  if (/\b(lol|lmao|lmfao|ngl|tbh|fr|bruh|bro|yo|rn|idk|idc|imo|wtf|omg|lowkey|highkey|chill|vibe)\b/i.test(all)) {
    signals.push('uses casual slang or shortcuts. Speak back in an easygoing, genuine human voice.')
  }

  const avgLen = userMessages.reduce((sum, m) => sum + m.split(' ').length, 0) / userMessages.length
  if (avgLen < 6) {
    signals.push('sends short text messages. Keep replies to 1 or 2 short, punchy sentences max.')
  }

  const styleInstructions = signals.length > 0
    ? `\nUSER STYLE DETECTED:\n${signals.map(s => `- ${s}`).join('\n')}\nAdapt your tone naturally to match theirs.`
    : ''

  return { isAllLower, styleInstructions }
}

function buildSystemPrompt(
  agentName: string,
  missing: ('userName' | 'gmail' | 'task')[],
  knownUserName?: string,
  knownTask?: string,
  gmailStatus?: string,
  userMessages?: string[]
): string {
  const userName = knownUserName ? `User name: "${knownUserName}".` : 'User name: not known yet.'
  const task = knownTask ? `User task: "${knownTask}".` : 'User task: not known yet.'
  const gmail = gmailStatus && gmailStatus !== 'empty'
    ? `Gmail status: ${gmailStatus}.`
    : 'Gmail: not linked yet.'

  const missingStr = missing.length === 0
    ? 'All details collected.'
    : `Still needed: ${missing.map(s => s === 'userName' ? 'user name' : s === 'gmail' ? 'Gmail' : 'task').join(', ')}.`

  const { styleInstructions } = detectUserStyle(userMessages ?? [])

  return `You are ${agentName}, a personal AI assistant in an onboarding text chat via iMessage.
You and the user are in an ongoing conversation (some turns may have occurred over voice call or text).

CURRENT STATE:
- ${userName}
- ${task}
- ${gmail}
- ${missingStr}${styleInstructions}

OBJECTIVES (in any natural order):
1. Know what to call the user (if not already known).
2. Learn one thing you can help them with.
3. Mention that Gmail can be connected via the button on screen (or skip it).

STRICT RULES:
- Never use em dashes (—) or en dashes (–). NEVER use them. Use commas or periods instead.
- 1 to 2 short sentences maximum. Be concise, like real texting.
- No bullet points, lists, or markdown.
- No canned AI filler ("Sure!", "Of course!", "How can I assist you?", "Love that energy", "haha. anyway").
- Never claim you sent an email, booked a flight, or accessed an external service you haven't accessed.
- If the user gave a task, acknowledge it and reference the proposed first step on screen.
- If the user asks about the conversation, switches from a call, or complains, react like a real human: apologize simply and adapt immediately.`
}

// 1. Groq caller
async function callGroq(
  systemPrompt: string,
  transcript: Array<{ source: 'user' | 'agent'; text: string }>,
  userMessage: string
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY not configured')

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt }
  ]
  for (const item of transcript.slice(-10)) {
    messages.push({
      role: item.source === 'user' ? 'user' : 'assistant',
      content: item.text
    })
  }
  messages.push({ role: 'user', content: userMessage })

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 150,
      temperature: 0.7,
      top_p: 0.9
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Groq API error ${response.status}: ${err}`)
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>
  }
  const raw = data.choices[0]?.message?.content?.trim()
  if (!raw) throw new Error('Empty response from Groq')
  return cleanReply(raw)
}

// 2. OpenAI caller
async function callOpenAI(
  systemPrompt: string,
  transcript: Array<{ source: 'user' | 'agent'; text: string }>,
  userMessage: string
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured')

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPrompt }
  ]
  for (const item of transcript.slice(-10)) {
    messages.push({
      role: item.source === 'user' ? 'user' : 'assistant',
      content: item.text
    })
  }
  messages.push({ role: 'user', content: userMessage })

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages,
      max_tokens: 150,
      temperature: 0.7
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI API error ${res.status}: ${err}`)
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>
  }
  const raw = data.choices[0]?.message?.content?.trim()
  if (!raw) throw new Error('Empty response from OpenAI')
  return cleanReply(raw)
}

// 3. Google Gemini caller
async function callGemini(
  apiKey: string,
  systemPrompt: string,
  transcript: Array<{ source: 'user' | 'agent'; text: string }>,
  userMessage: string
): Promise<string> {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
  for (const item of transcript.slice(-10)) {
    contents.push({
      role: item.source === 'user' ? 'user' : 'model',
      parts: [{ text: item.text }]
    })
  }
  contents.push({
    role: 'user',
    parts: [{ text: userMessage }]
  })

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 150, temperature: 0.7 }
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${errText}`)
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
  if (!text) throw new Error('Empty response from Gemini')
  return cleanReply(text)
}

// 4. Anthropic caller
async function callAnthropic(
  systemPrompt: string,
  transcript: Array<{ source: 'user' | 'agent'; text: string }>,
  userMessage: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const item of transcript.slice(-10)) {
    messages.push({
      role: item.source === 'user' ? 'user' : 'assistant',
      content: item.text
    })
  }
  messages.push({ role: 'user', content: userMessage })

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      system: systemPrompt,
      max_tokens: 150,
      temperature: 0.7,
      messages
    })
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`Anthropic API error ${response.status}: ${err}`)
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>
  }
  const text = data.content?.[0]?.text?.trim()
  if (!text) throw new Error('Empty response from Anthropic')
  return cleanReply(text)
}

/**
 * Intelligent, context-aware fallback engine when external LLMs are unavailable or fail.
 * Reconciles transcript history (voice + text turns), extracts candidates, and strictly follows rules.
 */
function intelligentFallback({
  message,
  agentName,
  missing,
  knownUserName,
  knownTask,
  gmailStatus,
  transcript
}: {
  message: string
  agentName: string
  missing: ('userName' | 'gmail' | 'task')[]
  knownUserName?: string
  knownTask?: string
  gmailStatus?: string
  transcript: Array<{ source: 'user' | 'agent'; text: string }>
}): string {
  const trimmed = message.trim()
  const lower = trimmed.toLowerCase()
  const isAllLower = trimmed.length > 1 && trimmed === lower && !/[A-Z]/.test(trimmed)

  // 1. Meta / Complaints about bot style, em dashes, or robotic voice
  if (/\b(?:em\s*dash|em-dash|dash|dashes|hyphen)\b/i.test(lower)) {
    return cleanReply('my bad, no dashes at all. keeping it clean. what can i help you with?')
  }
  if (/\b(?:tf|wtf|what the fuck|fuck|fucking|shit|bullshit|trash|annoying)\b/i.test(lower)) {
    return cleanReply("fair enough, resetting. i'm here to help you get set up. what's one thing you want me to tackle?")
  }
  if (/\b(?:talk normally|be normal|stop being robotic|stop robotic|robotic|sound like a human|talk like a human)\b/i.test(lower)) {
    return cleanReply("got it, keeping it completely real. what should i call you, and what are we working on?")
  }

  // 2. Call drop / text continuity ("can you hear me", "continue", "what did you say", "i'm on text")
  if (/\b(?:what('?s| is) my task|what task|current task)\b/i.test(lower) && knownTask) {
    return cleanReply(`your current task is: "${knownTask}". want to adjust it?`)
  }
  if (/\b(?:can you hear me|hear me|hello\??|are you there|you there|what did you say|what were you saying|repeat that|switched to text|on text now|prefer text|call dropped|disconnected|continue|go on)\b/i.test(lower)) {
    // Look at the last thing the agent said in transcript
    const lastAgentMessage = [...transcript].reverse().find(t => t.source === 'agent')?.text.toLowerCase() ?? ''
    if (lastAgentMessage.includes('call you') || lastAgentMessage.includes('who am i') || lastAgentMessage.includes('your name')) {
      return cleanReply('i was asking what i should call you.')
    }
    if (lastAgentMessage.includes('gmail') || lastAgentMessage.includes('google') || lastAgentMessage.includes('inbox')) {
      return cleanReply('i was asking if you wanted to link your Gmail for this demo, or we can skip it.')
    }
    if (lastAgentMessage.includes('help') || lastAgentMessage.includes('plate') || lastAgentMessage.includes('task')) {
      return cleanReply("i was asking what's one thing on your plate i can help with.")
    }
    if (knownUserName) {
      return cleanReply(`hey ${knownUserName}, i'm right here on text. what's one thing you want help with?`)
    }
    return cleanReply("i'm right here on text. what should i call you?")
  }

  // 3. Refusal or skip ("no", "skip", "nah", "nothing", "not now", "pass")
  if (isRefusal(message) || /^(no|nope|skip|nothing|nah|not now|no thanks|pass)\.?$/i.test(lower)) {
    if (missing.includes('gmail')) {
      return cleanReply("all good, we can skip Gmail for now. what's one thing you'd want help with?")
    }
    if (missing.includes('task')) {
      return cleanReply('no worries at all. whenever you have a task in mind, just let me know.')
    }
    if (missing.includes('userName')) {
      return cleanReply("all good, no name needed. what's one thing i can help you with today?")
    }
    return cleanReply("all good, i'm right here whenever you need anything.")
  }

  // 4. Candidate extraction (Name, Gmail, Task)
  const candidates = parseCandidates(message)
  const name = candidates.userName || knownUserName

  if (candidates.userName) {
    if (candidates.task) {
      return cleanReply(`got it, ${candidates.userName}. i noted down "${candidates.task}" and sketched out a first step on screen.`)
    }
    if (candidates.gmail) {
      return cleanReply(`hey ${candidates.userName}, saved your Gmail for this demo. what's one thing on your plate i can help with?`)
    }
    if (missing.includes('gmail') && !['address_provided', 'connected'].includes(gmailStatus ?? '')) {
      return cleanReply(`hey ${candidates.userName}, nice to meet you. there's a button on screen to link Gmail if you want, or what can i help you with?`)
    }
    if (missing.includes('task')) {
      return cleanReply(`hey ${candidates.userName}, good to meet you. what's one task or project i can help you with?`)
    }
    return cleanReply(`hey ${candidates.userName}, nice to meet you. what's on your mind?`)
  }

  if (candidates.task) {
    if (missing.includes('userName') && !name) {
      return cleanReply('on it, i sketched out a proposed first step on screen for that. what should i call you?')
    }
    const namePrefix = name ? `${name}, ` : ''
    return cleanReply(`${namePrefix}got it. i've put together a proposed first step on screen for that. take a look whenever you're ready.`)
  }

  if (candidates.gmail) {
    return cleanReply("got your email saved for this demo. what's one thing i can help you with?")
  }

  // 5. Casual greetings & questions
  if (/^(hi|hey|hello|yo|sup|what's up|howdy)\b/i.test(lower)) {
    if (name) {
      return cleanReply(`hey ${name}! what's one thing on your plate today?`)
    }
    return cleanReply(`hey! i'm ${agentName}. what should i call you?`)
  }
  if (/\b(who are you|what are you)\b/i.test(lower)) {
    return cleanReply(`i'm ${agentName}, your personal assistant for this demo. what should i call you?`)
  }
  if (/\b(how are you|how's it going|how r u)\b/i.test(lower)) {
    return cleanReply('doing great, thanks for asking. what can i help you take care of today?')
  }
  if (/\b(what can you do|what do you do|help me with what)\b/i.test(lower)) {
    return cleanReply("i can help plan tasks, organize your day, or draft out next steps. what's something you're working on?")
  }
  if (/\b(thanks|thank you|thx|ty)\b/i.test(lower)) {
    return cleanReply("anytime! let me know if there's anything else you want to tackle.")
  }

  // 6. Slot-driven progress default
  if (missing.includes('userName')) {
    return cleanReply('what should i call you?')
  }
  if (missing.includes('task')) {
    const prefix = name ? `${name}, ` : ''
    return cleanReply(`${prefix}what's one thing on your plate i can help with?`)
  }
  if (missing.includes('gmail')) {
    const prefix = name ? `${name}, ` : ''
    return cleanReply(`${prefix}would you like to connect Gmail for this demo, or skip it?`)
  }

  const defaultReply = name ? `all set ${name}. what else can i help you with?` : "i'm right here. what would you like to work on?"
  return cleanReply(isAllLower ? defaultReply.toLowerCase() : defaultReply)
}

export async function POST(request: Request) {
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Your message could not be sent. Please try again.' }, { status: 400 })
  }

  const { message, agentName, missing, knownUserName, knownTask, gmailStatus, transcript = [] } = parsed.data
  const userMessages = transcript.filter(t => t.source === 'user').map(t => t.text)

  const systemPrompt = buildSystemPrompt(agentName, missing, knownUserName, knownTask, gmailStatus, userMessages)

  // Try configured LLM providers in priority order
  if (process.env.GROQ_API_KEY) {
    try {
      const reply = await callGroq(systemPrompt, transcript, message)
      return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      console.warn('[/api/text] Groq failed, trying next provider:', (err as Error).message)
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const reply = await callOpenAI(systemPrompt, transcript, message)
      return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      console.warn('[/api/text] OpenAI failed, trying next provider:', (err as Error).message)
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (geminiKey) {
    try {
      const reply = await callGemini(geminiKey, systemPrompt, transcript, message)
      return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      console.warn('[/api/text] Gemini failed, trying next provider:', (err as Error).message)
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const reply = await callAnthropic(systemPrompt, transcript, message)
      return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      console.warn('[/api/text] Anthropic failed, trying next provider:', (err as Error).message)
    }
  }

  // Fallback to our high-intelligence context-aware engine
  const reply = intelligentFallback({
    message,
    agentName,
    missing,
    knownUserName,
    knownTask,
    gmailStatus,
    transcript
  })

  return NextResponse.json({ reply }, { headers: { 'Cache-Control': 'no-store' } })
}
