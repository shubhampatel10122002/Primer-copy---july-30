# Primer MVP: Build Plan

**For the coding agent: read this entire file before writing any code. Build in the order given in Section 14. Each step must end in something runnable and demoable. Do not skip ahead. Do not add features from Section 15 (out of scope).**

> **Credentials note:** the real API keys live in `.env.local`, which is gitignored.
> They are deliberately not reproduced in this file — it is committed.

## What we are building

A voice-based AI reading companion for one child, for a YC demo. The child reads a dynamically generated story aloud. The AI narrator listens with pronunciation assessment, coaches stuck words, encourages, answers questions Socratically, and adapts the story live.

**One control: the mic button.** The child taps the owl to talk and taps it
again when they are done. That tap is the only thing that decides who holds the
floor — it opens the microphone, it closes it, and pressing it while Ollie is
speaking stops him mid-word. There is one exception, and it is the one that
matters most: during a reading turn the system opens the mic for them when a
passage ends, and closes it when they stop reading, so the story never asks a
five-year-old to press anything to take their turn.

A "Consolidate" button updates the child's memory model, which shapes the next
session's plan — that one is for the founder, not the child.

Scope: single child, no auth, no payments, web app only, English only.

---

## 0. Human setup (the founder does this by hand, not the agent)

### 0.1 Azure Speech
1. portal.azure.com → create a free account.
2. "Create a resource" → **Speech** (under Azure AI services) → Create.
3. Resource group `primer-dev`, region `eastus`, pricing tier `F0` (free, 5 audio hours/month) or `S0`.
4. After deploy, open the resource → **Keys and Endpoint** → copy **KEY 1** and the **Region**.

### 0.2 OpenAI (voice and ears)
1. platform.openai.com → **API keys** → create a key.
2. Put it in `.env.local` as `OPENAI_API_KEY`. Optionally set `OPENAI_TTS_VOICE`
   (alloy, ash, ballad, coral, echo, sage, shimmer, verse, cedar, marin).
3. Verify before anything else: `npm run realtime:check`. It opens a real
   transcription session, runs one complete turn through it, and tells you which
   transcription models this project may actually use.

### 0.3 Anthropic API
Create a key at console.anthropic.com.

### 0.4 Local database
Install Docker Desktop, then `docker compose up -d`.

### 0.5 Environment file
Create `.env.local` at repo root (see `.env.example` for the full list):

```
ANTHROPIC_API_KEY=...
AZURE_SPEECH_KEY=...
AZURE_SPEECH_REGION=eastus
OPENAI_API_KEY=...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/primer
```

### 0.6 MCP servers for Claude Code

```
claude mcp add --transport http microsoft-learn https://learn.microsoft.com/api/mcp
claude mcp add --transport http context7 https://mcp.context7.com/mcp
```

Microsoft Learn for Azure Speech SDK docs. Context7 for the current OpenAI Realtime and Vercel AI SDK docs — the Realtime event schema moves, so check it rather than recalling it. A Postgres MCP is not needed: use `psql` through the shell.

### 0.7 Skills for Claude Code
Maintained in `.claude/skills/` as decisions solidify:
- `.claude/skills/azure-pron/SKILL.md` — Azure config values, result-parsing decisions, the leniency table, gotchas.
- `.claude/skills/narrator/SKILL.md` — narrator system prompt template, structured output contract, mode instructions.

Plus a short `CLAUDE.md` at repo root pointing here.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js (App Router). One session page + a debug/memory panel |
| Backend | Next.js API routes + one standalone Node WebSocket server (`ws`) for the live session |
| LLM | Claude Sonnet (`claude-sonnet-4-6`) for narrator, story planning, consolidation. Claude Haiku (`claude-haiku-4-5`) for intent classification and the safety pass. Via Vercel AI SDK (`@ai-sdk/anthropic`, `generateObject` / `generateText`) |
| Listening + voice | OpenAI Realtime API over one WebSocket: server-side VAD (turn detection), transcription, and speech out. `create_response: false` — we ask it to speak, it never decides to |
| Reading assessment | Azure Speech SDK Pronunciation Assessment, per passage, on the same audio |
| DB | PostgreSQL (Docker), raw SQL via `pg` |
| Agent frameworks | None. Plain TypeScript functions and a deterministic state machine |

