# persona-onboarding

Demo of a personal AI's first conversation. The user names the agent, gets a simulated incoming call, and — over voice or text — shares their name, Gmail, and one thing they need help with.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/amirlankalm/persona-onboarding)

---

## How it works

The user lands on a blank screen. Their agent has no name yet. They type one, a contact card arrives, and the phone rings.

From there:

- **Accept** — live WebRTC call via Speko. The agent collects name, Gmail, and a task in whatever order the user gives them.
- **Decline / hang up / mic denied** — drops into an iMessage-style chat that picks up exactly where the call left off. Same transcript, same slots.
- **Refresh mid-flow** — state rehydrates from localStorage. Nothing is lost.

When the agent has enough to go on, it surfaces a proposed first step and lets the conversation continue below it.

Gmail is treated honestly. Providing an address in the demo marks it as `address_provided`, not `connected`. OAuth would be needed for the real thing, and the UI says so.

---

## State

One `OnboardingState` object in versioned localStorage. All transitions go through a pure reducer.

```
naming → ringing → [voice | text] → collecting → graduated
```

Slots move through `empty → candidate → confirmed / skipped`. Switching channels (voice to text or back) carries the full transcript over.

---

## Setup

```bash
git clone https://github.com/amirlankalm/persona-onboarding
cd persona-onboarding
npm install
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Voice call (required for live mic)
SPEKO_API_KEY=sk_live_...
SPEKO_AGENT_ID=agent_...
SPEKO_WEBHOOK_SECRET=whsec_...

# Text chat (optional — falls back to rule-based replies if absent)
GROQ_API_KEY=gsk_...

# Optional
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

```bash
npm run dev
```

---

## Speko agent

Create an agent at [console.speko.ai](https://console.speko.ai). Use this system prompt:

```
You are {{agentName}}, a new personal assistant the user just named on screen.
This is your first conversation. You already know your own name and must not ask
for it. Your goal is to learn what to call the user, whether they want to connect
Gmail (or provide an address in demo mode), and one thing you can help with.
Accept these in any order. Use current state on every turn; don't re-ask a
confirmed or skipped item. Speak in short, natural sentences and match the
user's level of formality. If an answer is uncertain, show the candidate and
confirm it once before committing. If the user refuses, respect it and move on.
For Gmail, offer the screen action rather than demanding spoken spelling; never
say it is connected unless OAuth succeeded. If the user gives a clear task,
identify a concrete first step you can actually display in this demo, then offer
to continue, even if other fields are missing. Do not claim to have sent texts,
accessed inboxes, made bookings, or started external work you haven't done.
One gentle redirect after off-topic input. On silence or audio trouble, offer text.
Stop asking when the user graduates.
```

Register 5 webhook tools pointing at `https://YOUR-DOMAIN/api/speko/tools`:

| Tool | Params |
|---|---|
| `save_name` | `{ name: string }` |
| `save_gmail` | `{ address: string }` |
| `save_task` | `{ task: string }` |
| `show_gmail_connect` | none |
| `end_call` | none |

Copy the signing secret to `SPEKO_WEBHOOK_SECRET`.

---

## Deploy

Add env vars in the Vercel dashboard (`SPEKO_API_KEY`, `SPEKO_AGENT_ID`, `SPEKO_WEBHOOK_SECRET`, `GROQ_API_KEY`, `NEXT_PUBLIC_APP_URL`), then:

```bash
vercel --prod
```

Update the Speko webhook URL to `https://your-domain.vercel.app/api/speko/tools`.

---

## Tests

```bash
npm test          # 23 tests (Vitest)
npm run typecheck
npm run lint
npm run build
```

Covers: normal flow, one-breath multi-slot utterances, hang-up recovery, mic denial, localStorage hydration, refusals, task-before-name ordering, ambiguous email correction, noise/off-topic input, idempotent reconnect, channel transitions, and ReDoS/hostile input stress tests.

---

## Security

`SPEKO_API_KEY`, `GROQ_API_KEY`, and `SPEKO_WEBHOOK_SECRET` never touch the browser. Webhooks from Speko are verified with Standard Webhooks signatures and a 5-minute replay window.

---

## Stack

Next.js 16 (Turbopack), React 19, TypeScript, Vitest. Voice via `@spekoai/client`. Text via Groq (LLaMA 3.3 70B) with a multi-provider fallback chain. Web Audio API for all sound effects — no audio files.

---

MIT
