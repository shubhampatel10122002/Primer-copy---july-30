import type { WebSocket } from 'ws';
import { AUDIO } from '../lib/env';
import { query, one } from '../lib/db';
import { Narrator, type NarratorMode, type NarratorTurn } from '../lib/llm/narrator';
import { classifyIntent } from '../lib/llm/intent';
import { generateSessionPlan, fallbackPlan, extendPlanBeats } from '../lib/llm/planner';
import { generateAcknowledgment } from '../lib/llm/acknowledge';
import { OnboardingAgent } from '../lib/llm/onboarding';
import { pickTargets } from '../lib/pedagogy';
import { pickPraiseWord } from '../lib/praise';
import { detectOffScript, isInterruption } from '../lib/offscript';
import { FactLedger, mergeFactsIntoMemory, type FactKind } from '../lib/facts';
import {
  shouldCheckIn,
  summarizeProgress,
  parseYesNo,
  HARD_STOP_MS,
} from '../lib/sessionflow';
import {
  emptyDraft,
  mergeDraft,
  hasEnoughToStart,
  canStartAtAll,
  isFreshProfile,
  draftToNotes,
  draftToInterests,
  repeatsPrevious,
  type OnboardingDraft,
} from '../lib/profile';
import * as T from '../lib/templates';
import { PronunciationSession, TalkRecognizer } from './azure';
import { tts, type SpeakHandle } from './cartesia';
import { PassageTracker, tokenize } from './tracker';
import type {
  Child,
  ChildMemory,
  ClientMessage,
  Intent,
  Mastery,
  Mode,
  ServerMessage,
  SessionPlan,
  TrackedWord,
  TranscriptEntry,
} from '../lib/types';

/** How long a stretch of reading runs before the narrator offers a natural stop. */
const SESSION_SOFT_MAX_MS = 15 * 60 * 1000;
const SILENCE_NUDGE_MS = 8_000;
const SILENCE_CHECKIN_MS = 28_000;
const SILENCE_PAUSE_MS = 45_000;
const WORD_STUCK_MS = 3_000;
const TALK_TIMEOUT_MS = 5_000;
const MAX_COACH_ATTEMPTS = 2;
const ADAPT_COACH_THRESHOLD = 3;
const MAX_SOCRATIC_QUESTIONS = 3;

/**
 * How long to wait for a child to START answering. Generous on purpose: this
 * only runs out when they say nothing at all, and waiting on a shy four-year-old
 * is much better than talking over them.
 */
const ONBOARDING_LISTEN_MS = 12_000;
const MAX_ONBOARDING_TURNS = 6;
/** How long to wait for "yes, keep going" before asking again. */
const ANSWER_LISTEN_MS = 10_000;

/**
 * How long the child must be quiet before we treat their answer as finished.
 *
 * This is the single most important number in the conversation. Too short and
 * we interrupt them between two thoughts — which is exactly what a child
 * experiences as not being listened to. Two and a half seconds is longer than
 * the pause inside a list ("Lamborghini... Bugatti") and shorter than a silence
 * that means "your turn".
 */
const REPLY_QUIET_MS = 2_500;

/** Backstop for a recognizer that never reports silence. Never hit by talking. */
const REPLY_CEILING_MS = 45_000;

export class Session {
  private mode: Mode = 'IDLE';
  private sessionId: string | null = null;
  private narrator!: Narrator;
  private plan!: SessionPlan;

  private tracker: PassageTracker | null = null;
  private pron: PronunciationSession | null = null;
  private talk: TalkRecognizer | null = null;

  private speaking: SpeakHandle | null = null;
  private gateOpenAt = 0; // mic frames before this timestamp are dropped
  private isSpeaking = false;
  /** What we are saying right now — the echo guard needs the exact words. */
  private speakingText = '';
  private bargeIn: TalkRecognizer | null = null;
  private bargeInHandled = false;
  /**
   * Bumped whenever playback is cut short. Utterances queued behind the one that
   * was interrupted check this and drop themselves — otherwise the narrator
   * answers the child and then carries on with the sentence they interrupted.
   */
  private speechGeneration = 0;
  /** Something the child said with nothing yet waiting to receive it. */
  private pendingSpeech: string | null = null;
  /** Tail of the utterance queue — see speak(). */
  private speechChain: Promise<void> = Promise.resolve();

  private transcript: TranscriptEntry[] = [];
  private interestSignals: string[] = [];
  private pendingEvents: any[] = [];

  /** Everything the child has volunteered today, and when the story may use it. */
  private facts = new FactLedger();
  private draft: OnboardingDraft = emptyDraft();

  private coachAttempts = new Map<number, number>();
  private celebrated = new Set<number>();
  private coachEventsThisPassage = 0;
  private strongPassages = 0;
  private socraticCount = 0;
  private beatIndex = 0;

  private bufferedTurn: Promise<NarratorTurn> | null = null;
  private bufferToken = 0;
  /** The fact spoken for in the buffered beat — released if that beat is dropped. */
  private bufferedFactId: number | null = null;

  /** Passages read so far, for the progress summary at a check-in. */
  private passageRecords: TrackedWord[][] = [];
  private passagesSinceCheckIn = 0;
  private lastCheckInAt = Date.now();
  private checkIns = 0;

  /** Resolvers for an open conversational listen and an on-screen yes/no tap. */
  private endListen: ((text: string | null) => void) | null = null;
  private answerFromUi: ((value: 'yes' | 'no') => void) | null = null;
  private stashedAnswer: 'yes' | 'no' | null = null;

