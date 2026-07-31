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
| `server/azure.ts` | `PronunciationSession` (per passage, scoring) + `ConversationEar` (always on, hearing). |
| `server/cartesia.ts` | Streaming TTS over the raw WebSocket, with per-context cancel for barge-in. |
| `lib/leniency.ts` | Developmental-speech table. Extend this during kid testing. |
| `lib/conversation.ts` | Was that reading, talking, or both? Plus the echo guard and "have they finished?". |
| `lib/facts.ts` | What the child told us today, and which beat may use it. |
| `lib/sessionflow.ts` | When to check in, what progress to celebrate, was that a yes. |
| `lib/profile.ts` | The onboarding draft and what counts as enough to start. |
| `lib/pedagogy.ts` | Mastery math and target selection. Pure, no LLM. |
| `lib/skills.ts` | The skill list and word→skill mapping. |
| `lib/llm/*` | Narrator (story), responder (conversation), onboarding, planner, safety pass, consolidation. |
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
- **The child has priority over the narrator, always.** There is no button. The
  mic is open for the whole session, the narrator stops mid-word when the child
  starts, and it never begins a sentence while they are mid-one.
- **Two layers, one audio stream.** `ConversationEar` is opened once and never
  torn down — it hears everything, in every mode. `PronunciationSession` scores
  the passage and is never asked whether the child meant to read it. Do not put
  branching logic back into the assessment stream.
- **Never cut a child off.** Azure ends an utterance at every pause and children
  pause constantly, so utterances are buffered into a turn and only settled after
  real silence (longer if `soundsUnfinished`). Acting on the first segment is how
  "I like cars, like Lamborghini... and Bugatti" becomes an interruption.
- **Stop on the partial, not the final.** A final arrives a second past the
  child's first syllable — by then the narrator has finished its sentence anyway,
  so an interruption that waits for one is indistinguishable from none.
- **When the child takes the floor, `yieldFloor()`.** Queued and held speech is
  dropped, not just the sentence in the air. A coaching line written before they
  said "I don't want to read any more" is about a moment that no longer exists.
- **Never ask a question you will not wait for.** Onboarding decides whether it
  has enough BEFORE generating a turn, never after speaking one.
- **A reply is on the critical path; a story beat is not.** Conversation is ONE
  fast call (`lib/llm/respond.ts`). Story content keeps Sonnet and the full safety
  pass. Do not re-add round-trips between a child speaking and being answered.
- **A fallback may be plain; it may not be about somebody else.** `fallbackPlan`
  takes the child's memory. It once shipped a hardcoded dragon story to a child
  who had just spent a minute talking about cars, because the planner's schema
  rejected a plan for having one must-use word too many.
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
`skills.ts`, `conversation.ts`, `facts.ts`, `sessionflow.ts`, or `profile.ts` —
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
