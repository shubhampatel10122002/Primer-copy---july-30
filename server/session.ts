import type { WebSocket } from 'ws';
import { AUDIO } from '../lib/env';
import { query, one } from '../lib/db';
import { Narrator, type NarratorMode, type NarratorTurn } from '../lib/llm/narrator';
import { respondToChild, type ChildResponse } from '../lib/llm/respond';
import { generateSessionPlan, fallbackPlan, extendPlanBeats } from '../lib/llm/planner';
import { generateAcknowledgment } from '../lib/llm/acknowledge';
import { OnboardingAgent } from '../lib/llm/onboarding';
import { pickTargets } from '../lib/pedagogy';
import { pickPraiseWord } from '../lib/praise';
import { branchUtterance, looksLikeEcho, settleDelay } from '../lib/conversation';
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
import { PronunciationSession } from './azure';
import { RealtimeVoice, type SpeakHandle } from './realtime';
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
 * How long the child must be quiet before we treat their turn as finished.
 *
 * These are the most important numbers in the conversation, and the biggest
 * single component of how long a reply takes — at a flat 2.5s the model was less
 * than a third of the wait. So the delay is now chosen per utterance
 * (`settleDelay`): a plainly complete sentence, or an urgent one-word cue, is
 * answered almost at once, and only a thought still visibly in motion — a
 * trailing "and", a list that has just started — buys the long window.
 *
 * Too short anywhere and we cut them off between two thoughts, which is exactly
 * what a child experiences as not being listened to. The patience is kept; it is
 * just spent where it is needed.
 */
const QUIET_QUICK_MS = 800;
const QUIET_NORMAL_MS = 2_000;
const QUIET_PATIENT_MS = 3_800;

/**
 * How long after hearing them we still consider the child to be talking.
 *
 * The AI must never start a sentence inside this window. It is the whole of
 * "never talk over the child", expressed as one number.
 */
const CHILD_SPEAKING_GRACE_MS = 900;

/**
 * A turn that is clearly just the line on screen needs no patience: we are not
 * going to answer it, so there is nothing to cut off. Only conversation gets the
 * long quiet window.
 */
const READING_SETTLE_MS = 350;

/** How much of the back-and-forth both the responder and the narrator can see. */
const DIALOGUE_MEMORY = 10;

/** Longest we will hold a reply waiting for a child to stop talking. */
const MAX_HOLD_MS = 15_000;

/**
 * Ignore "the child started speaking" for this long after they first HEAR us.
 *
 * Echo cancellation takes a moment to adapt to a new sound, so the onset of our
 * own voice is the single most likely thing to be mistaken for the child's.
 * Measured from the first audible byte, not from when we asked the model to
 * speak — those can be most of a second apart.
 */
const INTERRUPT_GUARD_MS = 400;

/** Below this much audio heard, a cancelled line is worth saying again. */
const UNHEARD_AUDIBLE_MS = 1_200;

/** If an interruption produces no words at all, assume it was noise and retry. */
const UNHEARD_RETRY_MS = 1_800;

export class Session {
  private mode: Mode = 'IDLE';
  private sessionId: string | null = null;
  private narrator!: Narrator;
  private plan!: SessionPlan;

  private tracker: PassageTracker | null = null;

  /**
   * Two layers, two jobs, no contention.
   *
   * `voice` is the conversation layer AND the mouth: one Realtime connection,
   * open from the first moment of the session to the last. It detects speech in
   * the audio itself and says so within a couple of hundred milliseconds, which
   * is what finally makes interruption immediate — we are told the child has
   * started, rather than inferring it from a transcript that arrives long after.
   *
   * `pron` is the assessment layer: created per passage, strict, and only ever
   * asked how well the words on screen were said. Both get the same audio.
   */
  private voice: RealtimeVoice | null = null;
  private pron: PronunciationSession | null = null;

