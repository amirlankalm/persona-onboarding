# Persona onboarding — successor brief

**Read this file before editing the project.** It is the authoritative handoff for this repository.

## Assignment and non-negotiables

Build the Persona onboarding demo: collect the on-screen agent name, then invite the user into an in-browser Speko voice call that can collect a user name, a Gmail choice/address, and one task in any order. The product must be truthful: an entered Gmail address is not a connected inbox; no external messages, bookings, or inbox access may be claimed unless implemented. Call decline, mic denial, disconnect, refresh, and a return visit must retain browser progress and provide text continuation. Do not expose `SPEKO_API_KEY` in client code.

## Product intent and visual direction

The experience is a first contact, not a dashboard: `your persona doesn't have a name yet` → contact-card arrival → simulated incoming call → a calm live call or working text alternative → an honest proposed first step. 
Visual language: high-craft monochrome with warm paper nuance, deep ink (`#09090b`), restrained secondary gray (`#71717a`), hairline borders (`#e4e4e7`), and subtle status indicators (emerald `#10b981` when live). 
Strictly deslopped: no oversized 7rem billboard text, no cosmic pseudo-element orbits, no fake phone numbers, no bloated checklists, and no pretend SMS. The reference is yourpersona.com’s terse, high-trust personal-intelligence tone and paper.design's tactile minimalism.

## Implementation status & milestones completed

1. **Bootstrap & System**: Next.js 16 (Turbopack) + React 19 + TypeScript, strict ESLint, Vitest.
2. **Minimalist Design & UX Overhaul (Deslopped)**:
   - Tuned down oversized headings to a restrained, human scale (`clamp(1.85rem, 4.5vw, 2.45rem)`).
   - Crisp Apple/yourpersona-inspired typography: modern Grotesk (`Inter` / `-apple-system`) and technical tabular mono (`DM Mono`).
   - Strictly deslopped: removed `• TEXT MODE` pill badges, repetitive `you`/`agent` sender tags above bubbles, artificial "First Contact" / "Demo Mode" / "Persona Connected" eyebrow tags, and floating corner fluff.
   - Tactile pill inputs and buttons with 44px min touch targets and safe-area insets.
   - Sleek incoming call card with calm breathing avatar and crisp Accept / Decline actions.
   - Compact in-conversation header with subtle live dot for voice, mute toggle, and hang up / text switch controls.
   - Minimalist 5-bar voice activity waveform visualizer.
   - Elegant, centered Gmail demo modal with backdrop blur and explicit "address provided, not connected" distinction.
   - Truthful graduation screen featuring a "Proposed First Step" task card while allowing the live conversation to continue right below it.
3. **Candidate Parsing & Slot Extraction**:
   - Robust `parseCandidates` extractor capable of parsing single-breath multi-slot utterances like `"I'm Amir, amir at gmail dot com, book me a flight Friday"`.
   - Handles spoken email formats (`"at"` / `"@"`, `"dot"` / `"."` in user and domain parts).
   - Isolates name from subsequent task clauses; separates action verbs (`book`, `plan`, `organize`, etc.) from conversational chatter.
   - Dedicated `isRefusal` helper to immediately respect "no", "skip", "not now", "no thanks" without nagging.
4. **Context-Aware Text Responder (`/api/text`)**:
   - Implements the Persona demo agent persona on the server.
   - Acknowledges extracted names and candidates conversationally.
   - Provides honest proposed task steps without claiming external bookings or inbox access.
   - Gently redirects off-topic chatter without stock robotic phrases ("I didn't understand").
5. **Speko Voice Integration & Webhooks**:
   - Server-only session minting via `src/app/api/voice-session/route.ts` (`POST https://api.speko.dev/v1/sessions` with `mode: 'cascade'` and session variables).
   - `@spekoai/client` `VoiceConversation.create` wiring with real microphone streaming, transcript upsert, mute, and unmount teardown.
   - Signed Standard Webhooks receiver in `src/app/api/speko/tools/route.ts` with signature verification, 5-minute replay prevention, delivery deduplication, and Zod parameter validation.
   - Clean fallback: when `SPEKO_API_KEY` is not present, voice returns an honest 503 explanation and seamlessly defaults to text mode without data loss.
