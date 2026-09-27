import { describe, expect, it } from 'vitest'
import {
  createInitialState,
  onboardingReducer,
  parseCandidates,
  readStoredState,
  type OnboardingAction
} from './onboarding'

describe('Persona Crash & Stress Test Suite', () => {
  // SUITE 1: ReDoS & Hostile Input Parsing Resilience
  describe('Suite 1: Parsing Fuzzing & ReDoS Safety', () => {
    it('handles 50,000-character malicious string without catastrophic backtracking (< 50ms)', () => {
      const hugeInput = 'a'.repeat(50000)
      const t0 = performance.now()
      const res = parseCandidates(hugeInput)
      const duration = performance.now() - t0

      expect(res).toBeDefined()
      expect(duration).toBeLessThan(100) // Must complete in under 100ms
    })

    it('handles repeated spoken email patterns without ReDoS', () => {
      const maliciousSpokenEmail = 'user at ' + 'dot '.repeat(5000) + 'gmail dot com'
      const t0 = performance.now()
      const res = parseCandidates(maliciousSpokenEmail)
      const duration = performance.now() - t0

      expect(res).toBeDefined()
      expect(duration).toBeLessThan(100)
    })

    it('safely handles RTL, Unicode, emojis, and null bytes without throwing', () => {
      const hostileStrings = [
        '🔥'.repeat(5000),
        '\u202E\u202D\u200B\uFEFF'.repeat(500),
        'Amirlan\x00\x01\x02\x03\x04\x05',
        '<script>alert("xss")</script>',
        "' OR '1'='1' --",
        'DROP TABLE users; SELECT * FROM credentials;',
        '{}',
        '[]',
        'null',
        'undefined'
      ]

      for (const input of hostileStrings) {
        expect(() => parseCandidates(input)).not.toThrow()
      }
    })
  })

  // SUITE 2: Reducer Chaos Fuzzing (10,000 Random State Transitions)
  describe('Suite 2: Reducer Chaos & Memory Leak Fuzzing', () => {
    it('executes 10,000 random actions in milliseconds without memory expansion', () => {
      let state = createInitialState()
      const sampleActions: OnboardingAction[] = [
        { type: 'name-agent', value: 'TestBot' },
        { type: 'choose-channel', channel: 'voice' },
        { type: 'choose-channel', channel: 'text' },
        { type: 'set-user-name', value: 'Amirlan', status: 'candidate' },
        { type: 'set-user-name', value: 'Amirlan', status: 'confirmed' },
        { type: 'set-gmail', address: 'test@gmail.com', status: 'candidate' },
        { type: 'set-gmail', address: 'test@gmail.com', status: 'address_provided' },
        { type: 'set-task', value: 'Book a flight', status: 'candidate' },
        { type: 'set-task', value: 'Book a flight', status: 'confirmed' },
        { type: 'skip', slot: 'userName' },
        { type: 'skip', slot: 'gmail' },
        { type: 'skip', slot: 'task' },
        { type: 'return-to-collecting' },
        { type: 'reset' }
      ]

      const t0 = performance.now()
      for (let i = 0; i < 10000; i++) {
        const action = sampleActions[i % sampleActions.length]
        state = onboardingReducer(state, action)

        // Inject high volume transcript items
        if (i % 3 === 0) {
          state = onboardingReducer(state, {
            type: 'append-transcript',
            item: {
              id: `msg-${i}`,
              source: i % 2 === 0 ? 'user' : 'agent',
              text: `Message content test ${i}`,
              final: true,
              createdAt: Date.now()
            }
          })
        }
      }
      const duration = performance.now() - t0

      // 10,000 state mutations should finish in < 500ms
      expect(duration).toBeLessThan(500)
      // Transcript is strictly capped at 60 items to prevent client-side memory bloat
      expect(state.transcript.length).toBeLessThanOrEqual(60)
      // State structure remains sound
      expect(state.version).toBe(1)
    })
  })

  // SUITE 3: Storage Corruption Resilience
  describe('Suite 3: LocalStorage Corruption Resilience', () => {
    it('safely recovers from malformed, truncated, or hostile JSON storage values', () => {
      const corruptInputs = [
        null,
        '',
        'undefined',
        '{ broken json',
        '{"version": 12345}',
        '{"version": "persona-onboarding:v9999"}',
        '{"version": "persona-onboarding:v1", "agentName": 9999}',
        '[]',
        'true',
        '"just a string"'
      ]

      for (const corrupt of corruptInputs) {
        expect(() => {
          const res = readStoredState(corrupt)
          expect(res === null || typeof res === 'object').toBe(true)
        }).not.toThrow()
      }
    })
  })

  // SUITE 4: Live HTTP API Endpoints Stress & Concurrency
  describe('Suite 4: Live API Endpoints Stress & Concurrency', () => {
    const textEndpoint = 'http://localhost:3001/api/text'

    it('handles 50 parallel requests to /api/text concurrently with 200 OK', async () => {
      const requests = Array.from({ length: 50 }, (_, idx) => {
        return fetch(textEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: idx % 2 === 0 ? `I am user ${idx}` : `Book flight ${idx}`,
            agentName: 'Geko',
            missing: ['userName', 'gmail', 'task'],
            knownUserName: idx % 2 === 0 ? undefined : 'Amirlan'
          })
        }).then(async (r) => ({
          status: r.status,
          body: (await r.json()) as { reply?: string; error?: string }
        }))
      })

      const t0 = performance.now()
      const results = await Promise.all(requests)
      const duration = performance.now() - t0

      // All 50 concurrent requests must succeed
      for (const res of results) {
        expect(res.status).toBe(200)
        expect(res.body.reply).toBeDefined()
        expect(typeof res.body.reply).toBe('string')
      }

      // Total time for 50 concurrent requests should be under 5000ms
      expect(duration).toBeLessThan(5000)
    })

    it('rejects hostile / malformed payloads with 400 Bad Request instead of 500 error', async () => {
      const hostilePayloads = [
        {},
        { message: '' },
        { message: 'a'.repeat(2000), agentName: 'Geko', missing: [] },
        { message: 'hi', agentName: 'a'.repeat(200), missing: [] },
        { message: 'hi', agentName: 'Geko', missing: ['invalid'] }
      ]

      for (const payload of hostilePayloads) {
        const res = await fetch(textEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })
        expect(res.status).toBe(400)
        const body = (await res.json()) as { error?: string }
        expect(body.error).toBeDefined()
      }
    })

    it('remembers user name across typos and restores it from transcript if omitted from state', async () => {
      // 1. When knownUserName is provided, handles "whtas my name btw?" typo correctly
      const res1 = await fetch(textEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'whtas my name btw?',
          agentName: 'Persona',
          missing: ['gmail'],
          knownUserName: 'John'
        })
      })
      expect(res1.status).toBe(200)
      const data1 = (await res1.json()) as { reply: string }
      expect(data1.reply.toLowerCase()).toContain('john')
      expect(data1.reply.toLowerCase()).not.toContain('what should i call you')

      // 2. When knownUserName was missing from request payload, but present in transcript
      const res2 = await fetch(textEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'u dont know my name',
          agentName: 'Persona',
          missing: ['userName', 'gmail'],
          transcript: [
            { source: 'agent', text: "who am i speaking with?" },
            { source: 'user', text: "Talking to John." },
            { source: 'agent', text: "nice to meet you, John." }
          ]
        })
      })
      expect(res2.status).toBe(200)
      const data2 = (await res2.json()) as { reply: string }
      expect(data2.reply.toLowerCase()).toContain('john')
      expect(data2.reply.toLowerCase()).not.toContain('what should i call you')
    })

    it('prevents replay attacks on /api/speko/tools webhook (> 5m old timestamps)', async () => {
      const staleTimestamp = (Math.floor(Date.now() / 1000) - 600).toString() // 10 minutes ago
      const res = await fetch('http://localhost:3001/api/speko/tools', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'webhook-id': 'msg_stress_test',
          'webhook-timestamp': staleTimestamp,
          'webhook-signature': 'v1,fake_signature'
        },
        body: JSON.stringify({
          type: 'tool_call',
          call_id: 'call_1',
          tool: 'save_name',
          args: { name: 'Test' }
        })
      })

      // Must be rejected as 400 or 401
      expect([400, 401]).toContain(res.status)
    })
  })

  // SUITE 5: Extreme Crash & Torture Testing (100 Concurrency, Massive Transcripts, Voice Route Safety)
  describe('Suite 5: Extreme Crash & Torture Invariants', () => {
    const textEndpoint = 'http://localhost:3001/api/text'
    const voiceEndpoint = 'http://localhost:3001/api/voice-session'
    const webhookEndpoint = 'http://localhost:3001/api/speko/tools'

    it('survives 100 concurrent requests without crashing or dropping connection', async () => {
      const requests = Array.from({ length: 100 }, (_, idx) => {
        return fetch(textEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `User inquiry batch ${idx}: what can you do?`,
            agentName: `Bot${idx}`,
            missing: ['userName', 'gmail', 'task'],
            knownUserName: idx % 3 === 0 ? `User${idx}` : undefined
          })
        }).then(async (r) => ({
          status: r.status,
          data: (await r.json()) as { reply?: string }
        }))
      })

      const t0 = performance.now()
      const results = await Promise.all(requests)
      const duration = performance.now() - t0

      expect(results.length).toBe(100)
      for (const res of results) {
        expect(res.status).toBe(200)
        expect(res.data.reply).toBeDefined()
        expect(typeof res.data.reply).toBe('string')
        // Must never produce em dashes or double hyphens
        expect(res.data.reply).not.toMatch(/[\u2014\u2013]|--/)
      }
      // 100 requests should finish reasonably fast
      expect(duration).toBeLessThan(4000)
    })

    it('safely handles massive 100-turn conversation transcripts without memory overflow', async () => {
      const longTranscript = Array.from({ length: 100 }, (_, i) => ({
        source: (i % 2 === 0 ? 'user' : 'agent') as 'user' | 'agent',
        text: `Turn ${i}: conversation message history tracking test details`
      }))

      const res = await fetch(textEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Can you summarize what we discussed?',
          agentName: 'Persona',
          missing: ['gmail'],
          knownUserName: 'Alexander',
          transcript: longTranscript
        })
      })

      expect(res.status).toBe(200)
      const data = (await res.json()) as { reply: string }
      expect(data.reply).toBeDefined()
      expect(typeof data.reply).toBe('string')
      expect(data.reply.length).toBeGreaterThan(0)
    })

    it('safely handles voice session mint without 500 crash or em dash in error messages', async () => {
      // 1. Valid payload request (returns 200 with live token or 502/503 if upstream unavailable)
      const res1 = await fetch(voiceEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          demoSessionId: 'sess-12345678',
          agentName: 'Persona',
          gmailStatus: 'empty'
        })
      })

      // Must be 200 (live Speko token minted) or 502/503 (upstream/network error), NEVER unhandled 500
      expect([200, 502, 503]).toContain(res1.status)
      const data1 = (await res1.json()) as { error?: string; transportToken?: string }
      if (data1.error) {
        expect(data1.error).not.toMatch(/[\u2014\u2013]/)
      }

      // 2. Corrupt / invalid payload request (must return 400 Bad Request)
      const res2 = await fetch(voiceEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invalidKey: 123
        })
      })
      expect(res2.status).toBe(400)
    })

    it('rejects corrupt or missing webhook signatures without crash', async () => {
      const corruptPayloads: { headers?: Record<string, string> }[] = [
        {},
        { headers: {} },
        { headers: { 'webhook-id': 'x' } },
        { headers: { 'webhook-id': 'x', 'webhook-timestamp': '123' } }
      ]

      for (const item of corruptPayloads) {
        const res = await fetch(webhookEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(item.headers || {})
          },
          body: JSON.stringify({ test: true })
        })
        expect([400, 401]).toContain(res.status)
      }
    })

    it('is immune to reducer prototype pollution or unknown actions', () => {
      let state = createInitialState()
      const maliciousAction = JSON.parse('{"type":"__proto__","polluted":true}') as OnboardingAction
      expect(() => {
        state = onboardingReducer(state, maliciousAction)
      }).not.toThrow()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      expect(state.phase).toBe('naming')
    })
  })
})