  private speaking: SpeakHandle | null = null;
  /** Running total of TTS bytes sent, so one utterance can be measured. */
  private audioBytesOut = 0;
  private audioBytesAtSpeakStart = 0;
  private gateOpenAt = 0; // mic frames before this timestamp are dropped
  private isSpeaking = false;
  /** What we are saying right now — the echo guard needs the exact words. */
  private speakingText = '';
  /** While this is in the future, the child is mid-sentence and we stay quiet. */
  private childSpeakingUntil = 0;
  /** When the child first actually HEARD the current utterance. */
  private speakingFirstAudioAt = 0;
  /** A line cut off before a word of it was audible, and its recovery timer. */
  private unheard: string | null = null;
  private unheardTimer: NodeJS.Timeout | null = null;
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

  /**
   * The last few things said, by either of us, in order.
   *
   * There are two writers of speech in this system — the fast responder and the
   * narrator — and without this they were two separate conversations happening at
   * the same child. It is why Ollie could ask a question and then, one sentence
   * later, behave as though he had not. One thread, shared by both.
   */
  private dialogue: string[] = [];

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
  /** Segments of the turn the child is speaking right now, and the quiet timer. */
  private turnSegments: string[] = [];
  private turnTimer: NodeJS.Timeout | null = null;
  /** Set when something is waiting for a spoken answer (onboarding, check-in). */
  private awaitingReply: ((text: string | null) => void) | null = null;
  private replyTimeout: NodeJS.Timeout | null = null;
  private answerFromUi: ((value: 'yes' | 'no') => void) | null = null;
  private stashedAnswer: 'yes' | 'no' | null = null;