Rule of the whole codebase: **deterministic code decides what happens; the LLM only decides what words to say.**

---

## 2. System components

1. **Session WebSocket server**: owns the live session. State machine, fans mic audio to the Realtime socket and to Azure, streams Realtime audio down, calls the narrator LLM. One concurrent session is fine.
2. **Audio pipeline** (browser + server): capture, playback, half-duplex control (§8).
3. **Narrator agent**: one continuous LLM conversation per session, receives mode instructions from the state machine, returns structured output (§7).
4. **Pedagogy module**: pure TypeScript, no LLM calls (§11).
5. **Story planner**: one LLM call producing a session plan JSON before each session (§6).
6. **Consolidation workflow**: one endpoint behind a button (§12).
7. **Debug panel**: live mode, last Azure result, current plan, memory model, memory diff after consolidation. This visible loop IS the YC demo.

---

## 3. Data model (Postgres)

See `db/schema.sql` for the authoritative version. Tables: `children`, `sessions`,
`reading_events` (append-only), `skill_mastery`, `child_memory`,
`child_memory_history`, `session_flags`, plus two implementation tables:
`next_plans` (the plan consolidation prepares for the next session) and
`consolidation_state` (a watermark so consolidation only folds in events it has
not already seen).

Skill list: ~30 skills hardcoded in `lib/skills.ts` (short vowels, common consonant blends, digraphs sh/ch/th/wh, 20 sight words). Each: id, description, example words, prerequisite skill ids.

---

## 4. The session state machine

Runs on the WebSocket server. Deterministic code picks the mode; the LLM writes the words.

| Mode | Trigger to enter | What happens |
|---|---|---|
| ONBOARDING | Session start with a blank profile (`lib/profile.ts`) | A short spoken conversation — name, then what they love. **Fully manual**: the child taps to talk and taps again when done, and silence never ends their turn. Writes the profile, then hands off with "I'm making a story just for you". Capped at 6 questions and 2 silences. |
| NARRATE | Session start, or child finished a passage | Narrator produces next story beat (2-3 spoken sentences) + the child's next passage (1-2 sentences). TTS speaks the beat with the mic **closed**. When the last sample has been heard the mic opens by itself for the child's reading turn. They can tap to cut in at any point. |
| CHILD_READS | Narrator hands over | Mic streams to Azure Pronunciation Assessment with the passage as referenceText. Tracker follows word by word. |
| COACH | Word AccuracyScore < 60 (after leniency table, §9.3), or Omission | Short coaching line ("Let's sound it out: b... l... ue"), said **after the child's turn closes**, never over it. Back to CHILD_READS on the same word, mic reopened for them. Max 2 coach attempts per word, then narrator says the word warmly and moves on. |
| ENCOURAGE | 2 consecutive passages with all words >= 80 accuracy | One short praise line naming something specific, then NARRATE. |
| TALK | A closed turn whose words are not the line on screen (`lib/conversation.ts`) | Answer them, then resume or transition (§5). Reached by tapping — during a reading turn, or over the narrator, which cancels him mid-word. |
| SOCRATIC | intent = question_about_story_or_world | Narrator responds with ONE guiding question. Max 3 guiding questions, then a strong hint, then let the child conclude. Weave back to the story in one sentence, then NARRATE. |
| REMIX | intent = change_request ("I want dragons", "this is boring") | Discard the buffered next beat. Acknowledge immediately, get a topic (§5), then regenerate the remaining beats with the new theme but the SAME difficulty, SAME target skills, SAME must_use words. |
| ADAPT | 3+ COACH entries within one passage, or frustration detected | Difficulty down one level. Discard buffered beat. Regenerate next passage, shorter and simpler. |
| WRAP_UP | ~6 passages or 10 min (then ~4 / 6 min), or the beat list runs out (`lib/sessionflow.ts`) | Celebrate, name the words they were stuck on and then got right, and ask whether to keep reading. Answered by voice or by tapping. Yes extends the same story (same premise, difficulty, skills, must-use words); no or silence goes to END. |
| END | Child wants to stop, no answer at a check-in, or 30 min hard stop | Closing line referencing something specific the child did. Wraps the story in one beat. Saves the transcript and folds today's facts into memory. |

