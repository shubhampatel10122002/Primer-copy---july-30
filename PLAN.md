# Primer MVP: Build Plan

**For the coding agent: read this entire file before writing any code. Build in the order given in Section 14. Each step must end in something runnable and demoable. Do not skip ahead. Do not add features from Section 15 (out of scope).**

> **Credentials note:** the real API keys live in `.env.local`, which is gitignored.
> They are deliberately not reproduced in this file — it is committed.

## What we are building

A voice-based AI reading companion for one child, for a YC demo. The child reads a dynamically generated story aloud. The AI narrator listens with pronunciation assessment, coaches stuck words, encourages, answers questions Socratically, and adapts the story live.

**The child never presses anything.** The microphone is on for the whole session
and they can speak at any moment, including over the narrator, who stops
mid-word when they do. A "Consolidate" button updates the child's memory model,
which shapes the next session's plan — that is the only control on screen, and
it is for the founder, not the child.

Scope: single child, no auth, no payments, web app only, English only.

---

## 0. Human setup (the founder does this by hand, not the agent)

### 0.1 Azure Speech
1. portal.azure.com → create a free account.
2. "Create a resource" → **Speech** (under Azure AI services) → Create.
3. Resource group `primer-dev`, region `eastus`, pricing tier `F0` (free, 5 audio hours/month) or `S0`.
4. After deploy, open the resource → **Keys and Endpoint** → copy **KEY 1** and the **Region**.

### 0.2 OpenAI (voice, ears and turn detection)
1. platform.openai.com → **API keys** → create a key.
2. Put it in `.env.local` as `OPENAI_API_KEY`. Optionally set `OPENAI_REALTIME_VOICE`
   (alloy, ash, ballad, coral, echo, sage, shimmer, verse, cedar, marin).
3. Verify before anything else: `npm run realtime:check`.

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
| ONBOARDING | Session start with a blank profile (`lib/profile.ts`) | A short spoken conversation — name, then what they love. Mic opens between questions; no button. Writes the profile, then hands off with "I'm making a story just for you". Capped at 6 questions and 2 silences. |
| NARRATE | Session start, or child finished a passage | Narrator produces next story beat (2-3 spoken sentences) + the child's next passage (1-2 sentences). TTS speaks the beat. The mic stays open — the child can cut in at any point. |
| CHILD_READS | Narrator hands over | Mic streams to Azure Pronunciation Assessment with the passage as referenceText. Tracker follows word by word. |
| COACH | Word AccuracyScore < 60 (after leniency table, §9.3), or Omission, or pause > 3000ms on a word | Short coaching line ("Let's sound it out: b... l... ue"). Back to CHILD_READS on the same word. Max 2 coach attempts per word, then narrator says the word warmly and moves on. |
| ENCOURAGE | 2 consecutive passages with all words >= 80 accuracy | One short praise line naming something specific, then NARRATE. |
| TALK | The child says anything that is not the line on screen (`lib/conversation.ts`) — while reading, or over the narrator | Stop speaking if we were. Answer them, then resume or transition (§5). There is no button and no other way in. |
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
- Silence in CHILD_READS: 8s gentle prompt, 20s more a friendly check-in, 45s total pause the session with a resume screen. Never nag more than twice.
- All mode transitions are appended to the session transcript with timestamps.

---

## 5. TALK mode and the intent router

**There is no button.** The microphone is live from the moment the session opens
until it ends, and the child can say anything at any time, over anything.

Two layers listen to the same audio and never contend for it:

- **The conversation layer** (`ConversationEar`, `server/azure.ts`) is one plain
  recognizer, opened once at session start and never torn down. It hears
  everything, in every mode, including while the narrator is speaking.
- **The assessment layer** (`PronunciationSession`) is created per passage and
  answers exactly one question: how well were the words on screen said. It is
  strict, and it is never asked whether the child *meant* to read them.

Every complete utterance goes through `branchUtterance` (`lib/conversation.ts`),
which compares it to the line on screen and returns one of three things:

| Branch | Meaning | What happens |
|---|---|---|
| `reading` | It matches the line | Nothing. The assessment layer already scored it. |
| `conversation` | It does not | Answer it. |
| `mixed` | Both, in one breath | Score the reading; answer the aside. |

There is no fourth branch and none of the three is "ignore". An utterance that
reaches the branch always ends in a score, a reply, or both.

Interruption is decided on **partial** results, not final ones. A final arrives a
second or more after the child's first syllable, by which point the narrator has
usually finished the sentence — an interruption that lands after you would have
stopped anyway is not one. Two words that are not our own echo, or a single
unmistakable cue, and playback stops.

An utterance is not one recognizer result. Azure ends an utterance at every
pause and children pause constantly, so results are buffered into a *turn* and
only acted on after `REPLY_QUIET_MS` of real silence — longer when the last thing
they said trails off in a way that means they have not finished
(`soundsUnfinished`). This is what stops "I like cars, like Lamborghini... and
Bugatti" from being answered after the third word.

