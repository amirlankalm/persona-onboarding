# Persona — first contact

An intentionally minimal Persona onboarding demo: name the agent on screen, receive an in-browser call, then collect a user name, a Gmail decision, and a first task in any order. It is designed as a product demo, not a mockup.

> **Handoff:** read [AGENTS.md](./AGENTS.md) before making changes. It contains the current architecture, decisions, integration notes, and known limits.

## What is real

- A mobile-friendly Next.js experience with keyboard support, visible focus states, reduced-motion support, and recoverable local browser state.
- The simulated incoming-call interaction, text conversation, candidate confirmation, Gmail address/skip flow, and truthful task-first graduation.
- `VoiceConversation` wiring with Speko’s browser SDK: a server-only session mint, microphone connection, transcript rendering, mute, audio-playback recovery, typed turns while connected, hangup, and unmount cleanup.
- Signed Standard Webhooks verification for the Speko tool endpoint: raw body, signature and five-minute replay validation, delivery deduplication, and Zod validation of `args`.

## What is deliberately not claimed

- A typed Gmail address is **address provided, not connected**. The demo never requests Gmail OAuth scopes or asserts inbox access.
- No message, booking, email, or external action occurs. Graduation displays a proposed first step only.
- Live voice requires your own Speko agent, tool configuration, and local secrets. Without them the UI moves cleanly to the working text path and says why.
- Progress persistence is **per browser** via versioned `localStorage`. It survives refreshes, declines, hangups, and mic failure on that browser, but is not an account-level or cross-device store. Add a durable authenticated store (for example Upstash Redis/Supabase) before presenting it as server-persisted production data.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Then open `http://localhost:3000` (or the port Next selects). Never put secrets in `.env.example` or any committed file.

### Environment

| Variable | Purpose |
| --- | --- |
| `SPEKO_API_KEY` | Server-only Speko API key used to mint a browser session. |
| `SPEKO_AGENT_ID` | Persisted Speko agent configured with the Persona prompt below. |
| `SPEKO_WEBHOOK_SECRET` | Signing secret for the Persona agent’s registered webhook tools. |
| `NEXT_PUBLIC_APP_URL` | Public app origin for deployment documentation and dashboard setup. |

## Speko setup for a live call

1. Create a Speko agent and set its system prompt to the Persona prompt below. Use `{{agentName}}` exactly; the server supplies that value when it mints a session.
2. Add `SPEKO_API_KEY` and the agent id as `SPEKO_AGENT_ID` in the hosting provider’s server environment. The key never reaches the browser.
3. Deploy the app to a public HTTPS origin. Set `NEXT_PUBLIC_APP_URL` to that origin.
4. In the agent’s **Tools** dashboard, register the following webhook tools with URL `https://YOUR-ORIGIN/api/speko/tools`, a shared signing secret stored as `SPEKO_WEBHOOK_SECRET`, and a 4-second-or-less response expectation:

| Tool | When the agent calls it | JSON Schema parameters |
| --- | --- | --- |
| `save_name` | User has clearly confirmed the name to use. | `{ "type":"object", "required":["name"], "properties": { "name": { "type":"string" } } }` |
| `save_gmail` | User confirms an address for demo use. | `{ "type":"object", "required":["address"], "properties": { "address": { "type":"string" } } }` |
| `save_task` | User gives a clear first task. | `{ "type":"object", "required":["task"], "properties": { "task": { "type":"string" } } }` |
| `show_gmail_connect` | User wants the Gmail screen action. | `{ "type":"object", "properties": {} }` |
| `end_call` | User asks to finish the call. | `{ "type":"object", "properties": {} }` |

The route expects Speko’s standard envelope with model values under `args`; it rejects unsigned, stale, malformed, and duplicate deliveries. The current browser SDK does not offer a working mid-call contextual update channel; `overrides`, `sendUserMessage`, and `sendContextualUpdate` are intentionally not used for agent configuration/state. Session variables belong in `POST /v1/sessions` and are set by `src/app/api/voice-session/route.ts`.

### Agent prompt

```text
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
accessed inboxes, made bookings, or started external work you haven't done. One
gentle redirect after off-topic input. On silence or audio trouble, offer text.
Stop asking when the user graduates.
```

## Architecture

`src/lib/onboarding.ts` owns a typed immutable state machine and sanitizers. UI renders only from that state:

```text
naming → ringing → voice | text → collecting → graduated
```

Slots are explicitly `empty`, `candidate`, `confirmed`, or `skipped`; Gmail has separate `address_provided` and `connected` statuses. Voice transcripts can suggest a candidate but cannot directly write state—the user confirms it through the same reducer used by text. The session mint happens only in `src/app/api/voice-session/route.ts`; the browser receives only `transportToken` and `transportUrl`.

## Verification

```bash
npm test
npm run lint
npm run typecheck
npm run build
```

The reducer suite covers the normal state path, one-utterance candidate extraction, hangup/decline/mic-denial-safe channel changes, refresh-safe state shape, Gmail distinction, task-first graduation, and input validation. Before a live presentation, add credentials and manually verify: mic permission accepted and denied, a quick accept/hangup cycle, audio playback recovery, a browser refresh during collection, and a real mobile device.

## Deploy

After setting the environment values in Vercel:

```bash
npm run build
vercel --prod
```

Run the Speko dashboard configuration only after the public Vercel URL exists. Do not add Gmail OAuth until it is fully implemented with minimal scopes, safe state/redirect handling, and an honest connected status.
