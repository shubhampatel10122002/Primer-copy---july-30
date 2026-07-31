# Primer MVP: Build Plan

**For the coding agent: read this entire file before writing any code. Build in the order given in Section 14. Each step must end in something runnable and demoable. Do not skip ahead. Do not add features from Section 15 (out of scope).**

> **Credentials note:** the real API keys live in `.env.local`, which is gitignored.
> They are deliberately not reproduced in this file — it is committed.

## What we are building

A voice-based AI reading companion for one child, for a YC demo. The child reads a dynamically generated story aloud for ~15 minutes. The AI narrator listens with pronunciation assessment, coaches stuck words, encourages, answers questions Socratically, and adapts the story live. The child can tap a character button ("push to talk") to speak to the narrator at any time: ask questions, request a different story, or chat. A "Consolidate" button updates the child's memory model, which shapes the next session's plan.

Scope: single child, no auth, no payments, web app only, English only.

---

## 0. Human setup (the founder does this by hand, not the agent)

### 0.1 Azure Speech
1. portal.azure.com → create a free account.
2. "Create a resource" → **Speech** (under Azure AI services) → Create.
3. Resource group `primer-dev`, region `eastus`, pricing tier `F0` (free, 5 audio hours/month) or `S0`.
4. After deploy, open the resource → **Keys and Endpoint** → copy **KEY 1** and the **Region**.

