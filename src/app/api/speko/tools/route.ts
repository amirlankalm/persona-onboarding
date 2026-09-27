import { NextResponse } from 'next/server'
import { Webhook } from 'standardwebhooks'
import { z } from 'zod'

const toolEnvelope = z.object({
  tool: z.enum(['save_name', 'save_gmail', 'save_task', 'show_gmail_connect', 'end_call']),
  session_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({})
})

const seenDeliveries = new Map<string, number>()
const maxAgeMilliseconds = 5 * 60 * 1000

function pruneDeliveries(now: number): void {
  for (const [id, createdAt] of seenDeliveries) {
    if (now - createdAt > maxAgeMilliseconds) seenDeliveries.delete(id)
  }
}

export async function POST(request: Request) {
  const secret = process.env.SPEKO_WEBHOOK_SECRET
  if (!secret) return NextResponse.json({ error: 'Tool webhook is not configured.' }, { status: 503 })

  const rawBody = await request.text()
  const headers = Object.fromEntries(request.headers.entries())
  const deliveryId = request.headers.get('webhook-id')
  const timestamp = Number(request.headers.get('webhook-timestamp'))
  const now = Date.now()

  if (!deliveryId || !Number.isFinite(timestamp) || Math.abs(now - timestamp * 1000) > maxAgeMilliseconds) {
    return NextResponse.json({ error: 'Expired or malformed webhook delivery.' }, { status: 401 })
  }

  try {
    const verifier = new Webhook(secret, secret.includes('-') || secret.includes('_') ? { format: 'raw' } : undefined)
    verifier.verify(rawBody, headers)
  } catch {
    return NextResponse.json({ error: 'Webhook signature could not be verified.' }, { status: 401 })
  }

  pruneDeliveries(now)
  if (seenDeliveries.has(deliveryId)) {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  const parsed = toolEnvelope.safeParse(JSON.parse(rawBody))
  if (!parsed.success) return NextResponse.json({ error: 'Tool payload did not match the expected shape.' }, { status: 400 })

  seenDeliveries.set(deliveryId, now)
  const { tool, args } = parsed.data
  // State remains browser-local in this demo. The agent receives an honest acknowledgement;
  // production persistence belongs behind a durable, authenticated session store.
  if (tool === 'show_gmail_connect') return NextResponse.json({ ok: true, action: 'show_gmail_connect' })
  if (tool === 'end_call') return NextResponse.json({ ok: true, action: 'end_call' })
  if (tool === 'save_name') return NextResponse.json({ ok: true, candidate: z.string().trim().max(48).safeParse(args.name).data ?? null })
  if (tool === 'save_gmail') return NextResponse.json({ ok: true, candidate: z.string().trim().email().max(254).safeParse(args.address).data ?? null })
  return NextResponse.json({ ok: true, candidate: z.string().trim().max(500).safeParse(args.task).data ?? null })
}