  private lastSpeechAt = Date.now();
  private nudgeStage = 0;
  private tick: NodeJS.Timeout | null = null;
  private startedAt = Date.now();
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
    // The first byte out is the first moment the child could possibly be
    // reacting to us, which is what makes an interruption an interruption.
    if (this.isSpeaking && this.speakingFirstAudioAt === 0) this.speakingFirstAudioAt = Date.now();
    this.audioBytesOut += pcm.length;
    this.ws.send(pcm, { binary: true });
  }

  private log(kind: TranscriptEntry['kind'], text: string, meta?: Record<string, unknown>) {
    this.transcript.push({ ts: new Date().toISOString(), kind, text, meta });

    // Keep one thread of who said what, so neither writer of speech has to guess
    // what the other one just did.
    if (kind === 'narrator') this.dialogue.push(`You: ${text}`);
    else if (kind === 'child_talk') this.dialogue.push(`Child: ${text}`);
    else return;
    if (this.dialogue.length > DIALOGUE_MEMORY) this.dialogue.shift();
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

    // Connect FIRST, before anything is said. From this moment to the end of the
    // session the child is being listened to, in every mode, with no gap for a
    // recognizer to be torn down and rebuilt in. Everything else — onboarding,
    // reading, check-ins — happens on top of a microphone that never closes.
    this.voice = new RealtimeVoice({
      onSpeechStarted: () => this.onChildStartedSpeaking(),
      onSpeechStopped: () => this.onChildStoppedSpeaking(),
      onUtterance: (text) => this.onChildUtterance(text),
      onAudio: (pcm) => this.sendAudio(pcm),
      onError: (m) => {
        console.error('[realtime]', m);
        this.send({ t: 'error', message: m });
      },
      onOpen: () => this.send({ t: 'listening', on: true }),
      onClose: (code, reason) => console.warn(`[realtime] closed ${code} ${reason}`),
    });

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

      // Decide whether we are done BEFORE asking anything, never after.
      //
      // This used to sit at the bottom of the loop, so a turn that asked "and
      // what colour car?" and then tipped the draft over the line would speak the
      // question and immediately break — the story started half a second later,
      // on top of a child who was drawing breath to answer. Asking a question you
      // are not going to wait for is worse than not asking it.
      if (hasEnoughToStart(this.draft) && turn >= 1) break;

      // Saying the same thing twice is how one voice starts sounding like two
      // different people talking past each other.
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

      // We just asked them something. We wait. Every time.
      heard = await this.waitForReply(ONBOARDING_LISTEN_MS);
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
  // The conversation layer: every utterance, one pipeline
  // -------------------------------------------------------------------------

  /**
   * The child started speaking. From the audio itself, not from a transcript.
   *
   * This is the event the whole rewrite was for. Every previous attempt at
   * interruption had to wait for words — a partial, then a final — and words
   * arrive hundreds of milliseconds to a second after the first syllable, by
   * which point the narrator has usually finished its sentence and "stopping"
   * is indistinguishable from not stopping. Server-side VAD hears the sound.
   *
   * So there is no cleverness left here. They are talking, so we stop. What they
   * MEANT is decided later, when the transcript arrives.
   */
  private onChildStartedSpeaking() {
    if (this.closed) return;

    if (this.isSpeaking) {
      const bytes = this.audioBytesOut - this.audioBytesAtSpeakStart;
      const audibleFor = this.speakingFirstAudioAt ? Date.now() - this.speakingFirstAudioAt : 0;

      // You cannot interrupt something you have not heard.
      //
      // Nothing has reached their ears yet, so whatever the microphone picked up
      // was not a reaction to us — it was the room, a sibling, or the tail of our
      // own greeting coming back before echo cancellation had settled. Cancelling
      // here is how the first thing Ollie ever says gets killed before a syllable
      // of it plays, which is exactly what kept happening.
      if (bytes === 0) {
        this.debug('bargeInIgnored', 'nothing had played yet — not a reaction to us');
        return;
      }

      // And for a moment after the sound starts, echo cancellation is still
      // adapting to it, which is the other reliable false trigger.
      if (audibleFor < INTERRUPT_GUARD_MS) {
        this.debug('bargeInIgnored', `only ${audibleFor}ms audible — too soon to be a reply`);
        return;
      }

      this.childSpeakingUntil = Date.now() + CHILD_SPEAKING_GRACE_MS;
      this.lastSpeechAt = Date.now();
      this.nudgeStage = 0;

      console.log(`[barge-in] child spoke over "${this.speakingText.slice(0, 40)}…"`);
      this.debug('bargeIn', { by: 'vad', over: this.speakingText.slice(0, 60), audibleFor });

      // Barely heard any of it and then nothing follows? That was a noise, and
      // the line is worth saying again rather than losing.
      if (audibleFor < UNHEARD_AUDIBLE_MS) this.armUnheard(this.speakingText);

      this.stopSpeaking();
      this.send({ t: 'hearing', on: true });
      return;
    }

    this.childSpeakingUntil = Date.now() + CHILD_SPEAKING_GRACE_MS;
    this.lastSpeechAt = Date.now();
    this.nudgeStage = 0;
    this.send({ t: 'hearing', on: true });
  }

  /** Say it again if that "interruption" turns out to have been nobody. */
  private armUnheard(text: string) {
    this.clearUnheard();
    this.unheard = text;
    this.unheardTimer = setTimeout(() => {
      const line = this.unheard;
      this.clearUnheard();
      if (!line || this.closed || this.mode === 'END') return;
      console.log(`[voice] nothing followed that interruption — saying it again`);
      void this.speak(line);
    }, UNHEARD_RETRY_MS);
  }

  private clearUnheard() {
    if (this.unheardTimer) clearTimeout(this.unheardTimer);
    this.unheardTimer = null;
    this.unheard = null;
  }

  private onChildStoppedSpeaking() {
    if (this.closed) return;
    // Keep the floor for a moment longer: VAD calls the end of a breath, not the
    // end of a thought, and the turn buffer is what decides they have finished.
    this.childSpeakingUntil = Date.now() + CHILD_SPEAKING_GRACE_MS;
    this.send({ t: 'hearing', on: false });
  }

  /**
   * One complete utterance from the ear. EVERY utterance arrives here, in every
   * mode, whether we are speaking or not. Nothing else in the system decides
   * whether the child is worth listening to.
   *
   * Utterances are buffered into a turn rather than acted on one at a time: Azure
   * ends an utterance at every pause and children pause constantly, so acting on
   * the first segment is how "I like cars, like Lamborghini... and Bugatti"
   * becomes an interruption.
   */
  private onChildUtterance(text: string) {
    if (this.closed || !text.trim()) return;
    // Somebody really was talking, so the line we cut off was rightly cut off.
    this.clearUnheard();

    // Our own voice, heard through the speaker. Much rarer now — the Realtime
    // session suppresses echo on the input and VAD would have stopped us long
    // before this arrived — but a laptop at full volume in a small room can
    // still land a word, and crediting that to the child derails the story.
    if (this.isSpeaking && looksLikeEcho(text, this.speakingText)) {
      this.debug('echoIgnored', text);
      return;
    }
    if (this.isSpeaking) {
      this.debug('bargeIn', { by: 'words', text });
      this.stopSpeaking();
    }

    this.childSpeakingUntil = Date.now() + CHILD_SPEAKING_GRACE_MS;
    this.lastSpeechAt = Date.now();
    this.nudgeStage = 0;

    this.turnSegments.push(text.trim());
    this.debug('turnSegments', this.turnSegments);

    // How long to wait before deciding they have finished.
    //
    // Patience is for conversation. A turn that is plainly just the line on
    // screen is not going to be answered, so holding the floor open for it only
    // delays the narrator — and holding the floor is what keeps the assessment
    // layer quiet, so the delay is real.
    const soFar = this.turnSegments.join(' ');
    const passage = this.tracker?.passage ?? null;
    const looksLikeReading =
      passage !== null && branchUtterance({ text: soFar, passage }).kind === 'reading';

    const quiet = looksLikeReading
      ? READING_SETTLE_MS
      : settleDelay(soFar, {
          quick: QUIET_QUICK_MS,
          normal: QUIET_NORMAL_MS,
          patient: QUIET_PATIENT_MS,
        });

    this.debug('settleIn', quiet);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => this.closeTurn(), quiet);
  }

  /** The child has stopped talking. Now, and only now, decide what it was. */
  private closeTurn() {
    if (this.turnTimer) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    const text = this.turnSegments.join(' ').replace(/\s+/g, ' ').trim();
    this.turnSegments = [];
    this.childSpeakingUntil = 0;
    if (!text || this.closed) return;

    // Something asked them a direct question and is waiting for the answer.
    if (this.awaitingReply) {
      const waiter = this.awaitingReply;
      this.awaitingReply = null;
      if (this.replyTimeout) clearTimeout(this.replyTimeout);
      waiter(text);
      return;
    }

    void this.routeTurn(text);
  }

  /**
   * Reading, talking, or both?
   *
   * Deliberately NOT a guess about intent — a comparison against the words on
   * screen. Scoring is the assessment layer's job either way; the only question
   * here is whether anything the child said also needs an answer.
   */
  private async routeTurn(text: string) {
    if (this.closed || this.mode === 'END') return;

    const branch = branchUtterance({ text, passage: this.tracker?.passage ?? null });
    this.debug('branch', {
      text,
      kind: branch.kind,
      overlap: Number(branch.overlap.toFixed(2)),
      reason: branch.reason,
    });

    if (branch.kind === 'reading') return; // the assessment layer has it

    // Mixed: they read the line AND said something in the middle of it. The
    // reading half is already scored; answer the half that was aimed at us.
    const said = branch.kind === 'mixed' ? branch.conversationText : text;
    if (!said.trim()) return;

    // They said something to us. Anything the assessment layer was in the middle
    // of saying — a coaching line, a celebration, the next beat — was written
    // before this and is now the wrong thing to say.
    this.yieldFloor(`child said "${said.slice(0, 40)}"`);

    // Nothing to answer with yet — still onboarding or still planning. Hold it so
    // the next thing that listens picks it up instead of losing it.
    if (!this.plan || !this.narrator) {
      this.pendingSpeech = said;
      return;
    }

    await this.handleChildSpeech(said, branch.kind === 'mixed' ? 'aside' : 'off_script');
  }

  /**
   * Wait for the child to answer a direct question.
   *
   * No recognizer is created or destroyed here — the ear is already listening and
   * has been since the session began. This just says who the next complete turn
   * belongs to. Resolves null if they say nothing at all.
   */
  private waitForReply(waitForStartMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve(null);
        return;
      }

      // They already answered — over the top of the question. Never make a child
      // who spoke first say it again.
      if (this.pendingSpeech) {
        const early = this.pendingSpeech;
        this.pendingSpeech = null;
        resolve(early);
        return;
      }

      let settled = false;
      const finish = (text: string | null) => {
        if (settled) return;
        settled = true;
        if (this.replyTimeout) clearTimeout(this.replyTimeout);
        this.replyTimeout = null;
        this.awaitingReply = null;
        resolve(text);
      };

      this.awaitingReply = finish;

      // If they are mid-sentence when this is called, whatever they are saying is
      // the answer — do not start a no-answer countdown over the top of it.
      const alreadyTalking = this.turnSegments.length > 0 || Date.now() < this.childSpeakingUntil;
      if (alreadyTalking) return;

      // Do not start the clock until our own audio has finished: a window that
      // expires while the child is still being spoken to is not a window.
      const gateDelay = Math.max(0, this.gateOpenAt - Date.now());
      this.replyTimeout = setTimeout(() => {
        // One more check — they may have started talking during the wait.
        if (this.turnSegments.length > 0 || Date.now() < this.childSpeakingUntil) {
          this.replyTimeout = setTimeout(() => finish(null), QUIET_PATIENT_MS + 1_000);
          return;
        }
        finish(null);
      }, gateDelay + waitForStartMs);
    });
  }

  /** Give up on a pending answer (an on-screen tap arrived instead). */
  private stopWaitingForReply() {
    this.awaitingReply?.(null);
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

  /**
   * Mic frames from the browser. They never stop arriving and they always reach
   * the conversation layer — there is no state in which the child is not heard.
   *
   * The half-duplex rule (PLAN.md §8.2) survives where it matters: while we are
   * speaking, and for the speaker tail afterwards, nothing reaches pronunciation
   * assessment. Scoring a child against a line while our own voice is in the
   * microphone is the failure that rule exists to prevent, and it still cannot
   * happen. Going deaf was never the point.
   */
  onAudio(pcm: Buffer) {
    if (this.closed) return;

    this.voice?.write(pcm);

    if (this.isSpeaking) return; // never score over our own voice
    if (Date.now() < this.gateOpenAt) return; // nor over the speaker tail
    if (this.mode === 'CHILD_READS' || this.mode === 'COACH') {
      this.pron?.write(pcm);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    if (this.turnTimer) clearTimeout(this.turnTimer);
    if (this.replyTimeout) clearTimeout(this.replyTimeout);
    this.clearUnheard();
    // Anything awaiting a reply must not hang once the socket is gone.
    this.awaitingReply?.(null);
    this.speaking?.cancel();
    await Promise.all([this.pron?.close(), this.voice?.close()]);
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
      // The child took the floor while this was waiting its turn. It was written
      // for a moment that has passed.
      if (generation !== this.speechGeneration) return;
      await this.speakNow(text, generation);
    } finally {
      release();
    }
  }

  private async speakNow(text: string, generation = this.speechGeneration): Promise<void> {
    if (!text.trim() || this.closed || !this.voice) return;

    // Never start a sentence on top of one of theirs. The child has priority,
    // and "priority" that only applies when it is convenient is not priority.
    await this.holdWhileChildSpeaks();
    if (this.closed) return;
    // Waiting for them to finish is exactly when what we were going to say stops
    // being the right thing to say. Check again on the way out of the hold.
    if (generation !== this.speechGeneration) return;

    this.isSpeaking = true;
    this.speakingText = text;
    this.speakingFirstAudioAt = 0;
    this.gateOpenAt = Number.MAX_SAFE_INTEGER; // no scoring over our own voice
    this.send({ t: 'tts_start' });
    this.send({ t: 'speak', text });
    this.log('narrator', text);

    // Count what actually leaves the server. When a founder reports "I can't hear
    // anything", this counter is the difference between a server-side and a
    // browser-side problem — and it costs one integer.
    const before = this.audioBytesOut;
    this.audioBytesAtSpeakStart = before;
    const started = Date.now();

    const handle = this.voice!.speak(text);
    this.speaking = handle;

    try {
      await handle.done;
      const bytes = this.audioBytesOut - before;
      const seconds = bytes / 2 / AUDIO.ttsSampleRate;
      if (bytes === 0) {
        console.error(
          `[voice] produced NO audio for "${text.slice(0, 50)}…" — run \`npm run realtime:check\``,
        );
      } else {
        console.log(`[voice] ${bytes} bytes (~${seconds.toFixed(2)}s audio) in ${Date.now() - started}ms`);
      }
      this.debug('lastTts', { bytes, seconds: Number(seconds.toFixed(2)), firstChunkMs: -1 });
    } finally {
      this.speaking = null;
      this.isSpeaking = false;
      this.speakingText = '';
      this.speakingFirstAudioAt = 0;
      // Keep the gate shut for the audio tail so we don't score our own voice.
      this.gateOpenAt = Date.now() + AUDIO.gateTailMs;
      this.send({ t: 'tts_end' });
      this.lastSpeechAt = Date.now();
    }
  }

  /**
   * Does the child currently have the floor?
   *
   * True while they are audibly mid-sentence, and while a turn of theirs is open
   * but not yet classified. The second half matters: between "they stopped
   * talking" and "we know whether that was reading or a request to stop" is
   * exactly the window in which the assessment layer used to pipe up with
   * "let's sound it out" over a child who had just asked to be finished.
   */
  private childHasFloor(): boolean {
    return Date.now() < this.childSpeakingUntil || this.turnSegments.length > 0;
  }

  /**
   * Wait until the child has stopped talking.
   *
   * The one rule this enforces: the AI never talks over the child. A reply being
   * ready is not a reason to start speaking — them being quiet is. The cap exists
   * only so a stuck partial cannot mute the narrator forever.
   */
  private async holdWhileChildSpeaks(): Promise<void> {
    const until = Date.now() + MAX_HOLD_MS;
    while (!this.closed && this.childHasFloor() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /**
   * The child has taken the floor. Everything we were about to say is void.
   *
   * Not just the sentence in the air — the queued ones too. A coach line written
   * three seconds ago, before they said "I don't want to read any more", is
   * about a moment that no longer exists, and speaking it is how the app ends up
   * explaining pronunciation to a child who just asked to stop.
   */
  private yieldFloor(reason: string) {
    if (this.isSpeaking) this.stopSpeaking();
    else this.speechGeneration += 1;
    this.debug('yieldedFloor', reason);
  }

  /** Stop mid-word. Called the instant the child starts talking. */
  private stopSpeaking() {
    if (this.speaking) {
      this.speaking.cancel();
      this.speaking = null;
    }
    this.isSpeaking = false;
    this.speakingText = '';
    this.speakingFirstAudioAt = 0;
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
    // If the child takes the floor while this beat is being written or spoken,
    // everything after it belongs to a moment that no longer exists — including
    // handing them a passage to read.
    const generation = this.speechGeneration;
    const turn =
      opts.prefetched ??
      (await this.narrator.turn(mode, context, {
        mustMention: opts.mustMention,
        mustMentionAny: opts.mustMentionAny,
        weave: opts.weave,
        dialogue: this.dialogue,
      }));

    // Prepend rather than speak separately: one Cartesia context instead of two
    // (the free tier allows 2 concurrent), and it reads as a single natural
    // utterance rather than two clips butted together.
    if (opts.speakPrefix) turn.speak_text = `${opts.speakPrefix} ${turn.speak_text}`;
    this.beatIndex = turn.current_beat_index ?? this.beatIndex;
    this.debug('lastNarratorTurn', { mode, ...turn });

    await this.speak(turn.speak_text);
    if (this.closed || generation !== this.speechGeneration) return;

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
        { weave: fact?.text ?? null, dialogue: this.dialogue },
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

    // Scoring only. Whether the child MEANT to read this is not asked here and
    // must not be: this layer is strict on purpose, and the conversation layer
    // is already looking at the same words to decide whether anything they said
    // needs answering. An aside mixed into a line comes back from Azure as
    // Insertions, which the tracker discards (§9.4/§9.6), so talking mid-line
    // cannot corrupt a score either.
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
      const spoken = this.waitForReply(ANSWER_LISTEN_MS).then((text: string | null) => {
        if (text) this.log('child_talk', text);
        return parseYesNo(text);
      });

      const answer = await Promise.race([tapped, spoken]);
      this.answerFromUi = null;
      this.stopWaitingForReply();

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
  // Answering the child (PLAN.md §5)
  // -------------------------------------------------------------------------

  /**
   * Everything the child says that was not reading arrives here.
   *
   * One path for every route in — speaking up mid-passage, talking over the
   * narrator, or an aside in the middle of a line — so being heard never depends
   * on how they got our attention.
   *
   * One LLM call, not three. Working out what they meant and deciding what to say
   * back used to be a Haiku call, then a Sonnet call, then a Haiku safety pass,
   * all in series, before any audio could start: four to six seconds of silence
   * after a child said something. At five years old that is long enough to
   * conclude nobody is listening, which is the one thing this whole feature
   * exists to prevent.
   */
  private async handleChildSpeech(transcript: string, source: 'off_script' | 'barge_in' | 'aside') {
    if (this.closed) return;

    this.setMode(
      'TALK',
      source === 'barge_in' ? 'child interrupted' : source === 'aside' ? 'aside mid-line' : 'child spoke up',
    );
    this.log('child_talk', transcript);

    const currentWord =
      this.tracker && this.tracker.cursor < this.tracker.words.length
        ? this.tracker.words[this.tracker.cursor].expected
        : null;

    const askedAt = Date.now();

    // Start speaking the moment the sentence exists, rather than when the whole
    // structured object has finished generating. The intent and the fact are for
    // us; the child is only waiting on the words.
    //
    // Sensitive topics are the one thing that must NOT be improvised, so nothing
    // is spoken early until we know it is not one — that path uses a fixed
    // template (PLAN.md §5) and is worth the extra moment.
    const reply = await respondToChild({
      childName: this.child.name,
      transcript,
      currentPassage: this.tracker?.passage ?? null,
      currentWord,
      storyPremise: this.plan.premise,
      learned: this.facts.summaryLines(),
      dialogue: this.dialogue,
      socraticSoFar: this.socraticCount,
      socraticLimit: MAX_SOCRATIC_QUESTIONS,
      source,
      onReplyReady: async (speakText, intent) => {
        if (this.closed || this.mode === 'END') return false;
        // The one thing that is never improvised. A fixed comfort template
        // follows in actOnIntent; say nothing until then.
        if (intent === 'sensitive_topic') return false;
        this.debug('replyLatencyMs', Date.now() - askedAt);
        await this.speak(speakText);
        return true;
      },
    });

    this.debug('lastIntent', { transcript, intent: reply.intent, source, requestedTopic: reply.requestedTopic });
    this.send({ t: 'talk_closed', transcript, intent: reply.intent });

    // Remember before replying, so anything generated afterwards already knows it.
    this.rememberFact(reply.fact, reply.interestTopic, reply.factKind);

    await this.actOnIntent(reply.intent, transcript, reply, reply.alreadySpoken);
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

  /**
   * What happens next, given what they meant.
   *
   * The reply itself has already been written and is spoken immediately — this
   * decides only what the SESSION does afterwards. Which is the split that has
   * to hold: the model chose the words, code chooses the mode.
   */
  private async actOnIntent(
    intent: Intent,
    transcript: string,
    reply: ChildResponse,
    alreadySpoken = false,
  ) {
    /** The reply may already be in the air — never say it twice. */
    const sayReply = async () => {
      if (!alreadySpoken) await this.speak(reply.speakText);
    };

    switch (intent) {
      // Never improvised, never from the model, always flagged. PLAN.md §5.
      case 'sensitive_topic': {
        const character = this.plan.characters[0] ?? 'our friend';
        const line = T.sensitiveTopicLine(character);
        await this.flag('sensitive_topic', transcript);
        this.send({ t: 'flag', type: 'sensitive_topic', detail: transcript });
        this.log('narrator', line, { template: 'sensitive_topic' });
        // The generated reply is void here even if it has already been spoken —
        // this template is the answer, and it follows immediately.
        await this.speak(line);
        this.resumeReading();
        return;
      }

      case 'want_to_stop':
        await this.flag('early_exit', transcript);
        this.send({ t: 'flag', type: 'early_exit', detail: transcript });
        await this.end('child wants to stop');
        return;

      case 'change_request': {
        this.discardBuffer();
        this.setMode('REMIX', transcript);

        // Say something back BEFORE any of the story work. Rebuilding a plan is
        // seconds of silence, and they have just told us they are not enjoying it.
        await sayReply();

        // "I'm bored" is a change request with nothing to change to. Rebuilding
        // the story around the word "bored" is not an answer — asking them what
        // they would rather have is, and it is what a person would do.
        let topic = reply.requestedTopic?.trim() || null;
        if (!topic) {
          const favourite = this.favouriteTopic();
          // The reply almost certainly already asked; only add a prompt if not.
          if (!/\?/.test(reply.speakText)) await this.speak(T.whatWouldYouLikeLine(favourite));

          const said = await this.waitForReply(ANSWER_LISTEN_MS);
          if (said) {
            this.log('child_talk', said);
            this.send({ t: 'talk_closed', transcript: said, intent: 'change_request' });
            const answer = await respondToChild({
              childName: this.child.name,
              transcript: said,
              currentPassage: null,
              currentWord: null,
              storyPremise: this.plan.premise,
              learned: this.facts.summaryLines(),
              dialogue: this.dialogue,
              socraticSoFar: this.socraticCount,
              socraticLimit: MAX_SOCRATIC_QUESTIONS,
              source: 'off_script',
            });
            this.rememberFact(answer.fact, answer.interestTopic, answer.factKind);
            topic = answer.requestedTopic?.trim() || answer.interestTopic?.trim() || said;
          } else {
            // No answer. Their favourite thing is a far better guess than carrying
            // on with the story they just said they were bored of.
            topic = favourite;
          }
        }

        this.debug('remixTopic', topic);

        // Steer the REST of the story, not just the next beat. A child who asked
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

        await this.narrate(
          'REMIX',
          `The child said: "${transcript}". They want the story to be about: ${
            topic ?? 'something completely new'
          }. Rebuild the next beat around that — really change it, do not just mention it once. Keep difficulty ${this.plan.difficulty}, the same target skills, and the same must-use words: ${this.plan.vocab_constraints.must_use_words.join(', ')}.`,
        );
        return;
      }

      case 'question_about_story_or_world':
        // Counted here, in code, so the "three guiding questions then just tell
        // them" rule cannot drift (edge case #8). The reply already knows the
        // count and answered accordingly.
        this.socraticCount = this.socraticCount >= MAX_SOCRATIC_QUESTIONS ? 0 : this.socraticCount + 1;
        this.setMode('SOCRATIC', `question #${this.socraticCount}`);
        await sayReply();
        this.resumeReading();
        return;

      case 'chitchat':
        if (reply.interestTopic) {
          this.interestSignals.push(reply.interestTopic);
          this.debug('interestSignals', this.interestSignals);
        }
        await sayReply();
        this.resumeReading();
        return;

      // help_with_word, unclear, and anything else: say the reply and carry on.
      // There is no branch here that stays silent.
      default:
        await sayReply();
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
    // Whatever was queued was written for a session that is still going.
    this.yieldFloor(`ending: ${reason}`);
    this.setMode('END', reason);
    this.stopWaitingForReply();

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

    this.send({ t: 'listening', on: false });
    this.send({ t: 'ended', sessionId: this.sessionId ?? '' });
    await this.close();
  }
}