Cross-cutting rules:
- The child has priority over the narrator, always. The narrator stops mid-word
  when they start, and never begins a sentence while they are mid-one.
- Always keep ONE beat buffered; discard the buffer on REMIX, ADAPT, or SOCRATIC.
- A word the child was coached on and then reads correctly gets an immediate
  templated celebration — no LLM in the path, because it has to land at once.
- Anything the child reveals about their life is recorded, but never used in the
  next sentence: `lib/facts.ts` releases at most one detail per beat, at least two
  beats after hearing it. Feelings are answered in the moment and never woven.
- Every Azure word result is written to `reading_events` immediately.
- Nobody taking a turn in CHILD_READS: 12s gentle prompt, 30s a friendly check-in, 50s pause the session with a resume screen. Never nag more than twice. Measured from the last turn, not from the last sound — the mic is shut most of the time and silence no longer means anything.
- All mode transitions are appended to the session transcript with timestamps.

---

## 5. TALK mode and the intent router

**The mic button is the way in.** A turn begins when the child opens the mic —
by tapping, or because the system opened it for them at the end of a passage —
and ends when it closes. Nothing else is a turn.

Two layers get the same audio, for the duration of that turn, and never contend
for it:

- **The transcription layer** (`RealtimeVoice`, `server/realtime.ts`) is a
  Realtime transcription session with `turn_detection: null`. It does not decide
  anything about turns: the audio between opening and closing the mic is
  committed as one unit and comes back as one transcript.
- **The assessment layer** (`PronunciationSession`) is created per passage and
  answers exactly one question: how well were the words on screen said. It is
  strict, and it is never asked whether the child *meant* to read them.

Every closed turn goes through `branchUtterance` (`lib/conversation.ts`), which
compares it to the line on screen and returns one of three things:

| Branch | Meaning | What happens |
|---|---|---|
| `reading` | It matches the line | Nothing. The assessment layer already scored it. |
| `conversation` | It does not | Answer it. |
| `mixed` | Both, in one breath | Score the reading; answer the aside. |

There is no fourth branch and none of the three is "ignore". An utterance that
reaches the branch always ends in a score, a reply, or both.

Interruption is not decided at all. A tap while the narrator is speaking cancels
him in the same transition that opens the mic (`lib/voice/machine.ts`), in the
browser, before a byte reaches the server. Every earlier design had to infer it —
from a partial transcript, then from server VAD plus two guard windows — and each
inference had a false-positive that killed the greeting and a false-negative that
let him talk over a child.

"Have they finished?" is not decided either. That question owned the largest and
most delicate machinery in the codebase: results buffered into a turn, settled
after 350ms to 3.8s depending on whether the last word was "and". The child
closing the mic is the end of their turn, so `input_audio_buffer.commit` and
"they are done" are the same instant. "I like cars, like Lamborghini... and
Bugatti" is one turn because they held the floor for all of it.

Flow once a turn closes as conversation:


1. If the narrator was speaking, he stopped the moment they tapped.
2. **One** call (`lib/llm/respond.ts`) works out what they meant AND writes the
   reply, and pulls out anything they revealed about their own life for the fact
   ledger (`lib/facts.ts`). One round-trip, not three: this used to be classify,
   then narrate, then safety-check, in series, and a child who waits four seconds
   for an answer has already concluded nobody is listening.