### 0.2 Cartesia TTS
1. cartesia.ai → sign up.
2. **Voice Library** → audition voices → pick ONE warm friendly narrator voice → copy its **voice ID**.
3. **API Keys** → create a key.

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
CARTESIA_API_KEY=...
CARTESIA_VOICE_ID=...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/primer
```

### 0.6 MCP servers for Claude Code

```
claude mcp add --transport http microsoft-learn https://learn.microsoft.com/api/mcp
claude mcp add --transport http context7 https://mcp.context7.com/mcp
```

Microsoft Learn for Azure Speech SDK docs. Context7 for current Cartesia, Vercel AI SDK, and Drizzle docs. A Postgres MCP is not needed: use `psql` through the shell.

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
| Listening | Azure Speech SDK (`microsoft-cognitiveservices-speech-sdk`), two modes: Pronunciation Assessment (reading) and plain speech recognition (talking) |
| Voice out | Cartesia streaming TTS, one fixed voice ID |
| DB | PostgreSQL (Docker), raw SQL via `pg` |
| Agent frameworks | None. Plain TypeScript functions and a deterministic state machine |

Rule of the whole codebase: **deterministic code decides what happens; the LLM only decides what words to say.**

---

## 2. System components

1. **Session WebSocket server**: owns the live session. State machine, relays audio to Azure, streams Cartesia audio down, calls the narrator LLM. One concurrent session is fine.
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
| NARRATE | Session start, or child finished a passage | Narrator produces next story beat (2-3 spoken sentences) + the child's next passage (1-2 sentences). TTS speaks the beat. Mic is muted during playback. |
| CHILD_READS | Narrator hands over | Mic streams to Azure Pronunciation Assessment with the passage as referenceText. Tracker follows word by word. |
| COACH | Word AccuracyScore < 60 (after leniency table, §9.3), or Omission, or pause > 3000ms on a word | Short coaching line ("Let's sound it out: b... l... ue"). Back to CHILD_READS on the same word. Max 2 coach attempts per word, then narrator says the word warmly and moves on. |
| ENCOURAGE | 2 consecutive passages with all words >= 80 accuracy | One short praise line naming something specific, then NARRATE. |
| TALK | Child taps the talk button, **or speaks off-script while reading** (`lib/offscript.ts`) | Pause current mode. Transcribe, classify intent (§5), route. Then resume or transition. Both entry points share one path, so speaking up never needs a button. |
| SOCRATIC | TALK intent = question_about_story_or_world | Narrator responds with ONE guiding question. Max 3 guiding questions, then a strong hint, then let the child conclude. Weave back to the story in one sentence, then NARRATE. |
| REMIX | TALK intent = change_request ("I want dragons") | Discard the buffered next beat. Narrator acknowledges enthusiastically and regenerates the next beat + passage with the new theme but the SAME difficulty, SAME target skills, SAME must_use words. |
| ADAPT | 3+ COACH entries within one passage, or frustration detected | Difficulty down one level. Discard buffered beat. Regenerate next passage, shorter and simpler. |
| WRAP_UP | ~6 passages or 10 min (then ~4 / 6 min), or the beat list runs out (`lib/sessionflow.ts`) | Celebrate, name the words they were stuck on and then got right, and ask whether to keep reading. Answered by voice or by tapping. Yes extends the same story (same premise, difficulty, skills, must-use words); no or silence goes to END. |
| END | Child wants to stop, no answer at a check-in, or 30 min hard stop | Closing line referencing something specific the child did. Wraps the story in one beat. Saves the transcript and folds today's facts into memory. |

Cross-cutting rules:
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

There are three ways in and they all end up in the same place
(`handleChildSpeech`). The talk button (an owl, large and always visible) is the
explicit one, and by now the least important. The other two need no button:

- **Speaking up mid-passage.** Every utterance Azure returns during CHILD_READS
  is checked by `lib/offscript.ts`; one that barely overlaps the passage is
  conversation, not a misread.
- **Talking over the narrator.** A second recognizer runs during playback (§8.2).
  Speech that is not our own echo cuts the story off and gets answered.

That check is deliberately conservative, because the two failure modes are not
symmetric. Interrupting a child who was reading is expensive; missing a comment
just means they can still tap the owl. So it takes a full sentence with almost no
overlap, or a short utterance carrying an unmistakable cue that the passage does
not contain.

Flow when tapped (or when off-script speech is detected):
1. Immediately stop any TTS playback and stop pronunciation assessment.
2. Start plain Azure speech recognition.
3. No intelligible speech within 5s: playful nudge, return to the previous mode at the same word.
4. On transcript: one Haiku call classifies intent into exactly one of the
   following, and — separately, in any intent — extracts anything the child
   revealed about their own life into the fact ledger (`lib/facts.ts`):
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

The rule is **"never listen to ourselves"**, not "never listen". While Cartesia
audio is playing:

- Mic frames reach the barge-in recognizer and **nothing else**. Pronunciation
  assessment and conversational listens receive nothing until we have stopped
  talking — that part is absolute.
- Everything the barge-in recognizer hears is checked against the exact words
  being spoken (`isInterruption` in `lib/offscript.ts`). Anything that
  substantially *is* those words is echo and is dropped.
- Once playback ends, the client keeps capture paused until its own audio queue
  has drained plus 300ms (the speaker tail). `tts_end` fires when the server
  finishes *sending*, which is well before the browser finishes *playing*.

Going fully deaf during narration was the original design and it was wrong: a
child who speaks up while the story is being told was heard by nothing at all,
and a five-year-old neither waits for a turn nor reaches for a button. Accepting
a real interruption kills playback instantly — including flushing the browser's
queued audio, or the narrator keeps talking over the child who just interrupted.

The talk button does the same thing explicitly, and is now a fallback rather than
the only way in.

### 8.3 Playback
Cartesia streaming output is forwarded over the WebSocket and played via Web Audio with a small jitter buffer. Target: first audible audio < 1s. While the child reads passage N, beat N+1 is already generated.

### 8.4 Mic check onboarding
A 15-second "say hi to Ollie!" screen. Verifies mic permission, audio path, and volume, and gives the child one successful voice interaction before any reading. If mic fails, show parent-facing fix instructions. Never start a session with an unverified mic.

---

## 9. Azure integration details

### 9.1 Reading mode
Streaming, server-side SDK, per passage: `referenceText` = the passage,
`gradingSystem: HundredMark`, `granularity: Phoneme`, `enableMiscue: true`.
Parse per-word `Word`, `AccuracyScore`, `ErrorType`, `Phonemes[]`. Feed each result to the state machine and write to `reading_events`.

### 9.2 Talk mode
A separate recognizer with no pronunciation config. Only ever active while the talk button session is open.

### 9.3 Leniency table (developmental speech)
Ages 4-6 routinely substitute phonemes. These are NOT reading errors: r→w, l→w/y, th→f/d/v, s/z lisped. Applied AFTER Azure scoring; if a word's only failing phonemes match, treat as passed and log `error_type = 'Developmental'`. Lives in `lib/leniency.ts` so it is easy to extend during kid testing.

### 9.4 Repeats and self-corrections
- Score each expected word by its BEST attempt in the passage.
- Ignore Insertion errors that repeat the previous 1-2 expected words.
- A self-correction that lands on the right word counts as correct (attempt = 2).

### 9.5 Reading ahead / skipping
Track the furthest matched word. Accept completion even if the path was messy. Never force a re-read of a word already passed.

### 9.6 Noise gating
In CHILD_READS, audio matching nothing in the reference text is ignored — not an error, not an interruption. Only the talk button interrupts.

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
| 12 | Talk button tapped, then silence | 5s timeout, playful nudge, resume (§5) |
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
11. **Demo polish**: story text on screen with current word highlighted, big friendly talk button, memory panel on the side.

Testing note: put the app in front of a real 4-6 year old no later than step 5. Every assumption about kid behaviour in this file is provisional until then.

---

## 15. Out of scope (do not build)

Auth, multi-child, parent app, payments, mobile, nightly cron, custom ASR, agent frameworks, analytics, i18n, voice cloning, avatar animation.

Automatic off-script detection **used to be on this list** — the talk button was
meant to replace it. That was wrong: a child who says "I'm bored" mid-passage and
gets no reply has learned the thing does not listen, and a 5-year-old will not
reach for a button to be heard. It is now §5, built to fail towards "that was
reading" so the reading flow is never interrupted on a guess.