Flow once a turn closes as conversation:


1. If the narrator was speaking, it has already stopped — mid-word, at the first
   utterance that was not our own echo.
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
  "speak_text": "text the AI says aloud (sent to Cartesia)",
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

The rule is **"never score ourselves"**, not "never listen". Capture never stops
and the Realtime connection never stops hearing. What the gate still governs is
narrow and absolute: while audio is playing, and for 300ms after, no frame
reaches pronunciation assessment. Scoring a child against a line while our own
voice is in the room is the failure that rule exists to prevent.

Interruption is no longer inferred. The Realtime session runs server-side VAD on
the input and emits `input_audio_buffer.speech_started` within ~200ms of the
child's first syllable; the state machine cancels the in-flight response on that
event and tells the browser to drop its queued audio (`stop_playback`). Every
earlier design had to wait for a transcript, which arrives a second or more late
— long enough that the narrator had usually finished the sentence anyway, making
"stopping" indistinguishable from not stopping.

`getUserMedia` still runs with `echoCancellation: true`, and `looksLikeEcho`
remains as a backstop for a stray word that gets through at high volume.

### 8.3 Playback
Realtime audio (24kHz mono PCM16) is forwarded over the WebSocket and played via Web Audio with a small jitter buffer. While the child reads passage N, beat N+1 is already generated by the narrator.

### 8.4 Mic check onboarding
A 15-second "say hi to Ollie!" screen. Verifies mic permission, audio path, and volume, and gives the child one successful voice interaction before any reading. If mic fails, show parent-facing fix instructions. Never start a session with an unverified mic — with no button anywhere, a dead microphone is a dead session.

---

## 9. Azure integration details

### 9.1 Reading mode
Streaming, server-side SDK, per passage: `referenceText` = the passage,
`gradingSystem: HundredMark`, `granularity: Phoneme`, `enableMiscue: true`.
Parse per-word `Word`, `AccuracyScore`, `ErrorType`, `Phonemes[]`. Feed each result to the state machine and write to `reading_events`.

### 9.2 Conversation mode
A separate recognizer with no pronunciation config, opened once at session start
and never closed (`ConversationEar`). It runs alongside assessment on the same
audio rather than taking turns with it — the two used to alternate, and every
handover was a few hundred milliseconds during which the child was talking to
nothing.

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
| 6 | Kid goes silent / walks away | 8s nudge, 20s check-in, 45s pause screen (§4) |
| 7 | Kid is frustrated or overwhelmed | ADAPT + choice offer; log `frustration` flag |
| 8 | "Just tell me the answer!" | After 2 Socratic pushbacks, tell them warmly |
| 9 | "I'm done" | Graceful END, story wrapped, zero guilt (§5) |
| 10 | Heavy question | Fixed template + parent flag, never improvised (§5) |
| 11 | Kid asks for Elsa / Pokemon | Original stand-in character (§7 rule 4) |
| 12 | Child starts talking and trails off | Turn buffering: never settled until they are genuinely quiet (§5) |
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
2. **Voice out**: Cartesia streaming TTS plays a hardcoded beat in the browser. Half-duplex gate scaffolding.
3. **Listening**: AudioWorklet capture, WS to server, Azure Pronunciation Assessment, per-word scores rendered live.
4. **Audio hardening**: mic check screen, echo test on a real laptop speaker+mic (no headphones), noise gating. Do not proceed until the app cannot hear itself.
5. **State machine**: NARRATE / CHILD_READS / COACH / ENCOURAGE with templated coach lines.
6. **TALK mode**: the button, barge-in, plain STT, Haiku intent router, `help_with_word`, `chitchat`, `want_to_stop`, sensitive-topic template. REMIX stubbed.
7. **Live narrator**: replace templates with the narrator agent, buffered beat generation, safety pass, real REMIX.
8. **SOCRATIC + ADAPT** + frustration path.
9. **Pedagogy + events**: reading_events writes, leniency table, best-attempt scoring, mastery math.
10. **Consolidate button** + memory diff view + next-plan generation.
11. **Demo polish**: story text on screen with current word highlighted, a live "I'm listening" indicator where the button used to be, memory panel on the side.

Testing note: put the app in front of a real 4-6 year old no later than step 5. Every assumption about kid behaviour in this file is provisional until then.

---

## 15. Out of scope (do not build)

Auth, multi-child, parent app, payments, mobile, nightly cron, custom ASR, agent frameworks, analytics, i18n, voice cloning, avatar animation.

**The push-to-talk button is also gone**, and with it automatic off-script
detection as a *separate* feature. Both were answers to the same question — how
does a child get heard — and both were wrong. The button assumed a five-year-old
would reach for a control mid-thought; off-script detection assumed we could
guess from the assessment stream whether they meant to be reading. What replaced
them is neither: the microphone is simply always on, and every utterance is
compared to the line on screen and branched (§5). Do not reintroduce a button.
