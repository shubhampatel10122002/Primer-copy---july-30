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
| `server/azure.ts` | `PronunciationSession` — per passage, scoring ONLY. |
| `server/realtime.ts` | The voice and the ears: one OpenAI Realtime socket. Server VAD, transcripts, speech. |
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

- **Model IDs** live in `lib/env.ts` (`MODELS`). Sonnet writes the story; Haiku
  answers the child and runs the safety pass; the Realtime model is the voice.
- **Never call the Anthropic API without `lib/llm/client.ts`.** It normalises
  `ANTHROPIC_BASE_URL`, which is set without `/v1` on any machine with Claude
  Code installed and otherwise 404s every request.
- **Audio**: mic is 16kHz mono PCM16 (Azure's requirement), upsampled server-side
  to the 24kHz the Realtime API wants; playback is 24kHz mono PCM16. Constants in
  `lib/env.ts` (`AUDIO`).
- **Wire protocol**: binary frames are audio (mic up, TTS down), text frames are
  JSON `ClientMessage` / `ServerMessage` from `lib/types.ts`.
- **`reading_events` is append-only.** Never UPDATE or DELETE.
- Only `attempt = 1` results update mastery, so coached retries can't inflate it.
- **The child has priority over the narrator, always.** There is no button. The
  mic is open for the whole session, the narrator stops mid-word when the child
  starts, and it never begins a sentence while they are mid-one.
- **Two layers, one audio stream.** The Realtime socket hears everything, in
  every mode, and never closes. `PronunciationSession` scores the passage and is
  never asked whether the child meant to read it. Do not put branching logic back
  into the assessment stream.
- **Never cut a child off.** Turn detection ends an utterance at every pause and
  children pause constantly, so utterances are buffered into a turn and only
  settled after real silence (`settleDelay`). Acting on the first segment is how
  "I like cars, like Lamborghini... and Bugatti" becomes an interruption.
- **Interruption is an event, not an inference.** Realtime server VAD fires
  `input_audio_buffer.speech_started` from the audio itself, ~200ms after the
  first syllable. Every previous design had to wait for a transcript and was
  therefore always too late. Do not put word-matching back in this path.
- **`create_response: false` is load-bearing.** The Realtime model must never
  reply on its own — it would answer a child reading their passage aloud. We use
  its ears and its voice; the state machine keeps its judgment.
- **When the child takes the floor, `yieldFloor()`.** Queued and held speech is
  dropped, not just the sentence in the air. A coaching line written before they
  said "I don't want to read any more" is about a moment that no longer exists.
- **Never ask a question you will not wait for.** Onboarding decides whether it
  has enough BEFORE generating a turn, never after speaking one.
- **A reply is on the critical path; a story beat is not.** Conversation is ONE
  streamed call (`lib/llm/respond.ts`) whose schema order is load-bearing: intent
  first so a sensitive topic is never improvised, then `speak_text` so the voice
  starts before the bookkeeping fields generate. Do not re-add round-trips
  between a child speaking and being answered.
- **The settle window, not the model, is most of a reply's latency.** At a flat
  2.5s the LLM was under a third of the wait. `settleDelay` spends the patience
  only where a thought is visibly still in motion.
- **A fallback may be plain; it may not be about somebody else.** `fallbackPlan`
  takes the child's memory. It once shipped a hardcoded dragon story to a child
  who had just spent a minute talking about cars, because the planner's schema
  rejected a plan for having one must-use word too many.
- **A detail the child shares never lands in the very next sentence.**
  `lib/facts.ts` owns the delay; the narrator is only told what to say, and only
  once a beat is cleared to use it.

## Commands

```bash
npm run db:reset        # drop, migrate, seed the demo child
npm run selftest        # deterministic core, no network or DB needed
npm run realtime:check  # prove the OpenAI Realtime voice works on this machine
npm run smoke           # verifies Postgres, Anthropic, Azure, OpenAI credentials
npm run dev             # Next.js on :3000 + WS server on :3001
```

**Run `npm run realtime:check` first when voice misbehaves.** It exercises the
connection, the session config and one spoken line in isolation, and prints every
event — far easier to read than the same failure buried in a live session.

Run `npm run selftest` after touching `tracker.ts`, `leniency.ts`, `pedagogy.ts`,
`skills.ts`, `conversation.ts`, `facts.ts`, `sessionflow.ts`, or `profile.ts` —
those files carry the behaviour that is hardest to eyeball and easiest to break.

`npm run db:reset` seeds an **empty** profile, so the app opens with onboarding.
For the old pre-filled demo child: `SEED_CHILD_NAME=Maya npm run db:seed`.

## Gotchas found the hard way

- The Realtime session config has both a legacy flat shape (`input_audio_format`,
  `modalities`) and the current nested one (`audio.input.format`,
  `output_modalities`). `server/realtime.ts` uses the nested shape; if a model
  rejects the session, that is the first thing to check.
- Realtime audio is **24kHz PCM16** in both directions. The mic is still captured
  at 16kHz because Azure's assessment wants it, and upsampled server-side
  (`upsample16to24`) — so scoring keeps exactly the audio it always had.
- **Never buffer mic audio across session setup.** Handing the VAD a second of
  captured room noise the moment it is ready fires `speech_started` on the first
  syllable of the greeting, every session. Audio from before the session is
  configured is dropped.
- **Cancel only what exists.** `response.cancel` before `response.created`
  produces "Cancellation failed: no active response found"; the cancel is
  deferred until the server confirms the response. Errors of that class are
  logged, never shown to the child as "Something went wrong".
- **`interrupt_response: false`.** With it true, the server cancels the response
  and then our cancel arrives to find nothing. Exactly one thing interrupts.
- Azure's typed `detailResult` omits per-phoneme scores. Parse the raw
  `SpeechServiceResponse_JsonResult` instead (`server/azure.ts` does).
- Leniency false positives are expensive: forgiving a word silently switches
  coaching off. `lib/leniency.ts` only forgives with evidence of the actual
  substitution, or from a short list of the best-attested ones.
