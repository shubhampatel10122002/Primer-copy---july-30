# Primer

A voice-based AI reading companion. The child reads a dynamically generated story
aloud; the narrator listens with pronunciation assessment, coaches stuck words,
answers questions Socratically, and adapts the story live. A **Consolidate**
button updates the child's memory model, which shapes the next session.

Turn-taking runs on an explicit mic button. The child taps the owl to talk and
taps again when they are done — and during a reading turn the system opens and
closes the mic for them, so the story never asks a five-year-old to press
anything to take their turn. One state machine
([`lib/voice/machine.ts`](./lib/voice/machine.ts)) owns all of it.

Full spec in [PLAN.md](./PLAN.md). Conventions in [CLAUDE.md](./CLAUDE.md).

## Setup

```bash
# 1. Credentials
cp .env.example .env.local        # then fill in the five keys

# 2. Database
docker compose up -d
npm install
npm run db:reset                  # migrate + seed the demo child

# 3. Verify everything is reachable
npm run smoke
```

`npm run smoke` checks Postgres, both Anthropic models, Azure Speech, and both
halves of OpenAI (the voice and the ears), and prints exactly which one is
failing. Get it fully green before running a session — a missing credential shows
up mid-story otherwise.

If voice or hearing misbehaves, run `npm run realtime:check`: it opens a real
transcription session, runs one complete turn through it exactly as the mic
button does, speaks a line, cancels one mid-sentence, and tells you which
transcription models this OpenAI project may actually use.

### `relation "children" does not exist`

The schema was never applied. `docker compose up -d` creates the `primer`
**database** automatically, so connecting succeeds even with zero tables — which
is why this looks like a connection problem but isn't. Fix:

```bash
npm run db:reset
```

`db:migrate` prints the database it is targeting and verifies all 9 tables exist
afterwards, so if it reports success against the wrong target you'll see it. Note
that an exported `DATABASE_URL` in your shell takes precedence over `.env.local`.

## Run

```bash
npm run dev     # Next.js on :3000 and the session WebSocket server on :3001
```

Open <http://localhost:3000>. You'll get the mic-check screen first ("say hi to
Ollie!"); the session cannot start until the microphone is verified.

**Test on laptop speakers, not headphones.** Echo used to be the thing most
likely to break a demo. It is now structurally impossible — the mic is closed
whenever Ollie is speaking, and a closed mic sends no audio at all — but speakers
are still how a child will use this, so it is still how it should be tested.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Next.js + WebSocket server together |
| `npm run smoke` | Verify every external dependency |
| `npm run realtime:check` | Prove the voice and the ears work on this machine |
| `npm run selftest` | Deterministic core — no network, no DB |
| `npm run db:reset` | Drop, migrate, re-seed |
| `npm run check` | TypeScript, no emit |
| `npm run build` | Production build |

`npm run selftest` covers the voice state machine, the tracker, the leniency
table, the mastery math and Azure config construction — 292 assertions, runs in
about a second, no network and no database. The machine's share proves the
transition table is total (every event defined in every state), that the mic and
the voice can never both be live, and that mid-sentence barge-in, the
manual-interruption override, auto-open, auto-close, rapid double taps and every
stale-message race resolve deterministically.

## Demo path

1. Mic check → "Start the story".
2. The narrator opens the story and hands over a passage; words light up green as
   they're read, amber when coaching kicks in.
3. When Ollie finishes a passage the mic opens by itself — just read. Stop, and
   it closes and scores you.
4. Tap the owl mid-sentence to interrupt him, say something, and tap again — try
   *"why is the dragon sad?"* (Socratic), *"I want trucks instead"* (remix), *"my
   dog is named Max"* (chitchat, becomes an interest signal). A turn you opened
   yourself is never closed by silence, so take as long as you like.
5. Hit **Consolidate memory** in the right-hand panel and watch the diff: interests
   re-weighted, personality notes revised from evidence, canon threads added, and
   a freshly generated plan for next time.

The right-hand panel is the demo. It shows the live floor state (who has it, who
opened the mic, whether silence may close it), live mode, the last Azure per-word
scores, the current plan, the memory model, parent flags, and the memory diff.
