# Persona Onboarding

A high-fidelity onboarding demo for a personal AI assistant — **Persona**. The experience simulates a first contact: the user names their agent, then gets an incoming call (or can continue by text) to share their name, Gmail, and a task they need help with. Adaptive, conversational, and resilient to any user behaviour.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/amirlankalm/persona-onboarding)

---

## ✨ What it does

| Step | Description |
|---|---|
| **Name the Agent** | User picks a name for their personal AI on the landing screen |
| **Incoming Call** | Simulated iOS-style phone call rings — user can Accept or Decline |
| **Voice Onboarding** | Live WebRTC voice call collects: user name, Gmail, and first task — via Speko's realtime voice AI |
| **Text Fallback** | Decline, hangup, mic denial, or refresh? Seamlessly continues as iMessage-style chat powered by Groq (LLaMA 3.3 70B) |
| **Gmail Connect** | Google OAuth UI card appears naturally mid-conversation — never at the start |
| **Graduation** | Once enough context is gathered, the UI surfaces a proposed first task step and celebrates the setup |

---

## 🏗 Architecture

```
Browser (React 19 / Next.js 16)
│
├── SCREEN 1: Naming  — user picks agent name, localStorage persisted
├── SCREEN 2: Ringing — iOS incoming call UI with iMessage sound effects
├── SCREEN 3: Voice   — live WebRTC call via @spekoai/client
│     ├── Speko Agent (voice AI)
│     │     └── llama-3.3-70b via Groq (on Speko's infra)
│     ├── Transcript: real-time captions + slot extraction
│     └── Webhooks: signed Standard Webhooks → /api/speko/tools
│
└── SCREEN 4: Text    — iMessage-style chat (fallback or user choice)
      ├── /api/text → Groq API (llama-3.3-70b-versatile)
      │     ├── Full conversation history context
      │     ├── Agent persona + slot awareness prompt
      │     └── Graceful rule-based fallback if key not set
      └── /api/voice-session → Speko session minting (server-only)
```

### State Machine

```
naming → ringing → [voice | text] → collecting → graduated
                         ↕ (recoverable at any point)
```

One `OnboardingState` object lives in versioned `localStorage`. All transitions are pure reducer functions. Slots: `empty → candidate → confirmed / skipped / address_provided`.

---

## 🤖 Models Used

| Purpose | Model | Provider |
|---|---|---|
| Text conversation (iMessage mode) | **LLaMA 3.3 70B Versatile** | [Groq](https://console.groq.com) |
| Voice agent (phone call mode) | **LLaMA 3.3 70B** (via Speko cascade) | [Speko](https://speko.ai) |
| Voice infrastructure | LiveKit WebRTC + Speko workers | Speko |
| Speech-to-text | Deepgram Nova-3 (Speko managed) | Speko |
| Text-to-speech | Cartesia Sonic (Speko managed) | Speko |

---

## 🚀 Getting Started

### 1. Clone

```bash
git clone https://github.com/amirlankalm/persona-onboarding
cd persona-onboarding
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Required for voice call
SPEKO_API_KEY=sk_live_...        # console.speko.ai
SPEKO_AGENT_ID=agent_...
SPEKO_WEBHOOK_SECRET=whsec_...

# Required for intelligent text chat
GROQ_API_KEY=gsk_...             # console.groq.com (free tier)

# Optional
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

> **Text mode works without Speko keys** — it falls back to rule-based replies. Voice requires Speko credentials.

### 3. Run

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## 🎙 Speko Agent Setup

1. Go to [console.speko.ai](https://console.speko.ai) and create an agent.
2. Paste this system prompt:

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

3. Register these 5 webhook tools pointing at `https://YOUR-DOMAIN/api/speko/tools`:
   - `save_name` — `{ name: string }`
   - `save_gmail` — `{ address: string }`
   - `save_task` — `{ task: string }`
   - `show_gmail_connect` — no params
   - `end_call` — no params

4. Copy the webhook signing secret → `SPEKO_WEBHOOK_SECRET`.

---

## 🌐 Deploy to Vercel

### Environment Variables to add in Vercel dashboard:

```
SPEKO_API_KEY
SPEKO_AGENT_ID
SPEKO_WEBHOOK_SECRET
GROQ_API_KEY
NEXT_PUBLIC_APP_URL=https://your-domain.vercel.app
```

### Deploy steps:

```bash
npm install -g vercel
vercel --prod
```

Or click the deploy button at the top of this README.

> After deploy, update `NEXT_PUBLIC_APP_URL` to your Vercel URL and update the Speko webhook URL to `https://your-domain.vercel.app/api/speko/tools`.

---

## 🔒 Security Notes

- `SPEKO_API_KEY`, `GROQ_API_KEY`, and `SPEKO_WEBHOOK_SECRET` are **server-only** — never exposed to the browser
- Speko webhooks are verified with Standard Webhooks signature verification + 5-minute replay prevention
- Groq API is called only from the server-side `/api/text` route

---

## 🧪 Testing

```bash
npm test          # 23 unit + stress tests (Vitest)
npm run typecheck # TypeScript strict check
npm run lint      # ESLint
npm run build     # Production build verification
```

### Test Coverage

- 15 acceptance tests: normal flow, one-breath multi-slot, hangup recovery, mic denial, localStorage hydration, refusals, task-before-name, ambiguous email correction, noise handling, idempotent reconnect, truthful Gmail status, channel transitions
- 8 stress tests: ReDoS safety (50k-char input in <100ms), 10k random state transitions, hostile Unicode/XSS/SQL injection inputs, localStorage corruption recovery, concurrent hangup/reconnect races

---

## 📁 Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── text/route.ts          # Groq LLM text conversation
│   │   ├── voice-session/route.ts # Speko session minting
│   │   └── speko/tools/route.ts   # Signed webhook receiver
│   ├── page.tsx
│   └── globals.css
├── components/
│   └── PersonaOnboarding.tsx      # Main UI (1300+ lines)
└── lib/
    ├── onboarding.ts              # State machine, reducer, parseCandidates
    ├── audio.ts                   # iMessage/iOS sound effects
    ├── onboarding.test.ts         # 15 acceptance tests
    └── stress.test.ts             # 8 stress/crash tests
```

---

## 🎨 Design

- **Visual language**: Apple iOS iMessage + yourpersona.com — high-craft monochrome, warm paper nuance
- **Typography**: Inter / -apple-system (UI), DM Mono (technical)
- **Colors**: Deep ink `#09090b`, secondary `#71717a`, border `#e4e4e7`, live emerald `#10b981`
- **Sound**: Synthesized iMessage send/receive tones, iOS ringtone, call connect/end tones via Web Audio API (no files, zero latency)
- **Call UI**: Faithful Apple iOS active call layout — 2×3 button grid, live waveform visualizer, real-time captions

---

## 📝 License

MIT