3. The reply is spoken immediately. What the SESSION does next is decided by
   code, from the intent:
   - `help_with_word` — answer DIRECTLY (procedural help is never Socratic), then CHILD_READS.
   - `question_about_story_or_world` — enter SOCRATIC.
   - `change_request` — enter REMIX. If they said what they want ("trucks"),
     rebuild around it. If they only said they were bored, **ask them what they
     would like** and listen for the answer — "bored" is not a topic, and
     rebuilding the story around the word is not an answer. No reply and we steer
     to their strongest known interest. Either way the remaining beats are
     retold around it, not just the next one.
   - `chitchat` — one warm sentence, logged as an interest signal, weave back.
   - `want_to_stop` — enter END gracefully. Log `early_exit`. Never guilt-trip.
   - `sensitive_topic` — FIXED comfort template, never improvised, log a `sensitive_topic` flag for the parent, gently return to the story.
   - `unclear` — "Hmm, I didn't catch that! Want to tell me again, or keep reading?"

Sensitive topic template (hardcoded in `lib/templates.ts`): "That's a really big question, and I'm glad you told me. That's a great thing to talk about with your grown-up. They give the best hugs too. Should we find out what happens to [character]?"

---

## 6. Session plan schema

Generated by one `generateObject` call before each session, from child_memory + top 3 target skills.

```json
{
  "goal": "practice blend_bl, sight_friend; review short_a",
  "target_skills": ["blend_bl", "sight_friend", "short_a"],
  "premise": "Maya and Blue the dragon search for the lost bell",
  "characters": ["Blue the dragon (from canon)", "Maya (the child)"],
  "beats": ["Maya finds a torn map in the garden", "They cross the wobbly bridge", "The bell is found inside the old clock"],
  "difficulty": 3,
  "vocab_constraints": {
    "must_use_words": ["blue", "black", "friend", "map"],
    "max_sentence_words": 7,
    "allowed_patterns": "only skills with p_mastery > 0.5 plus target skills"
  }
}
```

---

## 7. Narrator agent contract

One conversation per session. System prompt includes child name/age, interests, personality_notes, canon, the session plan, and six hard rules. See `.claude/skills/narrator/SKILL.md`.

Every narrator call returns structured output:

```json
{
  "speak_text": "text the AI says aloud (sent to the speech endpoint)",
  "child_passage": "text the child reads next, or null",
  "plan_update": "optional: modified remaining beats",
  "current_beat_index": 1
}
```

Safety pass: before TTS, run `speak_text` + `child_passage` through one Haiku call with a yes/no rubric. On fail, regenerate once, then fall back to a safe template line. Log all failures.

---

## 8. Audio pipeline

### 8.1 Capture
- `getUserMedia` with `echoCancellation: true, noiseSuppression: true, autoGainControl: true`.
- AudioWorklet captures PCM, downsamples to 16kHz mono 16-bit, sends binary frames over the WebSocket.
- Server pushes frames into an Azure push-stream. Do NOT use the browser's SpeechRecognition API.

### 8.2 Half-duplex rule (echo prevention)

There is no gate any more, because there is nothing left for it to guard.

The rule used to be "never score ourselves": while audio was playing, and for
300ms after, no frame reached pronunciation assessment. It needed a timer because
capture never stopped, so our own voice really was in the microphone and really
could be scored as the child's.

The mic button removes the situation rather than defending against it. While
Ollie is speaking the mic is closed, and a closed mic emits no frames at all —
the AudioWorklet is gated, and the browser sends nothing. Mutual exclusion is a
property of `lib/voice/machine.ts`: `MIC_OPEN` and `AI_SPEAKING` are different
states, and asking to speak while the mic is open is refused outright rather than
queued. `looksLikeEcho` is gone with the rest of it — there is no echo path left
for it to be a backstop against.

`getUserMedia` still runs with `echoCancellation: true`.

**The end of an utterance is reported by the browser, not the server.** The
server knows when it stopped *sending* audio; the child stops *hearing* it
seconds later. In story mode that difference is what auto-opens the mic, so
`playback_drained` comes from the browser watching its own queue drain. Opening
on the server's signal would put the microphone live while Ollie was still
audible — the exact failure the old gate existed to prevent, arriving by a new
route.