6. **Automated Testing Suite (12/12 Acceptance Cases)**:
   - Full automated coverage in `src/lib/onboarding.test.ts` for all 12 specified acceptance scenarios:
     1. Normal voice path: naming → ringing → voice call accepted → slots filled → graduated
     2. Single one-breath utterance with 3 candidates
     3. Hangup after name preserves progress and allows text continuation
     4. Decline from ring screen switches immediately to text
     5. Mic denial / failure transitions safely to text with recovery guidance
     6. Refresh mid-flow rehydrates state from localStorage with version validation
     7. Gmail refusal ("no", "skip", "not now") advances without nagging
     8. Task-before-name ordering preserved
     9. Ambiguous Gmail correction and update
     10. Conversational noise / off-topic input handled without slot corruption
     11. Repeated quick accept/hangup idempotency
     12. Truthful Gmail status distinction (`address_provided` vs `connected`) and mobile constraints

## Architecture and transitions

One browser-owned `OnboardingState` is persisted under versioned localStorage (`persona-onboarding:v1`). Slot statuses distinguish `empty`, `candidate`, `confirmed`, and `skipped`; Gmail separately distinguishes `address_provided` from `connected`. Reducer events validate and atomically advance state; rendering derives solely from state.

`naming → ringing → (voice | text) → collecting → graduated`

Recovery events preserve slots and return to `text` or `ringing`; repeated voice start/hangup is guarded by a single live-conversation reference. A concrete task can move directly to graduation while showing incomplete/skipped slots and allowing continued conversation.

## Speko integration facts verified on 2026-09-27

- `POST https://api.speko.dev/v1/sessions` with `mode: "cascade"`, `agentId`, and server-side `variables` mints `transportToken` and `transportUrl`; variables are compiled into the persisted agent prompt at mint time.
- Browser code imports `VoiceConversation` from `@spekoai/client`, calls `VoiceConversation.create({ transportToken, transportUrl, onConnect, onDisconnect, onMessage, onStatusChange, onModeChange, onError, onAudioPlaybackBlocked })`, uses `setMicMuted`, `sendChatMessage` while connected, and calls `endSession()` on hangup/unmount.
- SDK `overrides`, `sendUserMessage`, and `sendContextualUpdate` are currently ignored by Speko workers, so state sync is driven through server-minted session variables and signed tool webhooks.
- Agent webhooks are Standard Webhooks signed. Read raw body; dedupe `webhook-id`; reject stale `webhook-timestamp`; verify `webhook-signature`; validate model inputs from `args`; return compact JSON within call budget.

Docs: https://docs.speko.ai/client/voice-conversation, https://docs.speko.ai/client, https://docs.speko.ai/guides/tool-calling, https://docs.speko.ai/guides/realtime-conversation.

## Prompt content for the registered Speko agent

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

## Environment, setup, and current status

- Required for live mic: `SPEKO_API_KEY`, `SPEKO_AGENT_ID`, `SPEKO_WEBHOOK_SECRET`; optional `NEXT_PUBLIC_APP_URL`.
- No secret values belong in git or client code.
- Verification results:
  - `npm test`: 12/12 passing.
  - `npm run typecheck`: clean (0 errors).
  - `npm run lint`: clean (0 errors).
  - `npm run build`: compiled in 261ms without warnings.
  - Local HTTP server test: 200 OK on home, `/api/text` verified for multi-slot parsing, refusal, and off-topic redirection; `/api/voice-session` verified for truthful 503 fallback.

## Next steps for live deployment

1. Add your real Speko credentials (`SPEKO_API_KEY`, `SPEKO_AGENT_ID`, `SPEKO_WEBHOOK_SECRET`) to `.env.local` or hosting provider environment variables.
2. Register the 5 tools in the Speko Agent dashboard (`save_name`, `save_gmail`, `save_task`, `show_gmail_connect`, `end_call`) pointing to `https://YOUR-DOMAIN/api/speko/tools`.
3. Deploy to Vercel via `vercel --prod` and test live browser audio on mobile and desktop.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
