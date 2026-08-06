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
| `server/session.ts` | The session. Owns pedagogical modes, timers, persistence. Asks `lib/voice/machine.ts` for the floor; never takes it. |
| `lib/voice/machine.ts` | **Who holds the floor.** The mic/TTS state machine, pure and shared by server and browser. Read this before touching anything about turns. |
| `server/tracker.ts` | Word-by-word passage following: best-attempt scoring, repeats, reading ahead. |
| `server/azure.ts` | `PronunciationSession` — per passage, scoring ONLY. |
| `server/realtime.ts` | The EARS: one Realtime **transcription** session. One transcript per mic-turn. No turn detection, never speaks. |
| `server/tts.ts` | The VOICE: `/v1/audio/speech`, streamed PCM, cancellable. Verbatim, no opinion. |
| `lib/leniency.ts` | Developmental-speech table. Extend this during kid testing. |
| `lib/conversation.ts` | Was that reading, talking, or both? That is all it does now — "have they finished?" and the echo guard went with the button. |
| `lib/turns.ts` | **What is the child's turn FOR, and what do we do about it?** The loop policy, pure. Read before touching anything that asks a question. |
| `lib/facts.ts` | What the child told us today, and which beat may use it. |
| `lib/sessionflow.ts` | When to check in, what progress to celebrate, was that a yes. |
| `lib/topics.ts` | What did they ask the story to be about, and was that "you pick". |
| `lib/profile.ts` | The onboarding draft and what counts as enough to start. |
| `lib/pedagogy.ts` | Mastery math and target selection. Pure, no LLM. |
| `lib/skills.ts` | The skill list and word→skill mapping. |
| `lib/llm/*` | Narrator (story), responder (conversation), onboarding, planner, safety pass, consolidation. |
| `app/api/*` | REST surface (§13). |
| `components/MicButton.tsx` | The owl. It is the control AND the indicator. |
| `components/*` | Session UI + debug panel. |
| `public/worklets/playback-processor.js` | The voice as ONE stream. Read before touching playback. |

## Conventions

- **Model IDs** live in `lib/env.ts` (`MODELS`). Sonnet writes the story; Haiku
  answers the child and runs the safety pass. OpenAI does the ears and the voice,
  as two separate services that never overlap.
- **Never call the Anthropic API without `lib/llm/client.ts`.** It normalises
  `ANTHROPIC_BASE_URL`, which is set without `/v1` on any machine with Claude
  Code installed and otherwise 404s every request.
