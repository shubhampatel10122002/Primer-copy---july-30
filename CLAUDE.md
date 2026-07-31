# Primer

Read **PLAN.md** first. Follow its build order and conventions.

## The one rule

**Deterministic code decides what happens; the LLM only decides what words to say.**

Mode transitions, scoring, coaching thresholds, mastery math, and safety gates are
plain TypeScript. The narrator LLM never chooses the next mode — it is told the
mode and asked for words.

## Layout

| Path | What lives there |
|---|---|
| `server/index.ts` | WebSocket server (port 3001). One session per connection. |
| `server/session.ts` | The state machine. Owns modes, timers, half-duplex gate, persistence. |
| `server/tracker.ts` | Word-by-word passage following: best-attempt scoring, repeats, reading ahead. |
| `server/azure.ts` | Pronunciation assessment (reading) + plain STT (talking). |
| `server/cartesia.ts` | Streaming TTS over the raw WebSocket, with per-context cancel for barge-in. |
| `lib/leniency.ts` | Developmental-speech table. Extend this during kid testing. |
| `lib/offscript.ts` | Was that utterance reading, or the child talking? Conservative on purpose. |
| `lib/facts.ts` | What the child told us today, and which beat may use it. |
| `lib/sessionflow.ts` | When to check in, what progress to celebrate, was that a yes. |
| `lib/profile.ts` | The onboarding draft and what counts as enough to start. |
| `lib/pedagogy.ts` | Mastery math and target selection. Pure, no LLM. |
| `lib/skills.ts` | The skill list and word→skill mapping. |
| `lib/llm/*` | Narrator, onboarding, planner, intent router, safety pass, consolidation. |
| `app/api/*` | REST surface (§13). |
| `components/*` | Session UI + debug panel. |

## Conventions

- **Model IDs** live in `lib/env.ts` (`MODELS`). Sonnet for anything the child
  hears; Haiku for classification and the safety pass.
- **Never call the Anthropic API without `lib/llm/client.ts`.** It normalises
  `ANTHROPIC_BASE_URL`, which is set without `/v1` on any machine with Claude
  Code installed and otherwise 404s every request.
- **Audio**: mic is 16kHz mono PCM16 (Azure's requirement); TTS is 44.1kHz mono
  float32 (Web Audio's native format). Constants in `lib/env.ts` (`AUDIO`).
- **Wire protocol**: binary frames are audio (mic up, TTS down), text frames are
  JSON `ClientMessage` / `ServerMessage` from `lib/types.ts`.
- **`reading_events` is append-only.** Never UPDATE or DELETE.
- Only `attempt = 1` results update mastery, so coached retries can't inflate it.
- **Anything a child says gets an answer.** Off-script speech is detected from the
  reading stream (`lib/offscript.ts`) and routed through the same intent router as
  the talk button, so speaking up never needs a button press.
- **A detail the child shares never lands in the very next sentence.**
  `lib/facts.ts` owns the delay; the narrator is only told what to say, and only
  once a beat is cleared to use it.

## Commands

```bash
npm run db:reset   # drop, migrate, seed the demo child
npm run selftest   # deterministic core, no network or DB needed
npm run smoke      # verifies Postgres, Anthropic, Azure, Cartesia credentials
npm run dev        # Next.js on :3000 + WS server on :3001
```

Run `npm run selftest` after touching `tracker.ts`, `leniency.ts`, `pedagogy.ts`,
`skills.ts`, `offscript.ts`, `facts.ts`, `sessionflow.ts`, or `profile.ts` —
those files carry the behaviour that is hardest to eyeball and easiest to break.

`npm run db:reset` seeds an **empty** profile, so the app opens with onboarding.
For the old pre-filled demo child: `SEED_CHILD_NAME=Maya npm run db:seed`.

## Gotchas found the hard way

- The published `@cartesia/cartesia-js` pins `Cartesia-Version: 2024-06-10`,
  which predates the `sonic-3` family. We talk to the WebSocket directly.
- Azure's typed `detailResult` omits per-phoneme scores. Parse the raw
  `SpeechServiceResponse_JsonResult` instead (`server/azure.ts` does).
- Leniency false positives are expensive: forgiving a word silently switches
  coaching off. `lib/leniency.ts` only forgives with evidence of the actual
  substitution, or from a short list of the best-attested ones.