### 8.3 Playback
TTS audio (24kHz mono PCM16) is forwarded over the WebSocket and played via Web Audio with a small jitter buffer. Barge-in stops every scheduled source immediately, so the worst case is one jitter buffer already inside the audio device. While the child reads passage N, beat N+1 is already generated by the narrator.

### 8.4 Mic check onboarding
A 15-second "say hi to Ollie!" screen. Verifies mic permission, audio path, and volume, and gives the child one successful voice interaction before any reading. If mic fails, show parent-facing fix instructions. Never start a session with an unverified mic. It also teaches the one control there is: "tap the owl to talk, and tap him again when you're done".

---

## 9. Azure integration details

### 9.1 Reading mode
Streaming, server-side SDK, per passage: `referenceText` = the passage,
`gradingSystem: HundredMark`, `granularity: Phoneme`, `enableMiscue: true`.
Parse per-word `Word`, `AccuracyScore`, `ErrorType`, `Phonemes[]`. Feed each result to the state machine and write to `reading_events`.

### 9.2 Conversation mode
Not Azure. Everything the child says goes to the Realtime transcription session
(`server/realtime.ts`), which runs alongside assessment on the same audio for the
duration of a turn. There used to be a second Azure recognizer here
(`ConversationEar`); it was left behind when transcription moved and has been
deleted.

### 9.3 Leniency table (developmental speech)
Ages 4-6 routinely substitute phonemes. These are NOT reading errors: r→w, l→w/y, th→f/d/v, s/z lisped. Applied AFTER Azure scoring; if a word's only failing phonemes match, treat as passed and log `error_type = 'Developmental'`. Lives in `lib/leniency.ts` so it is easy to extend during kid testing.

### 9.4 Repeats and self-corrections
- Score each expected word by its BEST attempt in the passage.
- Ignore Insertion errors that repeat the previous 1-2 expected words.
- A self-correction that lands on the right word counts as correct (attempt = 2).

### 9.5 Reading ahead / skipping
Track the furthest matched word. Accept completion even if the path was messy. Never force a re-read of a word already passed.

### 9.6 Noise gating
In CHILD_READS, audio matching nothing in the reference text is not scored — not
an error, not an insertion that counts against them. It is not *ignored*: the
conversation layer has the same audio and decides separately whether it needs an
answer (§5). Strict scoring, flexible tutoring.

---

## 10. Edge-case playbook

| # | Situation | Handling |
|---|---|---|
| 1 | App hears its own TTS voice | Half-duplex gate (8.2) |
| 2 | Background noise, siblings, TV | Noise gating (9.6) |
| 3 | "Wabbit" and friends | Leniency table (9.3) |
| 4 | Stutters, repeats, self-corrections | Best-attempt scoring (9.4) |
| 5 | Kid reads ahead or skips | Furthest-match tracking (9.5) |
| 6 | Kid goes silent / walks away | 12s nudge, 30s check-in, 50s pause screen, measured from the last TURN (§4). A manual turn left open is closed after 90s — a backstop, not turn detection |
| 7 | Kid is frustrated or overwhelmed | ADAPT + choice offer; log `frustration` flag |
| 8 | "Just tell me the answer!" | After 2 Socratic pushbacks, tell them warmly |
| 9 | "I'm done" | Graceful END, story wrapped, zero guilt (§5) |
| 10 | Heavy question | Fixed template + parent flag, never improvised (§5) |
| 11 | Kid asks for Elsa / Pokemon | Original stand-in character (§7 rule 4) |
| 12 | Child starts talking and trails off | They still hold the floor. Nothing ends a turn but the child, or — on a reading turn the system opened — silence (§5) |
| 13 | Mic broken or permission denied | Mic check screen blocks session start (8.4) |

---

## 11. Pedagogy module (pure TS, no LLM)

