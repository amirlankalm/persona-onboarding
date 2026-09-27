import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const requestSchema = z.object({
  demoSessionId: z.string().min(8).max(100),
  agentName: z.string().trim().min(1).max(48),
  userName: z.string().trim().max(48).optional(),
  gmailStatus: z.enum(['empty', 'candidate', 'address_provided', 'connected', 'skipped']),
  task: z.string().trim().max(500).optional()
})

export async function POST(request: Request) {
  const apiKey = process.env.SPEKO_API_KEY
  const agentId = process.env.SPEKO_AGENT_ID

  if (!apiKey || !agentId) {
    return NextResponse.json(
      { error: 'Voice is not configured yet. Continue here by text, or add SPEKO_API_KEY and SPEKO_AGENT_ID locally.' },
      { status: 503 }
    )
  }

  const payload = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json({ error: 'The call details were incomplete. Please try again or continue by text.' }, { status: 400 })
  }

  const state = parsed.data
  const response = await fetch('https://api.speko.dev/v1/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID()
    },
    body: JSON.stringify({
      mode: 'cascade',
      agentId,
      variables: {
        agentName: state.agentName,
        demoSessionId: state.demoSessionId,
        knownUserName: state.userName ?? '',
        gmailStatus: state.gmailStatus,
        knownTask: state.task ?? ''
      }
    }),
    cache: 'no-store'
  })

  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok || !body) {
    console.error('Speko session mint failed', { status: response.status })
    return NextResponse.json(
      { error: 'The voice room could not start. Your progress is safe—continue by text or try the call again.' },
      { status: 502 }
    )
  }

  const transportToken = typeof body.transportToken === 'string' ? body.transportToken : null
  const transportUrl = typeof body.transportUrl === 'string' ? body.transportUrl : null
  if (!transportToken || !transportUrl) {
    console.error('Speko session response did not include browser transport credentials')
    return NextResponse.json({ error: 'The voice room returned an incomplete connection. Continue by text.' }, { status: 502 })
  }

  return NextResponse.json({ transportToken, transportUrl }, {
    headers: { 'Cache-Control': 'no-store' }
  })
}