  private lastSpeechAt = Date.now();
  private nudgeStage = 0;
  private tick: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
  private talkTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private ws: WebSocket,
    private child: Child,
    private memory: ChildMemory,
    private mastery: Mastery[],
  ) {}

  // -------------------------------------------------------------------------
  // Wire helpers
  // -------------------------------------------------------------------------

  private send(msg: ServerMessage) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(msg));
  }

  private sendAudio(pcm: Buffer) {
    if (this.ws.readyState !== 1) return;
    this.ws.send(pcm, { binary: true });
  }

  private log(kind: TranscriptEntry['kind'], text: string, meta?: Record<string, unknown>) {
    this.transcript.push({ ts: new Date().toISOString(), kind, text, meta });
  }

  private setMode(mode: Mode, reason?: string) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.log('mode', mode, reason ? { reason } : undefined);
    this.send({ t: 'mode', mode, reason });
  }

  private debug(key: string, value: unknown) {
    this.send({ t: 'debug', key, value });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start() {
    this.tick = setInterval(() => this.onTick(), 500);

    // A child with no profile is met, not greeted: we cannot personalise a story
    // for someone we know nothing about, and planning before onboarding would
    // produce a story about a stranger.
    const fresh = isFreshProfile(this.child, this.memory);

    // Exactly ONE line covers the gap before the story: a template greeting for a
    // child we know, or onboarding's hand-off line for one we just met. Speaking
    // both is how a child hears "I'm making you a story" twice in a row and stops
    // believing there is one person there.
    let handoff: string;
    if (fresh) {
      handoff = await this.runOnboarding();
      if (this.closed) return;
    } else {
      handoff = T.openingLine(this.child.name);
    }

    // Speak it FIRST, with no LLM in the way. Planning plus the opening narrator
    // turn is several seconds of round-trips; a child staring at a silent screen
    // for that long assumes it is broken. This also means the very first thing
    // that happens in a session exercises the whole audio path.
    this.setMode('NARRATE', fresh ? 'making their story' : 'greeting');
    const greeting = this.speak(handoff);

    // Resolve the plan while the greeting is playing.
    const planning = (async (): Promise<SessionPlan> => {
      // A stored plan was written for the profile that existed before onboarding;
      // a brand-new child gets a fresh one.
      const stored = fresh
        ? null
        : await one<{ plan: SessionPlan }>('SELECT plan FROM next_plans WHERE child_id = $1', [
            this.child.id,
          ]);
      if (stored?.plan) return stored.plan;

      const targets = pickTargets(this.mastery);
      try {
        return await generateSessionPlan({
          child: this.child,
          memory: this.memory,
          mastery: this.mastery,
          targetSkills: targets,
        });
      } catch (err) {
        // One retry before giving up. A planner failure means the child gets a
        // template story instead of theirs, which is the worst outcome here.
        console.error('[session] planner failed, retrying once', err);
        try {
          return await generateSessionPlan({
            child: this.child,
            memory: this.memory,
            mastery: this.mastery,
            targetSkills: targets,
          });
        } catch (retryErr) {
          console.error('[session] planner failed twice, using fallback', retryErr);
          return fallbackPlan(this.child, targets, this.memory);
        }
      }
    })();

    const [, plan] = await Promise.all([greeting, planning]);
    if (this.closed) return;
    this.plan = plan;

    const row = await one<{ id: string }>(
      'INSERT INTO sessions (child_id, plan) VALUES ($1, $2) RETURNING id',
      [this.child.id, JSON.stringify(this.plan)],
    );
    this.sessionId = row!.id;

    this.narrator = new Narrator(this.child, this.memory, this.plan);

    this.send({ t: 'ready', childName: this.child.name, plan: this.plan });
    this.debug('plan', this.plan);

    await this.narrate(
      'OPENING',
      `${this.child.name} has already been greeted out loud, so do not greet them again. Go straight into beat 0 of the story.`,
    );
  }

  // -------------------------------------------------------------------------
  // ONBOARDING (a child we have never met)
  // -------------------------------------------------------------------------

  /**
   * Learn enough about a new child to make them a story.
   *
   * The loop is the authority, not the agent: it caps how many questions a child
   * can be asked, it decides when there is enough to start (lib/profile.ts), and
   * it stops asking someone who has gone quiet. The agent only picks the words.
   *
   * Returns the hand-off line, spoken by the caller so that the story can be
   * planned while it plays.
   */
  private async runOnboarding(): Promise<string> {
    this.setMode('ONBOARDING', 'no profile yet');
    const agent = new OnboardingAgent();

    // Something friendly before the first round-trip, for the same reason the
    // returning-child greeting is templated: silence at the start reads as broken.
    await this.speak(T.helloStrangerLine());

    let heard: string | null = null;
    let silences = 0;
    let lastSaid: string = T.helloStrangerLine();

    for (let turn = 0; turn < MAX_ONBOARDING_TURNS; turn++) {
      const reply = await agent.turn(heard, this.draft);
      if (this.closed) return '';

      this.draft = mergeDraft(this.draft, reply.learned);
      this.send({
        t: 'profile',
        name: this.draft.name,
        age: this.draft.age,
        interests: this.draft.interests,
      });
      this.debug('onboardingDraft', this.draft);

      // Saying the same thing twice is how one voice starts sounding like two
      // different people talking past each other. Checked here because it is
      // checkable, and because the first thing a child ever hears is the worst
      // possible place for it.
      let line = reply.speak;
      if (repeatsPrevious(line, lastSaid)) {
        console.warn(`[onboarding] dropped a repeat of "${lastSaid.slice(0, 40)}…"`);
        line = this.draft.name
          ? `What do you love most, ${this.draft.name}?`
          : `What should I call you?`;
      }

      await this.speak(line);
      lastSaid = line;
      if (this.closed) return '';

      // The agent may say it is ready; whether it actually is, is decided here.
      // One follow-up minimum, so nobody is hustled from "I'm Sam" to a story.
      if (hasEnoughToStart(this.draft) && (reply.ready || turn >= 1)) break;

      heard = await this.listen(ONBOARDING_LISTEN_MS);
      if (heard) {
        this.log('child_talk', heard);
        silences = 0;
      } else if (++silences >= 2 && canStartAtAll(this.draft)) {
        // Twice with no answer. Start with what we have rather than interviewing
        // an empty room — a story is a better invitation than another question.
        break;
      }
    }

    const finale = await agent.finale(this.draft);
    await this.persistOnboarding();

    // Returned rather than spoken: the caller says it while the story is being
    // planned, so the child is not waiting through two lines and then silence.
    return repeatsPrevious(finale, lastSaid) ? T.makingStoryLine(this.draft.name) : finale;
  }

  /**
   * Write the new profile before the story is planned, since the planner reads
   * it. In-memory first: a failed write should cost the next session, not this one.
   */
  private async persistOnboarding() {
    const notes = draftToNotes(this.draft);
    const personality = this.draft.notes.join(' ');
    const interests = draftToInterests(this.draft);

    this.child = {
      ...this.child,
      // Without a name every template line reads "Hi !". "friend" is also a
      // placeholder (lib/profile.ts), so a child who never told us their name is
      // asked again next time rather than being stuck as "friend" forever.
      name: this.draft.name ?? (this.child.name?.trim() || 'friend'),
      age: this.draft.age ?? this.child.age,
      onboarding_notes: notes || this.child.onboarding_notes,
    };
    this.memory = {
      ...this.memory,
      interests: interests.length ? interests : this.memory.interests,
      personality_notes: personality || this.memory.personality_notes,
    };

    try {
      await query(
        `UPDATE children SET name = COALESCE($2, name), age = COALESCE($3, age), onboarding_notes = $4
         WHERE id = $1`,
        [this.child.id, this.draft.name, this.draft.age, notes || null],
      );
      await query(
        `INSERT INTO child_memory (child_id, interests, personality_notes, canon)
         VALUES ($1, $2, $3, '{}')
         ON CONFLICT (child_id) DO UPDATE
           SET interests = EXCLUDED.interests,
               personality_notes = EXCLUDED.personality_notes,
               version = child_memory.version + 1,
               updated_at = now()`,
        [this.child.id, JSON.stringify(this.memory.interests), this.memory.personality_notes],
      );
      // Any stored plan was written for the profile that just got replaced.
      await query('DELETE FROM next_plans WHERE child_id = $1', [this.child.id]);
    } catch (err) {
      console.error('[session] failed to save the onboarding profile', err);
    }
  }

  // -------------------------------------------------------------------------
  // Conversational listening (no button)
  // -------------------------------------------------------------------------

  /**
   * Open the mic for a spoken reply and wait until the child is actually done.
   *
   * The counterpart to the talk button: when the narrator asks a direct question
   * — during onboarding, or at a check-in — the child should just answer, not go
   * looking for a control.
   *
   * The hard part is knowing when they have finished. Azure ends an utterance at
   * every pause, and a five-year-old listing their favourite cars pauses between
   * every one of them. Taking the first segment as the answer is how "I like
   * cars, like Lamborghini... and Bugatti" turns into being cut off mid-sentence.
   * So segments are collected and we only settle after the child has been quiet
   * for REPLY_QUIET_MS, with the wait restarting every time they start again.
   *
   * Resolves null if nothing intelligible arrives at all.
   */
  private listen(waitForStartMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(null);
        return;
      }

      // They already answered — over the top of the question. Do not make a child
      // who spoke first say it again.
      if (this.pendingSpeech) {
        const early = this.pendingSpeech;
        this.pendingSpeech = null;
        resolve(early);
        return;
      }

      const heard: string[] = [];
      let startTimer: NodeJS.Timeout;
      let quietTimer: NodeJS.Timeout | null = null;
      let ceiling: NodeJS.Timeout;
      let settled = false;

      const finish = (text: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        clearTimeout(ceiling);
        if (quietTimer) clearTimeout(quietTimer);
        this.endListen = null;
        const recognizer = this.talk;
        this.talk = null;
        void recognizer?.close();
        this.send({ t: 'listening', on: false });
        resolve(text);
      };

      const settleWithWhatWeHeard = () =>
        finish(heard.length ? heard.join(' ').replace(/\s+/g, ' ').trim() : null);

      this.endListen = () => settleWithWhatWeHeard();
      this.send({ t: 'listening', on: true });

      this.talk = new TalkRecognizer({
        continuous: true,
        onPartial: (text) => {
          this.debug('talkPartial', text);
          // Still going. Cancel any pending "they have finished" decision, and
          // stop the no-answer timer — they are answering, just slowly.
          if (quietTimer) {
            clearTimeout(quietTimer);
            quietTimer = null;
          }
          clearTimeout(startTimer);
        },
        onFinal: (text) => {
          heard.push(text);
          this.debug('listenSegments', heard);
          clearTimeout(startTimer);
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(settleWithWhatWeHeard, REPLY_QUIET_MS);
        },
        onError: (m) => console.error('[azure listen]', m),
      });

      // Do not start the clock until the mic is actually open. The half-duplex
      // gate is still shut for the tail of the question we just asked, and a
      // window that expires while the child is still being spoken to reads to
      // them as being ignored — the exact thing this is here to prevent.
      const gateDelay = Math.max(0, this.gateOpenAt - Date.now());
      startTimer = setTimeout(() => finish(null), gateDelay + waitForStartMs);

      // Only a backstop against a recognizer that never reports silence. Long
      // enough that no child reaches it by talking.
      ceiling = setTimeout(settleWithWhatWeHeard, gateDelay + waitForStartMs + REPLY_CEILING_MS);
    });
  }

  private stopListening() {
    this.endListen?.(null);
  }

  async handleMessage(msg: ClientMessage) {
    switch (msg.t) {
      case 'start':
        if (this.mode === 'IDLE') await this.start();
        break;
      case 'answer':
        // Tapped rather than spoken. Stash it if nothing is waiting yet, so a
        // fast tap during the question is not thrown away.
        if (this.answerFromUi) this.answerFromUi(msg.value);
        else this.stashedAnswer = msg.value;
        break;
      case 'talk_start':
        await this.openTalk();
        break;
      case 'talk_end':
        await this.closeTalk();
        break;
      case 'resume':
        if (this.mode === 'PAUSED') {
          this.lastSpeechAt = Date.now();
          this.nudgeStage = 0;
          this.setMode('CHILD_READS', 'resumed');
        }
        break;
      case 'stop':
        await this.end('child asked to stop');
        break;
      case 'tts_test':
        // Exercises the real audio path — Cartesia -> WebSocket -> Web Audio —
        // with no LLM involved, so "can I hear anything at all?" is one click.
        await this.speak(
          "Hello! This is Ollie testing the sound. If you can hear me, the audio is working.",
        );
        break;
      case 'ping':
        break;
    }
  }

  /** Mic frames from the browser. The server-side gate is authoritative. §8.2 */
  onAudio(pcm: Buffer) {
    if (this.closed) return;

    // While we are speaking, the ONLY thing listening is the barge-in recognizer,
    // and everything it hears is echo-checked before it counts. Nothing reaches
    // pronunciation assessment or a conversational listen until we have stopped —
    // that part of the half-duplex rule (§8.2) still holds absolutely.
    if (this.isSpeaking) {
      this.bargeIn?.write(pcm);
      return;
    }

    if (Date.now() < this.gateOpenAt) return; // swallow the speaker tail

    // An open conversational recognizer wins: onboarding and check-ins listen
    // outside TALK mode.
    if (this.talk) {
      this.talk.write(pcm);
      return;
    }
    if (this.mode === 'CHILD_READS' || this.mode === 'COACH') {
      this.pron?.write(pcm);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    if (this.talkTimer) clearTimeout(this.talkTimer);
    // Anything awaiting a reply must not hang once the socket is gone.
    this.endListen?.(null);
    this.speaking?.cancel();
    await Promise.all([this.pron?.close(), this.talk?.close(), this.bargeIn?.close()]);
  }

  // -------------------------------------------------------------------------
  // Speaking (half-duplex)
  // -------------------------------------------------------------------------

  /**
   * Serialise speech. Two utterances must never overlap: the narrator would talk
   * over itself, and Cartesia's free tier caps concurrent contexts at 2 — which
   * is exactly the "concurrency limit of 2" error a nudge firing mid-utterance
   * (or a Test-sound click during a story beat) produces.
   */
  private async speak(text: string): Promise<void> {
    const previous = this.speechChain;
    const generation = this.speechGeneration;
    let release!: () => void;
    this.speechChain = new Promise<void>((r) => (release = r));
    try {
      await previous;
      // The child interrupted while this was waiting its turn. It was written
      // for a moment that has passed — saying it now would be talking over the
      // answer they just got.
      if (generation !== this.speechGeneration) return;
      await this.speakNow(text);
    } finally {
      release();
    }
  }

  private async speakNow(text: string): Promise<void> {
    if (!text.trim() || this.closed) return;

    this.isSpeaking = true;
    this.speakingText = text;
    this.gateOpenAt = Number.MAX_SAFE_INTEGER; // close the gate for the whole utterance
    this.send({ t: 'tts_start', bargeIn: true });
    this.send({ t: 'speak', text });
    this.log('narrator', text);

    this.openBargeIn(text);

    // Count what actually leaves the server. When a founder reports "I can't hear
    // anything", this line is the difference between a server-side and a
    // browser-side problem — and it costs one integer.
    let bytes = 0;
    const started = Date.now();
    let firstChunkMs = -1;

    const handle = tts().speak(text, (chunk) => {
      if (firstChunkMs < 0) firstChunkMs = Date.now() - started;
      bytes += chunk.length;
      this.sendAudio(chunk);
    });
    this.speaking = handle;

    try {
      await handle.done;
      const seconds = bytes / 4 / AUDIO.ttsSampleRate;
      if (bytes === 0) {
        console.error(
          `[tts] produced NO audio for "${text.slice(0, 50)}…" — check CARTESIA_API_KEY, CARTESIA_VOICE_ID and CARTESIA_MODEL`,
        );
      } else {
        console.log(
          `[tts] ${bytes} bytes (~${seconds.toFixed(2)}s audio), first chunk in ${firstChunkMs}ms`,
        );
      }
      this.debug('lastTts', { bytes, seconds: Number(seconds.toFixed(2)), firstChunkMs });
    } finally {
      this.speaking = null;
      this.isSpeaking = false;
      this.speakingText = '';
      void this.closeBargeIn();
      // Keep the gate shut for the audio tail so we don't hear our own voice.
      this.gateOpenAt = Date.now() + AUDIO.gateTailMs;
      this.send({ t: 'tts_end' });
      this.lastSpeechAt = Date.now();
    }
  }

  /**
   * Listen over our own voice.
   *
   * PLAN.md §8.2 shut the mic for the whole of every utterance, which is correct
   * for echo and wrong for children: a child who says "I'm bored" while the
   * story is being told is, with the gate shut, talking to nothing. They do not
   * know to wait for a turn, and the owl button is not a thing a five-year-old
   * reaches for mid-thought.
   *
   * So a second recognizer runs during playback. Everything it hears is checked
   * against the exact words being spoken (`isInterruption`), and only speech
   * that clearly is not our own echo counts. When it does count, this is a real
   * barge-in: playback is killed on the spot and the child gets an answer.
   */
  private openBargeIn(spokenText: string) {
    if (this.mode === 'IDLE' || this.closed) return;

    void this.closeBargeIn();
    this.bargeIn = new TalkRecognizer({
      continuous: true,
      onFinal: (heard) => {
        if (!this.isSpeaking || this.bargeInHandled) return;
        if (!isInterruption(heard, spokenText)) {
          this.debug('bargeInIgnored', heard);
          return;
        }
        this.bargeInHandled = true;
        this.debug('bargeIn', heard);
        console.log(`[barge-in] "${heard}" over "${spokenText.slice(0, 40)}…"`);
        void this.onBargeIn(heard);
      },
      onError: (m) => console.error('[azure barge-in]', m),
    });
  }

  private async closeBargeIn() {
    const recognizer = this.bargeIn;
    this.bargeIn = null;
    this.bargeInHandled = false;
    await recognizer?.close();
  }

  /** The child talked over the story. Stop talking and deal with what they said. */
  private async onBargeIn(transcript: string) {
    // Cut the narrator off mid-word. Being talked over by a machine that will not
    // stop is the whole reason a child gives up on talking to it.
    this.stopSpeaking();
    await this.closeBargeIn();

    if (this.closed || this.mode === 'END') return;

    if (this.mode === 'ONBOARDING') {
      // Mid-onboarding, the interruption IS the answer to the question we were
      // asking, so hand it to the loop rather than routing it as an intent. If
      // the loop has not started listening yet — they cut in before we finished
      // the question — it is held so the next listen picks it up instead of
      // making them repeat themselves.
      if (this.endListen) this.endListen(transcript);
      else this.pendingSpeech = transcript;
      return;
    }

    if (!this.plan || !this.narrator) return;

    await this.handleChildSpeech(transcript, 'barge_in');
  }

  /** Barge-in: kill playback instantly and reopen the mic. */
  private stopSpeaking() {
    if (this.speaking) {
      this.speaking.cancel();
      this.speaking = null;
    }
    this.isSpeaking = false;
    this.speakingText = '';
    this.gateOpenAt = 0;
    this.speechGeneration += 1; // anything queued behind this is now stale
    // Cancelling Cartesia stops us SENDING audio; the browser is still holding a
    // second or two of it. Without this the narrator carries on talking over the
    // child who just interrupted, which is worse than not letting them interrupt.
    this.send({ t: 'stop_playback' });
    this.send({ t: 'tts_end' });
  }

  // -------------------------------------------------------------------------
  // NARRATE
  // -------------------------------------------------------------------------

  private async narrate(
    mode: NarratorMode,
    context: string,
    opts: {
      prefetched?: NarratorTurn;
      mustMention?: string | null;
      mustMentionAny?: string[];
      speakPrefix?: string | null;
      weave?: string | null;
      /** 'auto' continues the session; 'hold' hands control back to the caller. */
      after?: 'auto' | 'hold';
    } = {},
  ) {
    this.setMode('NARRATE');
    const turn =
      opts.prefetched ??
      (await this.narrator.turn(mode, context, {
        mustMention: opts.mustMention,
        mustMentionAny: opts.mustMentionAny,
        weave: opts.weave,
      }));

    // Prepend rather than speak separately: one Cartesia context instead of two
    // (the free tier allows 2 concurrent), and it reads as a single natural
    // utterance rather than two clips butted together.
    if (opts.speakPrefix) turn.speak_text = `${opts.speakPrefix} ${turn.speak_text}`;
    this.beatIndex = turn.current_beat_index ?? this.beatIndex;
    this.debug('lastNarratorTurn', { mode, ...turn });

    await this.speak(turn.speak_text);

    // The caller is running a conversation (a check-in) and decides what happens
    // next itself.
    if (opts.after === 'hold') return;

    if (turn.child_passage && turn.child_passage.trim()) {
      await this.startPassage(turn.child_passage.trim());
    } else if (mode === 'CLOSING') {
      await this.finishEnd();
    } else {
      // A conversational turn with no passage — go back to whatever they were reading.
      if (this.tracker && !this.tracker.isComplete()) {
        this.setMode('CHILD_READS', 'resuming passage');
        this.lastSpeechAt = Date.now();
      } else {
        await this.nextBeat();
      }
    }
  }

  private async startPassage(passage: string) {
    await this.pron?.close();
    this.pron = null;

    this.tracker = new PassageTracker(passage);
    this.coachAttempts.clear();
    this.celebrated.clear();
    this.coachEventsThisPassage = 0;
    this.nudgeStage = 0;
    this.lastSpeechAt = Date.now();

    this.log('child_passage', passage);
    this.send({ t: 'passage', text: passage, words: tokenize(passage) });
    this.send({ t: 'cursor', index: 0 });

    this.pron = new PronunciationSession(passage, {
      onPartial: (text) => {
        this.lastSpeechAt = Date.now();
        this.nudgeStage = 0;
        this.debug('azurePartial', text);
      },
      onWords: (words, recognized) => {
        void this.onWords(words, recognized);
      },
      onError: (m) => {
        console.error('[azure]', m);
        this.send({ t: 'error', message: m });
      },
    });

    this.setMode('CHILD_READS');
    this.prefetchNextBeat();
  }

  /** Keep ONE beat buffered while the child reads. PLAN.md §4 cross-cutting rules. */
  private prefetchNextBeat() {
    const token = ++this.bufferToken;
    const nextBeat = this.beatIndex + 1;

    // Which detail the child shared this beat is allowed to use, if any. Chosen
    // here — at the moment the beat is written — and committed only when that
    // beat is actually spoken. See lib/facts.ts for why it is not the last thing
    // they said.
    const fact = this.facts.pickForWeaving(nextBeat);
    this.bufferedFactId = fact?.id ?? null;

    this.bufferedTurn = this.narrator
      .turn(
        'NEXT_BEAT',
        `The child is currently reading. Prepare beat ${nextBeat} of ${this.plan.beats.length}.`,
        { weave: fact?.text ?? null },
      )
      .then((turn) => {
        if (token !== this.bufferToken) throw new Error('stale buffer');
        return turn;
      })
      .catch(() => null as unknown as NarratorTurn);
  }

  private discardBuffer() {
    this.bufferToken++;
    this.bufferedTurn = null;
    // The beat that would have carried this detail is gone; it stays unused and
    // eligible for a later one.
    this.bufferedFactId = null;
  }

  private async nextBeat() {
    if (this.beatIndex >= this.plan.beats.length - 1) {
      // The planned story is out of road. That is a natural pause, not the end —
      // celebrate, and let the child decide whether there is more.
      await this.checkIn('the story reached its last beat');
      return;
    }

    // A short acknowledgment before the story continues, so the child's turn
    // does not cut straight to narration. It has to be generated here rather
    // than baked into the buffered beat: the buffer is prefetched while the
    // child is still reading, so it cannot know how the reading went.
    //
    // Kicked off alongside the beat so the two overlap — when the beat is
    // already buffered this is the only thing on the critical path, and Haiku
    // keeps it to roughly a second.
    const ackPromise = this.tracker
      ? generateAcknowledgment({ childName: this.child.name, words: this.tracker.words })
      : Promise.resolve(null);

    const factId = this.bufferedFactId;
    const buffered = this.bufferedTurn ? await this.bufferedTurn.catch(() => null) : null;
    this.discardBuffer();

    const ack = await ackPromise;
    if (ack) this.debug('lastAck', { text: ack.text, band: ack.quality.band, source: ack.source });

    // If the buffered beat survived it already carries the detail; if it did not,
    // this turn is generated fresh and needs to be told about it.
    const woven = factId === null ? null : this.facts.find(factId);

    await this.narrate('NEXT_BEAT', `Advance to beat ${this.beatIndex + 1}.`, {
      prefetched: buffered ?? undefined,
      speakPrefix: ack?.text ?? null,
      weave: buffered ? null : (woven?.text ?? null),
    });

    if (woven) {
      this.facts.markWoven(woven.id, this.beatIndex);
      this.debug('wovenFact', { text: woven.text, beat: this.beatIndex });
    }
  }

  // -------------------------------------------------------------------------
  // CHILD_READS -> COACH / ENCOURAGE
  // -------------------------------------------------------------------------

  private async onWords(words: any[], recognized: string) {
    if (!this.tracker || this.closed) return;
    if (this.mode !== 'CHILD_READS' && this.mode !== 'COACH') return;

    this.lastSpeechAt = Date.now();
    this.nudgeStage = 0;
    this.debug('azureRecognized', recognized);

    // Was that reading, or was it the child talking to us? Being ignored is what
    // teaches a child that the thing does not really listen, so every utterance
    // gets this question asked of it. lib/offscript.ts errs towards "reading".
    const verdict = detectOffScript({ recognized, words: this.tracker.words });
    if (verdict.offScript) {
      this.debug('offScript', {
        recognized,
        matchRatio: Number(verdict.matchRatio.toFixed(2)),
        reason: verdict.reason,
      });
      await this.handleChildSpeech(recognized, 'off_script');
      return;
    }

    const result = this.tracker.ingest(words);
    this.debug('lastWords', this.tracker.summary());

    for (const u of result.updates) {
      this.send({
        t: 'word',
        index: u.index,
        status: u.word.status,
        score: u.word.bestScore,
        errorType: u.word.errorType,
      });
      if (u.event) this.pendingEvents.push(u.event);
    }
    this.send({ t: 'cursor', index: this.tracker.cursor });
    void this.flushEvents();

    // A word they were stuck on and just got right. This is the moment worth
    // marking, and it has to land immediately — a two-second pause for an LLM
    // after a hard-won word is the wrong kind of silence, so it is templated.
    const wonBack = result.updates.find(
      (u) =>
        u.word.status === 'passed' &&
        (this.coachAttempts.get(u.index) ?? 0) > 0 &&
        !this.celebrated.has(u.index),
    );

    if (result.complete) {
      // The end-of-passage acknowledgment already celebrates; two in a row is a lot.
      await this.onPassageComplete();
      return;
    }

    if (wonBack) {
      this.celebrated.add(wonBack.index);
      this.log('coach', `celebrated "${wonBack.word.expected}"`, { word: wonBack.word.expected });
      await this.speak(T.gotItLine(wonBack.word.expected));
      this.setMode('CHILD_READS');
    }

    if (result.needsCoaching !== null) {
      await this.coach(result.needsCoaching);
    }
  }

  private async coach(index: number) {
    if (!this.tracker) return;
    const word = this.tracker.words[index];
    if (!word) return;

    const attempts = (this.coachAttempts.get(index) ?? 0) + 1;
    this.coachAttempts.set(index, attempts);
    this.coachEventsThisPassage += 1;

    // Frustration / repeated struggle inside one passage -> ADAPT. PLAN.md §4.
    if (this.coachEventsThisPassage >= ADAPT_COACH_THRESHOLD) {
      await this.adapt('3+ coaching moments in one passage');
      return;
    }

    if (attempts > MAX_COACH_ATTEMPTS) {
      // Say the word warmly and move on. Never let a child grind on one word.
      const line = T.giveWordLine(word.expected);
      this.tracker.markGiven(index);
      this.send({ t: 'word', index, status: 'given', score: word.bestScore, errorType: word.errorType });
      this.send({ t: 'cursor', index: this.tracker.cursor });
      this.log('coach', line, { word: word.expected, gave: true });

      this.setMode('COACH', 'gave the word');
      await this.speak(line);

      if (this.tracker.isComplete()) {
        await this.onPassageComplete();
      } else {
        this.setMode('CHILD_READS');
      }
      return;
    }

    this.setMode('COACH', `stuck on "${word.expected}"`);
    this.tracker.markCoaching(index);

    const line = T.coachLine(word.expected, attempts);
    this.log('coach', line, { word: word.expected, attempt: attempts });
    await this.speak(line);

    // Back to CHILD_READS on the same word.
    this.setMode('CHILD_READS');
    this.lastSpeechAt = Date.now();
  }

  private async onPassageComplete() {
    if (!this.tracker) return;

    // Snapshot for the progress summary at the next check-in. A copy, because
    // the tracker is about to be replaced.
    this.passageRecords.push(this.tracker.words.map((w) => ({ ...w })));
    this.passagesSinceCheckIn += 1;

    const strong = this.tracker.wasStrong();
    this.strongPassages = strong ? this.strongPassages + 1 : 0;
    this.debug('strongPassages', this.strongPassages);

    await this.pron?.close();
    this.pron = null;

    // A check-in outranks an encouragement — it is celebratory in its own right,
    // and stacking praise on praise right at a stopping point is a lot of noise.
    if (
      shouldCheckIn({
        passagesSinceCheckIn: this.passagesSinceCheckIn,
        msSinceCheckIn: Date.now() - this.lastCheckInAt,
        checkIns: this.checkIns,
      })
    ) {
      await this.checkIn('a good stopping point');
      return;
    }

    if (this.strongPassages >= 2) {
      this.strongPassages = 0;
      this.discardBuffer();
      this.setMode('ENCOURAGE', 'two strong passages');

      // Code picks the word, not the narrator. Asked to "name something
      // specific", the model would reach for a plausible word from its context
      // (a must_use_word, a skill example) instead of one the child said.
      const praiseWord = pickPraiseWord(this.tracker.words);
      this.debug('praiseWord', praiseWord);

      await this.narrate(
        'ENCOURAGE',
        `They read two passages beautifully. Then continue to beat ${this.beatIndex + 1}.`,
        { mustMention: praiseWord },
      );
      return;
    }

    await this.nextBeat();
  }

  // -------------------------------------------------------------------------
  // WRAP_UP: celebrate, then ask whether to keep going
  // -------------------------------------------------------------------------

  /**
   * A natural pause after a stretch of reading.
   *
   * Celebrates the effort, names what actually improved, and asks — genuinely —
   * whether the child wants more. The words named come from the passages really
   * read (lib/sessionflow.ts), never from the narrator's recollection of them.
   */
  private async checkIn(reason: string) {
    if (this.closed || this.mode === 'END') return;

    this.checkIns += 1;
    this.passagesSinceCheckIn = 0;
    this.lastCheckInAt = Date.now();
    this.discardBuffer();

    await this.pron?.close();
    this.pron = null;

    const progress = summarizeProgress(this.passageRecords);
    this.debug('progress', progress);
    const named = [...progress.conquered, ...progress.strong].slice(0, 3);

    const context = [
      `They have read ${progress.passages} passage${progress.passages === 1 ? '' : 's'} today.`,
      progress.conquered.length
        ? `Words they were stuck on and then got right: ${progress.conquered.join(', ')}.`
        : '',
      !progress.conquered.length && progress.strong.length
        ? `Words they read beautifully: ${progress.strong.join(', ')}.`
        : '',
      `Reason for pausing here: ${reason}.`,
    ]
      .filter(Boolean)
      .join(' ');

    await this.narrate('CHECK_IN', context, { mustMentionAny: named, after: 'hold' });
    if (this.closed) return;

    this.setMode('WRAP_UP', reason);
    this.send({ t: 'awaiting_answer', question: 'continue' });

    const answer = await this.askContinue();
    if (this.closed) return;

    if (answer === 'yes') {
      await this.continueStory();
      return;
    }
    await this.end(answer === 'no' ? 'child chose to stop' : 'no answer at the check-in');
  }

  /**
   * Two chances to answer, by voice or by tapping. Silence is never taken as a
   * yes: a child who has drifted off gets an ending, not more reading.
   */
  private async askContinue(): Promise<'yes' | 'no' | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.stashedAnswer) {
        const stashed = this.stashedAnswer;
        this.stashedAnswer = null;
        return stashed;
      }

      const tapped = new Promise<'yes' | 'no'>((resolve) => {
        this.answerFromUi = resolve;
      });
      const spoken = this.listen(ANSWER_LISTEN_MS).then((text) => {
        if (text) this.log('child_talk', text);
        return parseYesNo(text);
      });

      const answer = await Promise.race([tapped, spoken]);
      this.answerFromUi = null;
      this.stopListening();

      if (answer) return answer;
      if (this.closed) return null;

      // Nothing, or something that was neither yes nor no. Ask once more, plainly.
      if (attempt === 0) await this.speak(T.continueRepromptLine());
    }
    return null;
  }

  private async continueStory() {
    if (this.closed) return;

    // Say yes out loud before doing any work — extending the plan is an LLM call,
    // and the child has just committed to more reading.
    await this.speak(T.keepGoingLine());

    // Out of planned beats: extend the SAME story rather than starting a new one.
    // Premise, difficulty, target skills and must-use words all stay put — only
    // the road ahead is new.
    if (this.beatIndex >= this.plan.beats.length - 1) {
      const more = await extendPlanBeats({
        plan: this.plan,
        fromBeat: this.beatIndex,
        learned: this.facts.summaryLines(),
      });
      this.plan = { ...this.plan, beats: [...this.plan.beats, ...more] };
      this.narrator.updatePlan(this.plan);
      this.debug('plan', this.plan);
    }

    await this.narrate('CONTINUE', `They want to keep reading. Continue from beat ${this.beatIndex + 1}.`);
  }

  private async adapt(reason: string) {
    this.discardBuffer();
    this.setMode('ADAPT', reason);
    this.send({ t: 'flag', type: 'frustration', detail: reason });
    await this.flag('frustration', reason);

    this.plan = {
      ...this.plan,
      difficulty: Math.max(1, this.plan.difficulty - 1),
      vocab_constraints: {
        ...this.plan.vocab_constraints,
        max_sentence_words: Math.max(4, this.plan.vocab_constraints.max_sentence_words - 2),
      },
    };
    this.narrator.updatePlan(this.plan);
    this.debug('plan', this.plan);

    await this.pron?.close();
    this.pron = null;

    await this.narrate(
      'ADAPT',
      'The child is finding this hard. One short sentence only, simplest words, and offer them a choice.',
    );
  }

  // -------------------------------------------------------------------------
  // TALK mode + intent router (PLAN.md §5)
  // -------------------------------------------------------------------------

  private async openTalk() {
    if (this.mode === 'END' || this.closed) return;
    // Nothing to interrupt yet, and no story to route an intent against.
    if (this.mode === 'ONBOARDING' || !this.plan) return;
    // A conversational listen is already open — the child is being heard.
    if (this.talk) return;

    // 1. Kill playback instantly and stop pronunciation assessment.
    this.stopSpeaking();
    await this.pron?.close();
    this.pron = null;

    this.setMode('TALK', 'talk button');
    this.send({ t: 'talk_open' });

    // Same listener as everywhere else, so the button cannot truncate a child
    // mid-sentence when nothing else does. No speech within TALK_TIMEOUT_MS and
    // it resolves null -> playful nudge, resume where we were.
    const said = await this.listen(TALK_TIMEOUT_MS);
    await this.routeTalk(said);
  }

  private async closeTalk() {
    // Push-to-talk release. Give the tail a moment to arrive rather than cutting
    // at the instant their finger leaves the button — children let go early, and
    // the last word is usually the one that mattered.
    if (this.mode !== 'TALK') return;
    if (this.talkTimer) clearTimeout(this.talkTimer);
    this.talkTimer = setTimeout(() => this.stopListening(), 900);
  }

  private async routeTalk(transcript: string | null) {
    if (this.closed) return;

    if (!transcript || transcript.trim().length < 2) {
      this.send({ t: 'talk_closed', transcript: null, intent: null });
      await this.speak(T.talkTimeoutLine());
      this.resumeReading();
      return;
    }

    await this.handleChildSpeech(transcript, 'button');
  }

  /**
   * Everything the child says that is not reading arrives here — whether they
   * tapped the owl or simply spoke up mid-passage. One path, so speaking up gets
   * the same answer either way, and so nothing a child says goes unanswered.
   */
  private async handleChildSpeech(
    transcript: string,
    source: 'button' | 'off_script' | 'barge_in',
  ) {
    if (this.closed) return;

    this.setMode(
      'TALK',
      source === 'barge_in'
        ? 'child interrupted'
        : source === 'off_script'
          ? 'child spoke up'
          : 'talk button',
    );
    this.log('child_talk', transcript);

    // Assessment must stop: they are talking, and anything they say now would be
    // scored against a passage they are not reading.
    await this.pron?.close();
    this.pron = null;

    const currentWord =
      this.tracker && this.tracker.cursor < this.tracker.words.length
        ? this.tracker.words[this.tracker.cursor].expected
        : null;

    const { intent, interestTopic, fact, factKind, requestedTopic, reasoning } =
      await classifyIntent({
        transcript,
        currentPassage: this.tracker?.passage ?? null,
        currentWord,
        storyPremise: this.plan.premise,
        source,
      });

    this.debug('lastIntent', { transcript, intent, reasoning, source, requestedTopic });
    this.send({ t: 'talk_closed', transcript, intent });

    // Remember before replying, so the reply is generated by a narrator that
    // already knows this about them.
    this.rememberFact(fact, interestTopic, factKind);

    await this.handleIntent(intent, transcript, interestTopic, currentWord, requestedTopic);
  }

  /** The child's strongest known interest — what to steer towards when they only said "no". */
  private favouriteTopic(): string | null {
    const top = this.memory.interests.slice().sort((a, b) => b.weight - a.weight)[0]?.topic;
    return top?.trim() || this.draft.interests[0] || null;
  }

  /**
   * File something the child revealed about their life.
   *
   * Note what this does NOT do: change the story now. The narrator is told about
   * it for tone, but lib/facts.ts decides which beat may actually use it, two
   * beats later at the earliest. A detail echoed back in the very next sentence
   * is not personalisation, it is a parrot.
   */
  private rememberFact(text: string | null, topic: string | null, kind: FactKind | null) {
    if (!text) return;

    const fact = this.facts.add({ text, topic, kind, beat: this.beatIndex });
    if (!fact) return;

    this.log('fact', fact.text, { kind: fact.kind, topic: fact.topic });
    this.send({ t: 'fact', text: fact.text, topic: fact.topic, kind: fact.kind });
    this.debug('facts', this.facts.all());
    this.narrator?.updateLearned(this.facts.summaryLines());
  }

  private async handleIntent(
    intent: Intent,
    transcript: string,
    interestTopic: string | null,
    currentWord: string | null,
    requestedTopic: string | null = null,
  ) {
    switch (intent) {
      // Procedural help is never Socratic. Answer directly, then keep reading.
      case 'help_with_word':
        await this.narrate(
          'ANSWER_DIRECTLY',
          `The child asked: "${transcript}". They are on the word "${currentWord ?? 'unknown'}". Tell them what it says and how to sound it out.`,
        );
        this.resumeReading();
        return;

      case 'question_about_story_or_world': {
        this.discardBuffer();
        this.socraticCount += 1;
        this.setMode('SOCRATIC', `question #${this.socraticCount}`);

        if (this.socraticCount > MAX_SOCRATIC_QUESTIONS) {
          // Patience beats pedagogy purity. Edge case #8.
          this.socraticCount = 0;
          await this.narrate(
            'ANSWER_DIRECTLY',
            `The child asked: "${transcript}". You have already asked them several guiding questions. Give them the answer warmly now, then weave back to the story in one sentence.`,
          );
        } else {
          await this.narrate(
            'SOCRATIC',
            `The child asked: "${transcript}". This is guiding question ${this.socraticCount} of ${MAX_SOCRATIC_QUESTIONS}.`,
          );
        }
        this.resumeReading();
        return;
      }

      case 'change_request': {
        this.discardBuffer();
        this.setMode('REMIX', transcript);

        // "I'm bored" is a change request with nothing to change to. Rebuilding
        // the story around the word "bored" is not an answer — asking them what
        // they would rather hear is, and it is what a person would do.
        let topic = requestedTopic?.trim() || null;
        if (!topic) {
          const favourite = this.favouriteTopic();
          await this.speak(T.whatWouldYouLikeLine(favourite));
          const said = await this.listen(ANSWER_LISTEN_MS);
          if (said) {
            this.log('child_talk', said);
            this.send({ t: 'talk_closed', transcript: said, intent: 'change_request' });
            const answer = await classifyIntent({
              transcript: said,
              currentPassage: null,
              currentWord: null,
              storyPremise: this.plan.premise,
              source: 'button',
            });
            this.rememberFact(answer.fact, answer.interestTopic, answer.factKind);
            topic = answer.requestedTopic?.trim() || answer.interestTopic?.trim() || said;
          } else {
            // They did not answer. Their favourite thing is a far better guess
            // than carrying on with the story they just told us they were bored of.
            topic = favourite;
          }
        }

        this.debug('remixTopic', topic);
        await this.narrate(
          'REMIX',
          `The child said: "${transcript}". They want the story to be about: ${
            topic ?? 'something completely new'
          }. Rebuild the next beat around that — really change it, do not just mention it once. Keep difficulty ${this.plan.difficulty}, the same target skills, and the same must-use words: ${this.plan.vocab_constraints.must_use_words.join(', ')}.`,
        );

        // Steer the REST of the story too, not just one beat. A child who asked
        // for cars and got one car-shaped sentence has been humoured, not heard.
        if (topic) {
          this.plan = {
            ...this.plan,
            premise: `${this.plan.premise} — now all about ${topic}`,
            beats: this.plan.beats.map((b, i) =>
              i <= this.beatIndex ? b : `${b} (retold around ${topic})`,
            ),
          };
          this.narrator.updatePlan(this.plan);
          this.debug('plan', this.plan);
        }
        return;
      }

      case 'chitchat':
        if (interestTopic) {
          this.interestSignals.push(interestTopic);
          this.debug('interestSignals', this.interestSignals);
        }
        await this.narrate(
          'CHITCHAT',
          `The child said: "${transcript}". Answer them warmly and briefly — two short sentences at the very most — then invite them back to the line they were reading. Do not turn this into a scene, and do not put what they said into the story now.`,
        );
        this.resumeReading();
        return;

      case 'want_to_stop':
        await this.flag('early_exit', transcript);
        this.send({ t: 'flag', type: 'early_exit', detail: transcript });
        await this.end('child wants to stop');
        return;

      case 'sensitive_topic': {
        // FIXED template. Never improvised. Flagged for the parent. PLAN.md §5.
        const character = this.plan.characters[0] ?? 'our friend';
        const line = T.sensitiveTopicLine(character);
        await this.flag('sensitive_topic', transcript);
        this.send({ t: 'flag', type: 'sensitive_topic', detail: transcript });
        this.log('narrator', line, { template: 'sensitive_topic' });
        await this.speak(line);
        this.resumeReading();
        return;
      }

      case 'unclear':
      default:
        await this.speak(T.unclearLine());
        this.resumeReading();
        return;
    }
  }

  /** Return to the passage the child was on, restarting assessment on it. */
  private resumeReading() {
    if (this.closed || this.mode === 'END') return;
    if (!this.tracker || this.tracker.isComplete()) return;

    const passage = this.tracker.passage;
    if (!this.pron) {
      this.pron = new PronunciationSession(passage, {
        onPartial: (text) => {
          this.lastSpeechAt = Date.now();
          this.nudgeStage = 0;
          this.debug('azurePartial', text);
        },
        onWords: (words, recognized) => void this.onWords(words, recognized),
        onError: (m) => console.error('[azure]', m),
      });
    }
    this.setMode('CHILD_READS', 'back to the story');
    this.lastSpeechAt = Date.now();
    this.nudgeStage = 0;
    this.send({ t: 'cursor', index: this.tracker.cursor });
  }

  // -------------------------------------------------------------------------
  // Timers: silence ladder + stuck-word detection
  // -------------------------------------------------------------------------

  private onTick() {
    if (this.closed || this.isSpeaking) return;
    if (this.mode !== 'CHILD_READS') return;

    const idle = Date.now() - this.lastSpeechAt;

    // Pause > 3000ms on the current word counts as being stuck. PLAN.md §4.
    if (
      this.tracker &&
      idle > WORD_STUCK_MS &&
      this.nudgeStage === 0 &&
      this.tracker.cursor < this.tracker.words.length &&
      (this.coachAttempts.get(this.tracker.cursor) ?? 0) === 0 &&
      idle < SILENCE_NUDGE_MS
    ) {
      // Give them a beat of quiet before the nudge ladder kicks in.
      return;
    }

    if (idle > SILENCE_PAUSE_MS && this.nudgeStage < 3) {
      this.nudgeStage = 3;
      this.setMode('PAUSED', 'no speech for 45s');
      void this.speak(T.pausedLine());
      return;
    }
    if (idle > SILENCE_CHECKIN_MS && this.nudgeStage < 2) {
      this.nudgeStage = 2; // never nag more than twice
      this.send({ t: 'nudge', text: 'checking in' });
      void this.speak(T.stillThereLine());
      return;
    }
    if (idle > SILENCE_NUDGE_MS && this.nudgeStage < 1) {
      this.nudgeStage = 1;
      const w = this.tracker?.words[this.tracker.cursor];
      if (w) {
        this.send({ t: 'nudge', text: 'gentle prompt' });
        void this.speak(T.silenceNudge(w.expected));
      }
      return;
    }

    const elapsed = Date.now() - this.startedAt;

    // Nobody reads for half an hour. This is the backstop for a session left
    // running, not a pedagogical decision.
    if (elapsed > HARD_STOP_MS) {
      void this.end('session ran long');
      return;
    }

    // The 15 minute mark is no longer a hard stop: it offers a stopping point.
    // Passage boundaries usually get there first (lib/sessionflow.ts); this
    // catches a child who has been on one passage for a long time.
    if (elapsed > SESSION_SOFT_MAX_MS && this.checkIns === 0) {
      void this.checkIn('we have been reading a while');
    }
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async flushEvents() {
    if (!this.sessionId || this.pendingEvents.length === 0) return;
    const batch = this.pendingEvents.splice(0, this.pendingEvents.length);
    try {
      for (const e of batch) {
        await query(
          `INSERT INTO reading_events
             (session_id, child_id, expected_word, attempt, error_type, accuracy_score, phonemes, pause_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            this.sessionId,
            this.child.id,
            e.expected_word,
            e.attempt,
            e.error_type,
            e.accuracy_score,
            JSON.stringify(e.phonemes ?? []),
            e.pause_ms ?? 0,
          ],
        );
      }
    } catch (err) {
      console.error('[session] failed to write reading_events', err);
    }
  }

  private async flag(type: string, detail: string) {
    if (!this.sessionId) return;
    try {
      await query('INSERT INTO session_flags (session_id, type, detail) VALUES ($1,$2,$3)', [
        this.sessionId,
        type,
        detail,
      ]);
    } catch (err) {
      console.error('[session] failed to write flag', err);
    }
  }

  // -------------------------------------------------------------------------
  // END
  // -------------------------------------------------------------------------

  async end(reason: string) {
    if (this.mode === 'END' || this.closed) return;
    this.discardBuffer();
    this.setMode('END', reason);
    this.stopListening();

    await this.pron?.close();
    this.pron = null;

    // Stopped before there was a story — during onboarding, or while the plan was
    // still being written. There is nothing to wrap up, so say goodbye kindly.
    if (!this.narrator) {
      await this.speak(T.goodbyeLine(this.child.name || 'friend', 'Come back and read with me soon!'));
      await this.finishEnd();
      return;
    }

    const progress = summarizeProgress(this.passageRecords);
    const won = progress.conquered.length
      ? ` They were stuck on these words and then got them right: ${progress.conquered.join(', ')}.`
      : progress.strong.length
        ? ` Words they read beautifully: ${progress.strong.join(', ')}.`
        : '';

    await this.narrate(
      'CLOSING',
      `Wrap the story up in one beat — never on a cliffhanger. They read ${progress.passages} passage(s) today.${won} Name something real they did, tell them you cannot wait to read again, and leave them feeling proud. Reason for ending: ${reason}.`,
    );
  }

  /**
   * Fold what the child told us today into the memory model, so the NEXT
   * session's planner already knows it. Consolidation (PLAN.md §12) still does
   * the deeper rewrite — this just means nobody has to press a button for the
   * story to remember a lost tooth.
   */
  private async persistFacts() {
    const facts = this.facts.all();
    if (facts.length === 0) return;

    const merged = mergeFactsIntoMemory(this.memory, facts);
    try {
      await query(
        `UPDATE child_memory
            SET interests = $2, canon = $3, version = version + 1, updated_at = now()
          WHERE child_id = $1`,
        [this.child.id, JSON.stringify(merged.interests), JSON.stringify(merged.canon)],
      );
      this.memory = merged;
      this.debug('memoryAfterSession', merged);
    } catch (err) {
      console.error('[session] failed to save what the child told us', err);
    }
  }

  private async finishEnd() {
    await this.flushEvents();
    await this.persistFacts();

    if (this.sessionId) {
      try {
        await query('UPDATE sessions SET ended_at = now(), transcript = $2 WHERE id = $1', [
          this.sessionId,
          JSON.stringify(this.transcript),
        ]);
        if (this.interestSignals.length) {
          await query('INSERT INTO session_flags (session_id, type, detail) VALUES ($1,$2,$3)', [
            this.sessionId,
            'interest_signals',
            this.interestSignals.join(', '),
          ]);
        }
      } catch (err) {
        console.error('[session] failed to save transcript', err);
      }
    }

    this.send({ t: 'ended', sessionId: this.sessionId ?? '' });
    await this.close();
  }
}