- `updateMastery(events)`: correct read `p += 0.15 * (1 - p)`; error `p -= 0.2 * p`. `Developmental` counts as correct. Only `attempt = 1` results update mastery.
- `pickTargets(mastery)`: lowest-mastery skills whose prerequisites have p > 0.7, plus one review skill (high mastery, oldest last_practiced).
- Interest decay lives in consolidation: weights *= 0.9 per consolidation; interests mentioned get +0.3; chitchat from TALK mode is a strong interest signal.

---

## 12. Consolidation (the button)

`POST /api/consolidate`, in order:
1. Copy current `child_memory` to `child_memory_history`.
2. Run `updateMastery` over all new `reading_events` since last consolidation.
3. One Sonnet call: current memory + session transcript → updated `{interests, personality_notes, canon}`.
4. Write updated memory, bump version.
5. Run `pickTargets`, generate the next session plan, store it.
6. Return a diff (old vs new memory) for the debug panel. "Watch it learn her."

---

## 13. API surface

- `WS /session` — the live session (audio up; TTS audio + UI events down)
- `POST /api/consolidate`
- `GET /api/memory` — current child_memory + mastery
- `GET /api/plan` — next session plan
- `POST /api/child` — create/edit the demo child + onboarding notes

---

## 14. Build order

1. **Skeleton**: Next.js app, docker-compose.yml, schema migration, seed demo child, hardcoded session plan.
2. **Voice out**: streaming TTS plays a hardcoded beat in the browser, cancellable mid-sentence.
3. **Listening**: AudioWorklet capture, WS to server, Azure Pronunciation Assessment, per-word scores rendered live.
4. **Audio hardening**: mic check screen, echo test on a real laptop speaker+mic (no headphones), noise gating. Do not proceed until the app cannot hear itself.
5. **State machine**: NARRATE / CHILD_READS / COACH / ENCOURAGE with templated coach lines.
6. **TALK mode**: the mic button and its state machine (`lib/voice/machine.ts`), barge-in, streaming STT, Haiku intent router, `help_with_word`, `chitchat`, `want_to_stop`, sensitive-topic template. REMIX stubbed.
7. **Live narrator**: replace templates with the narrator agent, buffered beat generation, safety pass, real REMIX.
8. **SOCRATIC + ADAPT** + frustration path.
9. **Pedagogy + events**: reading_events writes, leniency table, best-attempt scoring, mastery math.
10. **Consolidate button** + memory diff view + next-plan generation.
11. **Demo polish**: story text on screen with current word highlighted, the owl-as-mic-button showing whose turn it is, memory panel on the side.

Testing note: put the app in front of a real 4-6 year old no later than step 5. Every assumption about kid behaviour in this file is provisional until then.

---

## 15. Out of scope (do not build)

Auth, multi-child, parent app, payments, mobile, nightly cron, custom ASR, agent frameworks, analytics, i18n, voice cloning, avatar animation.

### The mic button, and why it came back

This section used to end "Do not reintroduce a button". It was wrong, and the
reason it was wrong is worth keeping, because the argument against the button was
good and it still lost.

The case against was that a five-year-old would not reach for a control
mid-thought. True — and that is why the button is not the whole answer. The
system still opens and closes the mic for them during a reading turn, which is
where the objection actually applies: a child who has just been handed a passage
is not going to press anything first.

The case FOR is everything the always-on microphone had to guess. Had the child
started talking (VAD, plus two guard windows so the greeting did not kill
itself)? Had they finished (a settle window of 350ms to 3.8s, chosen by looking
at whether their last word was "and")? Was that our own voice coming back
(`looksLikeEcho`)? Did they MEAN to interrupt (`isInterruption`)? Every one of
those was a probabilistic answer to a question the child could have answered
exactly, and every one had a failure mode that felt, to them, like not being
listened to.

Deleting those guesses removed far more code than the button added, and it made
"the mic is open" and "Ollie is speaking" mutually exclusive by construction
rather than by three overlapping timers.

**Always-on listening is what is now out of scope.** Turn-taking goes through
`lib/voice/machine.ts` and nothing else opens the mic or cancels the voice.