- **Audio**: mic is 16kHz mono PCM16 (Azure's requirement), upsampled server-side
  to the 24kHz the Realtime API wants; playback is 24kHz mono PCM16. Constants in
  `lib/env.ts` (`AUDIO`). Mic frames are captured and sent ONLY while the mic is
  open — the AudioWorklet is gated, so a closed mic emits nothing at all.
- **Wire protocol**: binary frames are audio (mic up, TTS down), text frames are
  JSON `ClientMessage` / `ServerMessage` from `lib/types.ts`.
- **`reading_events` is append-only.** Never UPDATE or DELETE.
- Only `attempt = 1` results update mastery, so coached retries can't inflate it.
- **The mic button is the single source of truth for who holds the floor.** All
  of it lives in `lib/voice/machine.ts`. No component opens the mic, cancels the
  voice, or decides a turn is over on its own — a request goes through the
  machine and may be REFUSED.
- **The mic being open and the AI speaking are mutually exclusive.** Not rarely
  overlapping: impossible. `AI_SPEECH_START` while the mic is open is refused and
  the line is DROPPED, never queued to fire on close — a sentence written before
  the child took the floor is about a moment that has passed.
- **`autoCloseArmed` is set at open time and never re-derived.** True only when
  the mode is STORY *and* the system opened the mic at the end of a passage. A
  child who taps mid-story is bored or has something to say; closing that turn on
  silence would cut them off at the first breath. Do not infer this flag from
  ambient state later.
- **Onboarding is manual at both ends.** No auto-open, and silence NEVER ends a
  turn there. A four-year-old thinking about what they love has not finished.
- **Two layers, one audio stream, for the length of one turn.**
  `PronunciationSession` scores the passage and is never asked whether the child
  meant to read it. Do not put branching logic back into the assessment stream.
- **Nothing speaks during a reading turn, including coaching.** Scoring records
  what needs saying (`pendingCoach`, `pendingCelebration`) and `afterReadingTurn`
  says it once the floor comes back. Interrupting a five-year-old mid-sentence to
  correct their pronunciation was only ever possible because both could talk at
  once.
- **`AI_SPEECH_END` comes from the BROWSER, not the server.** The server knows
  when it stopped sending audio; the child stops hearing it seconds later. In
  story mode that difference is what auto-opens the mic, so opening on the
  server's signal would make Ollie's own voice the child's first scored word.
- **The Realtime session cannot speak, and does no turn detection.** It is a
  transcription session (`intent=transcription`, `turn_detection: null`), so it
  has no way to emit audio even in principle and no opinion about when a turn is
  over. `turn_detection` must stay null: with VAD on, the server commits the
  buffer itself at every pause, which is a second turn boundary competing with
  the button — and children pause constantly, so it would win and cut them off.
  Narration goes through `server/tts.ts`, which has no conversation and no
  opinion.
- **A child reporting that the app is broken is the most useful thing they can
  say.** `needs_help` takes "I can't see anything" literally: it flags for the
  grown-up and re-pushes the whole visible state (`resync`). It used to land in
  `unclear`, which answered "Hmm, I didn't catch that!" — telling a child their
  correct description of a real bug was their mistake.
- **When the child takes the floor, everything queued for the old one is void.**
  The machine's `generation` counter moves every time the floor changes hands;
  work generated for an earlier generation drops itself. A coaching line written
  before they said "I don't want to read any more" is about a moment that no
  longer exists.
- **An interruption that says nothing does not supersede anything.** Taking the
  floor mid-PROCESSING HOLDS the pending turn (`snapshot.superseded`) instead of
  dropping it, and drops it only once the new turn comes back with words in it.
  A tap comes in pairs: off, then on-and-off again by accident. Dropping on the
  second tap and discarding the third as a double tap threw away the sentence
  the child had just finished saying, and the session went quiet with no error
  anywhere. A transcript for a held turn is caught before the transition table
  sees it, because from the table's point of view it is correctly stale.
- **Playback is ONE stream, not one buffer per chunk.** Samples go into
  `public/worklets/playback-processor.js` and it reads them out at the context
  rate with a phase that survives chunk boundaries. Scheduling each network
  chunk as its own `AudioBufferSourceNode` restarts the resampler, quantises
  every start time onto the output grid, and splices silence in on underrun —
  a dozen small discontinuities a second, which is not heard as clicks but as a
  bad radio signal. A chunk is a unit of network, never a unit of audio.
- **Never ask a question you will not wait for.** Onboarding decides whether it
  has enough BEFORE generating a turn, never after speaking one.
- **A reply is on the critical path; a story beat is not.** Conversation is ONE
  streamed call (`lib/llm/respond.ts`) whose schema order is load-bearing: intent
  first so a sensitive topic is never improvised, then `speak_text` so the voice
  starts before the bookkeeping fields generate. Do not re-add round-trips
  between a child speaking and being answered.
- **The settle window is gone, and with it most of a reply's latency.** Deciding
  a child had finished used to cost 350ms to 3.8s of deliberate waiting, more
  than the model itself. Closing the mic is the end of the turn, so the wait is
  now zero. Do not reintroduce a timer to second-guess the button.
- **A fallback may be plain; it may not be about somebody else.** `fallbackPlan`
  takes the child's memory. It once shipped a hardcoded dragon story to a child
  who had just spent a minute talking about cars, because the planner's schema
  rejected a plan for having one must-use word too many.
- **A detail the child shares never lands in the very next sentence.**
  `lib/facts.ts` owns the delay; the narrator is only told what to say, and only
  once a beat is cleared to use it.
- **A question is a decision, not words.** The LLM writes the reply and may end
  it with a question — its prompt asks it to — so `asksSomething` reads that off
  the words BEFORE the floor moves, and the turn is handed over as `ANSWER`
  rather than `READ`. Without it the answer came back as a brand-new
  conversation, was matched against a line it shared no words with, and went
  back to the responder, which asked again. Nine turns of a child saying "sure"
  to seven rephrasings of one question. The model could see it was repeating
  itself and said so; leaving was never its decision to make.
- **Every hand-over of the floor declares what the turn is for.**
  `speak({ handoff })` takes a `TurnPurpose | null` and `handFloorToChild` takes
  one too — between them the only two ways a child ever gets a turn, so an
  undeclared turn cannot be constructed. Same trick as `autoCloseArmed`: decided
  at the one moment it is knowable, never re-derived. An `ANSWER` turn is read by
  `parseYesNo` before any model sees it and is NEVER matched against the passage;
  "sure" shares no words with any line ever written.
- **Progress is counted, and a stall is broken by code.** Every other guard here
  — `MAX_LOST_TURNS`, `ADAPT_COACH_THRESHOLD`, `MAX_SOCRATIC_QUESTIONS`, the idle
  ladder — guards one *named* failure, which is why an unnamed one ran forever.
  `turnsWithoutProgress` counts turns where the passage cursor did not move, and
  only scoring clears it. At `STALL_TURNS` the session stops asking and says a
  templated line with no question in it; at `STALL_ESCALATE` it moves the story
  on and flags a grown-up. `reply` is the only outcome that can reach the model,
  which is what makes termination provable instead of hoped for.
- **`overlap` and `coverage` answer different questions.** How much of what they
  SAID was the line, versus how much of the LINE they said. Only ever asking the
  first is why reading ahead onto the next line — which five-year-olds do
  constantly — scored like a child talking and got answered as conversation.
- **A single cue word mid-line is a misreading, not a child calling out.** A
  child read "Red is at the net" as "Dad is at the net"; `dad` is in
  `CONVERSATION_CUES`, so one substituted word turned an ordinary misread into an
  interruption and the session discussed it instead of teaching it. A cue sitting
  where a passage word belongs, with the line read correctly around it, is a
  substitution. A cue at the END still means what it says.
- **What they want the story to be about is asked ONCE, then chosen.**
  `lib/topics.ts` reads the subject out of the child's own words when the
  responder returns `requested_topic: null`, treats "you pick" as an ANSWER
  rather than a missing one, and refuses to let a non-answer through as a
  subject. "No preference, pick any" once became the premise of a story, and a
  narrator handed that as a subject asks what they meant — which is the second
  time of asking, from the child's side. After one question the session picks:
  their words, then their favourite thing, then the narrator's own invention.

## Commands

```bash
npm run db:reset        # drop, migrate, seed the demo child
npm run selftest        # deterministic core, no network or DB needed
npm run realtime:check  # prove the OpenAI Realtime voice works on this machine
npm run smoke           # verifies Postgres, Anthropic, Azure, OpenAI credentials
npm run dev             # Next.js on :3000 + WS server on :3001
```

**Run `npm run realtime:check` first when voice or hearing misbehaves.** It asks
your project which audio models it can actually use (the names move faster than
any document), connects the ears, speaks a line, and cancels one mid-sentence.
Far easier to read than the same failure buried in a live session.

Run `npm run selftest` after touching `voice/machine.ts`, `turns.ts`,
`tracker.ts`, `leniency.ts`, `pedagogy.ts`, `skills.ts`, `conversation.ts`,
`topics.ts`, `facts.ts`, `sessionflow.ts`, `profile.ts`, or
`public/worklets/playback-processor.js` — those files carry the behaviour that is
hardest to eyeball and easiest to break. The voice machine's suite covers the
transition table's totality, both mutual-exclusion directions, mid-sentence
barge-in, the manual-interruption override, auto-open/auto-close, rapid double
taps, the held-turn rescue and every stale-message race.

**Every bug this project has shipped was a sequence bug.** Not one was a
function misbehaving — in the livelock above, every individual decision was
locally correct and the aggregate ran forever. Component tests cannot see that,
which is why component tests did not. So the loop policy is pure (`decideTurn` +
`actOn`, the same two functions `routeTurn` dispatches over) and the self-test
drives it across ~100,000 scripted conversations, asserting the two things no
unit test can: the model is never asked to reply more than `STALL_TURNS` times
in a row, and every conversation reaches a line to read. Add a scenario there
before adding a guard here.

The playback worklet is tested by rendering a tone through it in ragged chunks
and measuring the result against the tone it should be — the only kind of test
that can see this class of bug, because every individual chunk is always correct
and the damage is entirely in the seams between them.

`npm run db:reset` seeds an **empty** profile, so the app opens with onboarding.
For the old pre-filled demo child: `SEED_CHILD_NAME=Maya npm run db:seed`.

## Gotchas found the hard way

- The Realtime session config has both a legacy flat shape (`input_audio_format`,
  `turn_detection` at the top level) and the current nested one
  (`audio.input.format`, `audio.input.turn_detection`). `server/realtime.ts` uses
  the nested shape; if a model rejects the session, that is the first thing to
  check.
- Realtime audio is **24kHz PCM16** in both directions. The mic is still captured
  at 16kHz because Azure's assessment wants it, and upsampled server-side
  (`upsample16to24`) — so scoring keeps exactly the audio it always had.
- **Never buffer mic audio across a turn boundary.** `RealtimeVoice.write` drops
  audio when no turn is open, and `beginTurn` clears the buffer. Handing over a
  second of captured room noise the moment a turn opens puts a cough in front of
  the child's first word.
- **Outgoing events are queued until the socket opens.** `Session.start()` asks
  for the greeting a second before the WebSocket finishes its handshake. Dropping
  that `response.create` meant `response.done` never came and the whole session
  hung on an utterance that was never sent.
- **Barge-in has no guard window, and must not grow one.** The guards existed
  because VAD could not tell the child's first syllable from echo cancellation
  adapting to our own voice, so a barge-in before any audio had played, or within
  400ms of it, had to be thrown away — which meant real interruptions in that
  window were thrown away too. A thumb on a button is never a false positive.
- **Transcription models vary by PROJECT, and `/v1/models` does not tell you.**
  This project can see `gpt-live-transcribe` and `gpt-4o-mini-transcribe` in the
  model list and has been refused both. Worse, a refusal closes the whole socket
  (1001) rather than failing the item — so `RealtimeVoice` reconnects down
  `TRANSCRIBE_MODELS` on close. `gpt-live-transcribe` (July 2026) heads the list
  because it is the current low-latency streaming model; `npm run realtime:check`
  opens a session with each candidate and tells you which actually work. Pin one
  with `OPENAI_TRANSCRIBE_MODEL`.
- **A committed turn must ALWAYS come back, and turns are matched by `item_id`.**
  Every path through `RealtimeVoice` resolves `onTranscript` — too-short buffer,
  refused commit, failed transcription, dropped socket, all of it. This was a
  FIFO once, on the reasonable assumption that commits are answered in order.
  They are, right up until one is not answered at all: a refused commit left its
  turn in the queue, every later transcript then shifted off the wrong id and was
  discarded as stale, and the session reopened the microphone every twelve
  seconds forever without progressing. One lost turn must cost one turn.
- **Never commit less than 100ms of audio.** The API refuses it, and the refusal
  used to be the start of the livelock above. `MIN_COMMIT_BYTES` answers a
  too-short turn locally so the round trip that can fail never happens.
- **English is pinned in exactly ONE language field, chosen by model.**
  `languages: ['en']` on gpt-live-transcribe, `language: 'en'` on whisper-1 and
  the gpt-4o-transcribe family. Sending both is not belt and braces, it is an
  error — "The 'language' and 'languages' parameters cannot be used together" —
  and it fails the session at startup, so the first thing the child sees is
  "Something went wrong". A wrong guess is renegotiated silently; the prompt says
  English too, and `looksMistranscribed` catches what still gets through.
  Scoring never cared: Azure is always `en-US` on the raw audio.
- **A rejected session config is negotiated, never shown to the child.**
  `configure(rung)` walks a ladder that gives up the least valuable thing first
  and the language pin last. Which optional fields a transcription model accepts
  genuinely varies, and this all happens before the child has heard anything.
- **Recovery must be bounded.** The watchdog reopens the mic twice and then says
  so out loud and stops. A session waiting to be tapped is recoverable; a session
  talking to itself on a timer is not.
- **PCM16 is two bytes per sample and the network does not care.** An odd-length
  chunk emitted as-is makes the receiver pair bytes off by one from then on —
  which is not a glitch but white noise over the entire voice. Both
  `server/tts.ts` and `lib/client/audio.ts` carry the odd byte forward.
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
