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
import { looksMistranscribed } from '../lib/conversation';
import { actOn, asksSomething, decideTurn, STALL_ESCALATE, type TurnPurpose } from '../lib/turns';
import { cleanTopic, resolveTopic } from '../lib/topics';
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
  isFreshProfile,
  draftToNotes,
  draftToInterests,
  repeatsPrevious,
  type OnboardingDraft,
} from '../lib/profile';
import * as T from '../lib/templates';
import { PronunciationSession } from './azure';
import { RealtimeVoice } from './realtime';
import { speak as speakAloud, pcmSeconds, type SpeakHandle } from './tts';
import { PassageTracker, tokenize } from './tracker';
import {
  VoiceMachine,
  MIC_MAX_OPEN_MS,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceMode,
  type VoiceSnapshot,
} from '../lib/voice/machine';
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
const MAX_COACH_ATTEMPTS = 2;
const ADAPT_COACH_THRESHOLD = 3;
const MAX_SOCRATIC_QUESTIONS = 3;

/**
 * How long the session may sit with nobody taking a turn before it says
 * something.
 *
 * The old silence ladder hung off "we have not heard audio for N seconds",
 * which is now a different question entirely: the mic is shut most of the time
 * and hearing nothing is the normal state of the world. What actually signals a
 * child drifting away from the screen is that nobody has TAKEN A TURN — no tap,
 * no reading, nothing — since the last thing Ollie said.
 */
const IDLE_NUDGE_MS = 12_000;
const IDLE_CHECKIN_MS = 30_000;
const IDLE_PAUSE_MS = 50_000;

/**
 * How long to wait for a child to take a turn they have been asked for.
 *
 * Much longer than it used to be, and deliberately: this window now includes
 * finding the button and pressing it, not just deciding to speak. It only ever
 * runs out when a child does nothing at all, and waiting on a shy four-year-old
 * is much better than talking over them.
 */
const ONBOARDING_LISTEN_MS = 25_000;
const MAX_ONBOARDING_TURNS = 6;
/** How long to wait for "yes, keep going" before asking again. */
const ANSWER_LISTEN_MS = 20_000;

/** How much of the back-and-forth both the responder and the narrator can see. */
const DIALOGUE_MEMORY = 10;

/**
 * If the browser never reports that playback drained, assume it did.
 *
 * The browser owns "Ollie has finished speaking", because only it knows when the
 * last sample was actually heard. That is right, but it means a dropped message
 * would strand the session in AI_SPEAKING with the mic shut forever. So the
 * server also estimates the duration from the bytes it sent and moves on a
 * beat later if nothing arrives.
 */
const DRAIN_FALLBACK_MARGIN_MS = 1_500;

/**
 * How long to let pronunciation assessment catch up after a reading turn closes.
 *
 * Azure and the transcription model are two services racing on the same audio,
 * and either can answer first. Deciding what to say before scoring has landed
 * would mean coaching a child on a word they had already read correctly.
 */
/**
 * How many turns may vanish before we stop reopening the mic and say so.
 *
 * Two, because the first is a glitch and the second is a pattern. Beyond that,
 * reopening is not recovery — it is a loop with a child inside it.
 */
const MAX_LOST_TURNS = 3;

const SCORING_GRACE_MS = 900;
const SCORING_QUIET_MS = 350;

/**
 * Events the browser cannot produce for itself, and therefore has to be told.
 *
 * Its own taps, drain reports and silence detection are applied there first —
 * that is what makes a barge-in instant — so echoing those back would replay
 * them twice against the same mirror.
 */
const SERVER_ORIGIN_EVENTS = new Set<VoiceEvent['t']>([
  'AI_SPEECH_START',
  'TRANSCRIPT_FINAL',
  'RESPONSE_READY',
  'ERROR',
  'RECOVER',
  'MODE_CHANGE',
  'SESSION_END',
]);

export class Session {
  private mode: Mode = 'IDLE';
  private sessionId: string | null = null;
  private narrator!: Narrator;
  private plan!: SessionPlan;

  private tracker: PassageTracker | null = null;

  /**
   * Two layers, two jobs, no contention.
   *
   * `voice` is the ear: one Realtime transcription connection, open from the
   * first moment of the session to the last, but fed audio ONLY between a mic
   * opening and closing. It no longer decides anything about turns — the button
   * does that — so what it returns is one transcript per turn, on demand.
   *
   * `pron` is the assessment layer: created per passage, strict, and only ever
   * asked how well the words on screen were said. Both get the same audio.
   */
  private voice: RealtimeVoice | null = null;
  private pron: PronunciationSession | null = null;

  /**
   * The one owner of who holds the floor.
   *
   * Nothing in this file opens the mic, cancels the voice, or decides a turn is
   * over on its own. Everything goes through here, which is what makes "the mic
   * is open and Ollie is speaking" not a bug we have to be careful about but a
   * state that cannot be represented.
   */
  private machine!: VoiceMachine;

  private speaking: SpeakHandle | null = null;
  /** Running total of TTS bytes sent, so one utterance can be measured. */
  private audioBytesOut = 0;
  private audioBytesAtSpeakStart = 0;
  /** Resolves when the utterance in the air has finished, whichever way. */
  private speechSettled: (() => void) | null = null;
  private drainFallback: NodeJS.Timeout | null = null;
  /** Tail of the utterance queue — see speak(). */
  private speechChain: Promise<void> = Promise.resolve();
  /** Fires if a committed turn never produces a transcript. */
  private watchdog: NodeJS.Timeout | null = null;
  /** Committed turns that produced nothing, in a row. Reset by any that does. */
  private lostTurns = 0;

  /**
   * Segments of the turn currently being held open.
   *
   * A turn can produce more than one transcript if it was committed in pieces,
   * and the child owns when it ends, so these accumulate until the machine says
   * the turn is closed.
   */
  private turnText = new Map<number, string>();
  /** Something the child said with nothing yet waiting to receive it. */
  private pendingSpeech: string | null = null;

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
  /**
   * What scoring wants said, once the floor comes back.
   *
   * Nothing can be said DURING a reading turn — the child's mic is open — so
   * these are recorded as they are noticed and acted on in `afterReadingTurn`.
   */
  private pendingCoach: number | null = null;
  private pendingCelebration: number | null = null;
  /** When Azure last returned words, so we know when it has gone quiet. */
  private scoredAt = 0;
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

  /**
   * What the child's next turn is FOR, and the question it answers.
   *
   * Set only by `expect`, which is reached only by handing the floor over, so a
   * turn cannot exist without a declared purpose. `lib/turns.ts` explains why
   * that matters: a question the state machine does not know about is a
   * conversational obligation nobody is holding, and its answer comes back as a
   * brand new conversation. Nine times, in one observed session.
   */
  private expecting: TurnPurpose = 'FREE';
  private outstandingQuestion: string | null = null;

  /**
   * Turns since the child last moved forward through a passage.
   *
   * The general stall guard. Every other counter here — lostTurns,
   * coachEventsThisPassage, socraticCount, nudgeStage — guards a specific named
   * failure, which is why an unnamed one ran forever.
   */
  private turnsWithoutProgress = 0;

  /** Set when something is waiting for the child's next turn (onboarding, check-in). */
  private awaitingReply: ((text: string | null) => void) | null = null;
  private replyTimeout: NodeJS.Timeout | null = null;
  private answerFromUi: ((value: 'yes' | 'no') => void) | null = null;
  private stashedAnswer: 'yes' | 'no' | null = null;

  /** When the child last took a turn. The idle ladder measures from here. */
  private lastTurnAt = Date.now();
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
    // No first-audible timestamp any more. It existed so barge-in could ignore
    // "the child started talking" for 400ms after they first heard us, because
    // echo cancellation adapting to a new sound was the most reliable false
    // trigger there was. A thumb on a button is never a false trigger.
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

    // The pedagogical mode and the turn-taking mode are different dimensions
    // that happen to move together: every mode except onboarding is a story
    // being read, and a story being read is where the system takes over opening
    // and closing the child's turns for them.
    const voiceMode = this.voiceModeFor(mode);
    if (this.machine && this.machine.mode !== voiceMode) {
      this.machine.send({ t: 'MODE_CHANGE', mode: voiceMode });
    }
  }

  private debug(key: string, value: unknown) {
    this.send({ t: 'debug', key, value });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start() {
    this.tick = setInterval(() => this.onTick(), 500);

    // The floor arbiter comes up before anything can ask to speak.
    this.machine = new VoiceMachine({
      mode: 'ONBOARDING',
      onEffect: (effect) => this.applyVoiceEffect(effect),
      onChange: (snapshot, event) => this.onVoiceChange(snapshot, event),
      onIgnored: (event, why, kind) => {
        // Never silent. A refused request in particular is a line that will
        // now never be said, and the reason belongs in the debug panel.
        this.debug(kind === 'rejected' ? 'voiceRejected' : 'voiceNoop', { event: event.t, why });
      },
      onViolation: (violations, snapshot, event) => {
        // Unreachable by design; loud if it ever happens, because every one of
        // these means the mic could be live while Ollie is talking.
        console.error(
          `[voice] INVARIANT BROKEN on ${event.t}: ${violations.join('; ')}`,
          JSON.stringify(snapshot),
        );
        this.debug('voiceInvariant', { event: event.t, violations });
      },
    });

    // Connect FIRST, before anything is said, so the ear is ready the instant a
    // child reaches for the button. It is fed audio only between a mic opening
    // and closing — the connection stays up for the whole session, the turns
    // inside it are the child's.
    this.voice = new RealtimeVoice({
      onTranscript: (turnId, text) => this.onTranscript(turnId, text),
      onPartial: (turnId, text) => this.debug('partial', { turnId, text }),
      onError: (m) => {
        console.error('[realtime]', m);
        this.send({ t: 'error', message: m });
        this.machine.send({ t: 'ERROR', message: m, from: 'stt' });
      },
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
    // No handoff: the story's first beat follows immediately, so the floor
    // stays with Ollie right through the greeting and into narration.
    const greeting = this.speak(handoff, { handoff: null });

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
    await this.speak(T.helloStrangerLine(), { handoff: null });

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

      // Onboarding is manual at both ends (the interaction spec), so nothing
      // here ever opens the mic — the child does, when they are ready.
      await this.speak(line, { handoff: null });
      lastSaid = line;
      if (this.closed) return '';

      // We just asked them something. We wait. Every time.
      heard = await this.waitForReply(ONBOARDING_LISTEN_MS);
      if (heard) {
        this.log('child_talk', heard);
        silences = 0;
      } else if (++silences >= 2) {
        // Twice with no answer. Start anyway.
        //
        // This used to require a name before giving up, which meant a session
        // where the microphone or transcription was broken asked all six
        // questions into silence — a minute and a half before any story
        // appeared, which reads as the app being dead. If we cannot hear them,
        // asking again will not help; a story on screen at least gives them
        // something to do, and something to talk to us about.
        console.warn('[onboarding] no answers — starting without a full profile');
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
  // The floor: one machine, one owner
  // -------------------------------------------------------------------------

  /**
   * Carry out one decision the state machine has already made.
   *
   * Note what is NOT here: any judgement. Nothing in this method asks whether
   * the mic should open or whether the child has finished — those were settled
   * by a pure function before it was called. This is only the wiring.
   */
  private applyVoiceEffect(effect: VoiceEffect) {
    switch (effect.t) {
      case 'open_mic':
        this.turnText.delete(effect.turnId);
        this.voice?.beginTurn(effect.turnId);
        this.lastTurnAt = Date.now();
        this.nudgeStage = 0;
        break;

      case 'close_mic':
        if (effect.commit) this.voice?.commit(effect.turnId);
        else this.voice?.discard(effect.turnId);
        this.lastTurnAt = Date.now();
        break;

      // Silence detection lives in the browser, next to the audio, and is armed
      // by the machine rather than by whoever opened the mic. That is what makes
      // "only armed when autoCloseArmed" true by construction instead of by
      // convention — there is no other code path that can turn it on.
      case 'arm_auto_close':
      case 'disarm_auto_close':
        break;

      // The turn is committed and we are waiting on words. If they never come,
      // the session would sit in PROCESSING with the mic shut and the child
      // looking at a screen that has stopped responding — which is the one
      // failure they cannot do anything about.
      case 'arm_watchdog':
        if (this.watchdog) clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => {
          this.watchdog = null;
          void this.onTurnLost(effect.turnId);
        }, effect.ms);
        break;

      case 'disarm_watchdog':
        if (this.watchdog) clearTimeout(this.watchdog);
        this.watchdog = null;
        break;

      case 'start_tts':
        void this.streamSpeech(effect.utteranceId, effect.text);
        break;

      case 'cancel_tts':
        this.cancelSpeech();
        break;

      // Nothing to do here, and that is the point. Aborting the request stops us
      // SENDING audio, but the browser is still holding a second or two of it —
      // and it drops that itself, from the same transition, in the same frame as
      // the tap. Round-tripping the flush would put 30-80ms of Ollie still
      // talking between a child's thumb and silence.
      case 'flush_playback':
        break;

      case 'process_turn':
        void this.onTurnClosed(effect.turnId, effect.text);
        break;

      case 'drop_turn':
        this.turnText.delete(effect.turnId);
        this.debug('turnDropped', { turnId: effect.turnId, reason: effect.reason });
        break;
    }
  }

  /**
   * Tell the browser what just happened.
   *
   * Only events the browser could not have known about are forwarded. Its own
   * taps, its own drain reports and its own silence detection are applied there
   * first — that is what makes a barge-in instant — so echoing them back would
   * replay them twice.
   */
  private onVoiceChange(snapshot: VoiceSnapshot, event: VoiceEvent) {
    // The utterance is out of the air — drained, cancelled or lost. Whoever is
    // awaiting `speak()` gets to continue, and gets to find out from the machine
    // whether what they wanted to do next still makes sense.
    if (snapshot.state !== 'AI_SPEAKING' && this.speechSettled) {
      const settle = this.speechSettled;
      this.speechSettled = null;
      settle();
    }

    if (SERVER_ORIGIN_EVENTS.has(event.t)) this.send({ t: 'voice_event', event });
    this.send({ t: 'voice_sync', snapshot });
    this.debug('voice', {
      state: snapshot.state,
      mode: snapshot.mode,
      mic: snapshot.mic,
      speaking: snapshot.speaking?.text.slice(0, 60) ?? null,
      pendingTurnId: snapshot.pendingTurnId,
      superseded: snapshot.superseded,
    });
  }

  /**
   * Declare what the child's next turn is for.
   *
   * The ONE place `expecting` is written. Reached from `speak({ handoff })` and
   * from `handFloorToChild`, which between them are the only two ways a child
   * ever gets a turn — so there is no path to an undeclared one.
   */
  private expect(purpose: TurnPurpose, question?: string | null) {
    this.expecting = purpose;
    // Kept so the answer is not read in a vacuum. The responder was writing
    // replies to "sure" with no idea what "sure" was agreeing to.
    this.outstandingQuestion = purpose === 'ANSWER' ? (question?.trim() || null) : null;
    this.debug('expecting', { purpose, question: this.outstandingQuestion });
  }

  /**
   * Hand the floor over without speaking first, saying what the turn is for.
   *
   * Replaces every bare `FLOOR_TO_CHILD`. A hand-over is the moment the purpose
   * is knowable and the last moment it is knowable, so it is declared here.
   */
  private handFloorToChild(purpose: TurnPurpose, question?: string | null) {
    this.expect(purpose, question);
    this.machine.send({ t: 'FLOOR_TO_CHILD' });
  }

  /** Which turn-taking dimension the pedagogical mode implies. */
  private voiceModeFor(mode: Mode): VoiceMode {
    return mode === 'ONBOARDING' || mode === 'IDLE' ? 'ONBOARDING' : 'STORY';
  }

  // -------------------------------------------------------------------------
  // Events from the child's side of the glass
  // -------------------------------------------------------------------------

  /**
   * The button. The entire interaction model rests on this one event.
   *
   * There is nothing to interpret: it opens the mic, or it closes it, and which
   * of those it does depends only on the state we are already in. The barge-in
   * case is not special-cased anywhere — a tap during AI_SPEAKING cancels the
   * voice because that is what the transition table says, not because something
   * noticed we were talking.
   */
  private onMicTap() {
    if (this.closed || !this.machine) return;
    this.machine.send({ t: 'MIC_TAP' });
  }

  /** Armed silence detection fired in the browser. Ignored unless armed here. */
  private onSpeechEndDetected(turnId: number) {
    if (this.closed || !this.machine) return;
    this.machine.send({ t: 'SPEECH_END_DETECTED', turnId });
  }

  /**
   * The last sample of an utterance has actually been heard.
   *
   * In story mode this is what opens the mic for the child's reading turn, which
   * is exactly why it has to come from the browser: the server stopped sending
   * this audio seconds ago, and opening the mic then would have put Ollie's own
   * voice into pronunciation assessment.
   */
  private onPlaybackDrained(utteranceId: number) {
    if (this.closed || !this.machine) return;
    if (this.drainFallback) {
      clearTimeout(this.drainFallback);
      this.drainFallback = null;
    }
    this.machine.send({ t: 'AI_SPEECH_END', utteranceId });
  }

  /**
   * A committed turn never produced any words.
   *
   * Recovering means opening the mic again, which is right once and catastrophic
   * forever: an earlier version did exactly that with no counter, and a single
   * desynchronised turn had it reopening the microphone every twelve seconds,
   * silently, for the rest of the session. The child sees a button that keeps
   * turning green and an owl that never says anything.
   *
   * So a retry is offered twice, out loud, and then the loop stops and the floor
   * is left with the child. A session waiting to be tapped is recoverable; a
   * session talking to itself on a timer is not.
   */
  private async onTurnLost(turnId: number) {
    if (this.closed || !this.machine) return;

    // The turn moved on while this timer was in flight. Recovery is for a turn
    // that is genuinely still waiting; firing it for one that has already been
    // answered costs the child an "I didn't catch that" in the middle of a
    // conversation that was working.
    if (this.machine.snapshot.pendingTurnId !== turnId) {
      this.debug('staleWatchdog', { turnId, pending: this.machine.snapshot.pendingTurnId });
      return;
    }

    // Whatever upstream still thinks it owes us for this turn, it does not.
    this.voice?.abandon(turnId);
    this.lostTurns += 1;
    console.warn(
      `[voice] turn ${turnId} never came back (${this.lostTurns} in a row) — recovering`,
    );
    this.debug('turnLost', { turnId, consecutive: this.lostTurns });

    this.machine.send({ t: 'ERROR', message: 'Ollie did not catch that', from: 'stt' });
    this.machine.send({ t: 'RECOVER' });

    if (this.lostTurns >= MAX_LOST_TURNS) {
      // Stop. Say so, once, in words a child can act on, and then wait.
      this.send({ t: 'flag', type: 'needs_help', detail: `${this.lostTurns} turns produced no transcript` });
      await this.flag('needs_help', 'transcription is not returning anything');
      await this.speak(T.cannotHearLine(), { handoff: null });
      return;
    }

    await this.speak(T.didNotCatchLine(), { handoff: null });
    // Whatever they say next is fair game: they are repeating themselves, and
    // we do not know whether the lost turn was reading or talking.
    this.handFloorToChild('FREE');
  }

  /**
   * A turn's words came back.
   *
   * Always arrives, for every committed turn, including empty ones — a turn that
   * never resolves is a session stuck in PROCESSING with the mic shut, which is
   * the one failure a child cannot do anything about.
   */
  private onTranscript(turnId: number, text: string) {
    if (this.closed || !this.machine) return;
    // Transcription is working. Whatever went wrong before is over.
    if (text.trim()) this.lostTurns = 0;
    const merged = [this.turnText.get(turnId) ?? '', text].join(' ').replace(/\s+/g, ' ').trim();
    this.turnText.set(turnId, merged);
    this.machine.send({ t: 'TRANSCRIPT_FINAL', turnId, text: merged });
  }

  /**
   * The child's turn is closed and transcribed. Now, and only now, decide what
   * it was.
   *
   * `branchUtterance` still runs, because "did they read the line or say
   * something to me" is a genuinely different question from "have they
   * finished" — the button answered the second one, not the first.
   */
  private async onTurnClosed(turnId: number, text: string) {
    this.turnText.delete(turnId);
    this.lastTurnAt = Date.now();
    this.nudgeStage = 0;

    // Counted BEFORE the turn is acted on, and cleared by `onWords` the moment
    // the cursor actually moves. Anything else — an answer, an aside, a silent
    // turn — leaves it climbing, which is the point: this counter measures the
    // one thing the session is for, and nothing else resets it.
    this.turnsWithoutProgress += 1;

    // They took a turn and said nothing in it. Not an error and not worth a
    // reply: let the idle ladder offer help if it keeps happening.
    if (!text.trim()) {
      this.debug('emptyTurn', turnId);
      this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: false });
      if (this.awaitingReply) {
        const waiter = this.awaitingReply;
        this.awaitingReply = null;
        if (this.replyTimeout) clearTimeout(this.replyTimeout);
        waiter(null);
      }
      return;
    }

    // Something asked them a direct question and is waiting for the answer.
    if (this.awaitingReply) {
      const waiter = this.awaitingReply;
      this.awaitingReply = null;
      if (this.replyTimeout) clearTimeout(this.replyTimeout);
      this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: true });
      waiter(text);
      return;
    }

    await this.routeTurn(turnId, text);
  }

  /**
   * Reading, talking, or both?
   *
   * Deliberately NOT a guess about intent — a comparison against the words on
   * screen. Scoring is the assessment layer's job either way; the only question
   * here is whether anything the child said also needs an answer.
   */
  private async routeTurn(turnId: number, text: string) {
    if (this.closed || this.mode === 'END') {
      this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: false });
      return;
    }

    // The model heard a language nobody was speaking.
    //
    // Never route this to the responder. A transcript with nothing Latin in it
    // shares no words with the passage, so it reads as conversation, and
    // answering it means answering a hallucination in the middle of a story.
    // Scoring is unaffected either way: Azure has the same audio, always as
    // en-US, and is the only thing that decides how the reading went.
    if (looksMistranscribed(text)) {
      console.warn(`[session] turn ${turnId} came back in the wrong script: "${text}"`);
      this.debug('mistranscribed', text);
      this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: false });
      // Mid-passage this was almost certainly them reading it, so treat it as
      // reading and let scoring have the last word.
      if (this.tracker && !this.tracker.isComplete()) await this.afterReadingTurn();
      else this.handFloorToChild('FREE');
      return;
    }

    // What was that turn? Decided by what the turn was FOR, not by the words
    // alone — see lib/turns.ts. An answer to our own question is read plainly
    // and never compared against the line.
    const decision = decideTurn({
      text,
      purpose: this.expecting,
      passage: this.tracker?.passage ?? null,
      turnsWithoutProgress: this.turnsWithoutProgress,
    });
    this.debug('turn', {
      text,
      purpose: this.expecting,
      kind: decision.kind,
      yesNo: decision.yesNo,
      stalled: decision.stalled,
      turnsWithoutProgress: this.turnsWithoutProgress,
      reason: decision.reason,
    });

    // What to DO about it, decided by the same pure policy the self-test drives
    // over thousands of scripted conversations. Nothing below chooses; it only
    // carries out.
    const outcome = actOn(decision);
    this.debug('turnOutcome', outcome);

    switch (outcome.t) {
      case 'wait':
        this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: false });
        return;

      // Scoring already has the audio; what happens next — coach, celebrate, or
      // carry on — is decided once, in afterReadingTurn.
      case 'score':
        this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: false });
        await this.afterReadingTurn();
        return;

      case 'check_in':
        this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: true });
        this.log('child_talk', decision.said);
        await this.checkIn('they said no');
        return;

      // Agreement, or a conversation that has gone round twice. Either way the
      // answer is the same and it is not a sentence: give them the line.
      case 'give_line':
        this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: true });
        this.log('child_talk', decision.said);
        this.send({ t: 'talk_closed', transcript: decision.said, intent: 'chitchat' });
        if (this.tracker && !this.tracker.isComplete()) {
          if (decision.stalled) {
            await this.speak(T.backToTheLineLine(this.currentWord()), { handoff: 'READ' });
          } else {
            this.resumeReading();
          }
        } else {
          await this.nextBeat();
        }
        return;

      case 'break_stall':
        this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: true });
        await this.breakStall(outcome.why);
        return;

      case 'reply':
        break;
    }

    // Nothing to answer with yet — still onboarding or still planning. Hold it
    // so the next thing that listens picks it up instead of losing it.
    if (!this.plan || !this.narrator) {
      this.pendingSpeech = outcome.said;
      this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: false });
      return;
    }

    this.machine.send({ t: 'RESPONSE_READY', turnId, willSpeak: true });

    // `alsoScore` means the reading half of the same breath still needs an
    // answer of its own, so the aside is handled WITHOUT giving the floor back.
    const mixed = outcome.alsoScore;
    await this.handleChildSpeech(outcome.said, mixed ? 'aside' : 'off_script', { holdFloor: mixed });

    if (mixed && !this.closed && (this.mode === 'CHILD_READS' || this.mode === 'COACH')) {
      await this.afterReadingTurn();
    }
  }

  /** The word they are on, for a line that has to name it. */
  private currentWord(): string | null {
    if (!this.tracker || this.tracker.cursor >= this.tracker.words.length) return null;
    return this.tracker.words[this.tracker.cursor].expected;
  }

  /**
   * Nothing is moving. Stop talking about it.
   *
   * Deterministic and terminal by construction: it says one templated line with
   * no question in it, resets the counter, and hands over a reading turn — or,
   * if even that has been tried, moves the story on and tells a grown-up. There
   * is no branch here that can ask anything, which is the only reliable way to
   * leave a loop made of questions.
   */
  private async breakStall(why: string) {
    console.warn(`[session] breaking a stall: ${why}`);
    this.debug('stallBroken', { why, turnsWithoutProgress: this.turnsWithoutProgress });
    this.send({ t: 'flag', type: 'needs_help', detail: `stalled: ${why}` });
    await this.flag('needs_help', `stalled: ${why}`);

    const counted = this.turnsWithoutProgress;
    this.turnsWithoutProgress = 0;

    // Still a line in front of them, and they have not been given it plainly.
    if (this.tracker && !this.tracker.isComplete() && counted < STALL_ESCALATE) {
      await this.speak(T.backToTheLineLine(this.currentWord()), { handoff: 'READ' });
      return;
    }

    // Talking about it has failed. Change what is in front of them.
    this.discardBuffer();
    await this.speak(T.movingOnLine(), { handoff: null });
    await this.nextBeat();
  }

  /**
   * Wait for the child to take a turn.
   *
   * No recognizer is created or destroyed here, and nothing is armed: this only
   * says who the next completed turn belongs to. What it now also waits for is
   * the child reaching for the button, which is why the windows around it got
   * considerably longer. Resolves null if they never do.
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

      // Do not start the clock while the child still has the floor, or while we
      // are still talking to them: a window that expires mid-sentence, theirs or
      // ours, is not a window.
      const armCountdown = () => {
        if (this.closed) return finish(null);
        if (this.machine.micIsOpen || this.machine.state === 'PROCESSING') {
          this.replyTimeout = setTimeout(armCountdown, 1_000);
          return;
        }
        if (this.machine.isSpeaking) {
          this.replyTimeout = setTimeout(armCountdown, 300);
          return;
        }
        this.replyTimeout = setTimeout(() => {
          if (this.machine.micIsOpen || this.machine.state === 'PROCESSING') {
            this.replyTimeout = setTimeout(armCountdown, 1_000);
            return;
          }
          finish(null);
        }, waitForStartMs);
      };
      armCountdown();
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
      case 'mic_tap':
        this.onMicTap();
        break;
      case 'speech_end':
        this.onSpeechEndDetected(msg.turnId);
        break;
      case 'playback_drained':
        this.onPlaybackDrained(msg.utteranceId);
        break;
      case 'answer':
        // Tapped rather than spoken. Stash it if nothing is waiting yet, so a
        // fast tap during the question is not thrown away.
        if (this.answerFromUi) this.answerFromUi(msg.value);
        else this.stashedAnswer = msg.value;
        break;
      case 'resume':
        if (this.mode === 'PAUSED') {
          this.lastTurnAt = Date.now();
          this.nudgeStage = 0;
          this.setMode('CHILD_READS', 'resumed');
        }
        break;
      case 'stop':
        await this.end('child asked to stop');
        break;
      case 'tts_test':
        // Exercises the real audio path — TTS -> WebSocket -> Web Audio — with
        // no LLM involved, so "can I hear anything at all?" is one click.
        await this.speak(
          "Hello! This is Ollie testing the sound. If you can hear me, the audio is working.",
          { handoff: null },
        );
        break;
      case 'ping':
        break;
    }
  }

  /**
   * Mic frames from the browser.
   *
   * These only exist while the mic is open — the browser does not send them
   * otherwise — so the half-duplex rule (PLAN.md §8.2) no longer needs a gate,
   * a tail timer, or a guard window. Scoring a child against a line while our
   * own voice is in the room was the failure that rule existed to prevent, and
   * it is now structurally impossible: the mic being open and Ollie speaking are
   * the same machine's mutually exclusive states.
   *
   * The check below is the second lock on that door, not the first.
   */
  onAudio(pcm: Buffer) {
    if (this.closed) return;
    if (!this.machine?.micIsOpen) return;

    this.voice?.write(pcm);

    if (this.mode === 'CHILD_READS' || this.mode === 'COACH') {
      this.pron?.write(pcm);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.tick) clearInterval(this.tick);
    if (this.replyTimeout) clearTimeout(this.replyTimeout);
    if (this.drainFallback) clearTimeout(this.drainFallback);
    if (this.watchdog) clearTimeout(this.watchdog);
    this.machine?.send({ t: 'SESSION_END' });
    // Anything awaiting a reply must not hang once the socket is gone.
    this.awaitingReply?.(null);
    this.speaking?.cancel();
    this.speechSettled?.();
    await Promise.all([this.pron?.close(), this.voice?.close()]);
  }

  // -------------------------------------------------------------------------
  // Speaking
  // -------------------------------------------------------------------------

  /**
   * Say something, if the floor is ours.
   *
   * Returns false when the machine refused — which happens for exactly one
   * reason, and it is the important one: the child has the mic open. The line is
   * then DROPPED, not queued. A sentence written before the child took the floor
   * is about a moment that has passed, and delivering it the instant they stop
   * talking is how the app ends up explaining pronunciation to someone who just
   * asked to be finished.
   *
   * `handoff` says whether the floor passes to the child when this ends, AND
   * what their turn is then for. `null` keeps the floor. A TurnPurpose hands it
   * over and declares the purpose in the same breath, which is the point: there
   * is no way to give a child a turn without saying what it is for, so nobody
   * can forget to. The same trick `autoCloseArmed` uses.
   *
   * In story mode this is what auto-opens the mic for their turn; it is the
   * caller's call because only the caller knows whether another line follows.
   */
  private async speak(text: string, opts: { handoff: TurnPurpose | null }): Promise<boolean> {
    // Declared BEFORE the words go out. The child can answer the instant they
    // hear it, and a purpose set afterwards would be set after the answer.
    if (opts.handoff) this.expect(opts.handoff, text);
    if (!text.trim() || this.closed) return false;

    const previous = this.speechChain;
    let release!: () => void;
    this.speechChain = new Promise<void>((r) => (release = r));
    try {
      await previous;
      if (this.closed) return false;

      const utteranceId = this.machine.snapshot.nextUtteranceId;

      // Armed BEFORE the transition, not after. `machine.send` runs its effects
      // and its onChange synchronously, so a tap landing in the same tick would
      // otherwise resolve a promise that did not exist yet — and this method
      // would wait forever for an utterance that was already cancelled.
      const settled = new Promise<void>((resolve) => {
        this.speechSettled = resolve;
      });

      const outcome = this.machine.send({
        t: 'AI_SPEECH_START',
        utteranceId,
        text,
        handoff: opts.handoff !== null,
      });
      if (outcome.rejected) {
        this.speechSettled = null;
        return false;
      }

      this.log('narrator', text);
      // Resolves when the utterance leaves the air, whichever way it goes:
      // drained normally, cancelled by a tap, or lost to an error.
      await settled;
      return true;
    } finally {
      release();
    }
  }

  /**
   * Stream one utterance to the browser. Called only by the `start_tts` effect.
   */
  private async streamSpeech(utteranceId: number, text: string) {
    const before = this.audioBytesOut;
    this.audioBytesAtSpeakStart = before;
    const started = Date.now();

    const handle = speakAloud(text, (pcm) => this.sendAudio(pcm));
    this.speaking = handle;

    try {
      await handle.done;
    } catch (err) {
      console.error('[voice] tts failed', err);
      this.machine.send({ t: 'ERROR', message: 'the voice stopped working', from: 'tts' });
      return;
    }

    // Cancelled: the machine has already moved on and something else owns the
    // floor now. Reporting the end of an utterance nobody is waiting for would
    // be a stale AI_SPEECH_END, which the table ignores anyway — but not
    // sending it keeps the log honest.
    if (this.speaking !== handle) return;
    this.speaking = null;

    const bytes = this.audioBytesOut - before;
    const seconds = pcmSeconds(bytes);
    if (bytes === 0) {
      console.error(
        `[voice] produced NO audio for "${text.slice(0, 50)}…" — run \`npm run realtime:check\``,
      );
    } else {
      console.log(
        `[voice] ${bytes} bytes (~${seconds.toFixed(2)}s audio) in ${Date.now() - started}ms`,
      );
    }
    this.debug('lastTts', { bytes, seconds: Number(seconds.toFixed(2)), totalSent: this.audioBytesOut });

    // Every sample is sent. The browser tells us when the last one has been
    // HEARD (`playback_drained`), which is the signal that actually ends the
    // utterance. This is only the backstop for a client that never reports.
    this.send({ t: 'tts_complete', utteranceId });
    if (this.drainFallback) clearTimeout(this.drainFallback);
    this.drainFallback = setTimeout(
      () => {
        this.drainFallback = null;
        console.warn(`[voice] no drain report for utterance ${utteranceId} — assuming it played`);
        this.machine.send({ t: 'AI_SPEECH_END', utteranceId });
      },
      seconds * 1000 + DRAIN_FALLBACK_MARGIN_MS,
    );
  }

  /** Stop mid-word. Called by the `cancel_tts` effect, and by nothing else. */
  private cancelSpeech() {
    if (this.speaking) {
      this.speaking.cancel();
      this.speaking = null;
    }
    if (this.drainFallback) {
      clearTimeout(this.drainFallback);
      this.drainFallback = null;
    }
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
    // handing them a passage to read. The machine's generation counter is what
    // says so: it moves every time the floor changes hands.
    const generation = this.machine.generation;
    const turn =
      opts.prefetched ??
      (await this.narrator.turn(mode, context, {
        mustMention: opts.mustMention,
        mustMentionAny: opts.mustMentionAny,
        weave: opts.weave,
        dialogue: this.dialogue,
      }));

    // Prepend rather than speak separately: one request instead of two, and it
    // reads as a single natural utterance rather than two clips butted together.
    if (opts.speakPrefix) turn.speak_text = `${opts.speakPrefix} ${turn.speak_text}`;
    this.beatIndex = turn.current_beat_index ?? this.beatIndex;
    this.debug('lastNarratorTurn', { mode, ...turn });

    const passage = turn.child_passage?.trim() || null;
    const closing = mode === 'CLOSING';

    // Set the passage up BEFORE the beat is spoken, not after.
    //
    // The mic opens the instant the last sample is heard, so anything that has
    // to exist for the child's reading turn has to exist before then — the
    // tracker, the scoring session, the mode. Doing it afterwards left a window,
    // however small, in which the mic was live and the first thing they read had
    // nowhere to be scored. Nothing about this is visible early: no audio can
    // reach scoring while Ollie is talking, and the browser holds the passage on
    // screen until his voice has finished.
    if (passage && !closing && opts.after !== 'hold') this.preparePassage(passage);

    // `handoff` is the whole of "the mic opens when the passage ends", and it
    // now carries WHAT the turn is for. A passage is a reading turn; `hold`
    // means the caller asked something and is waiting on an answer. Getting
    // these two the wrong way round is how an answer gets scored as a misread,
    // or a read line gets replied to.
    const handoff: TurnPurpose | null = closing
      ? null
      : passage
        ? 'READ'
        : opts.after === 'hold'
          ? 'ANSWER'
          : null;
    await this.speak(turn.speak_text, { handoff });
    if (this.closed || generation !== this.machine.generation) return;

    // The caller is running a conversation (a check-in) and decides what happens
    // next itself.
    if (opts.after === 'hold') return;

    if (passage) {
      this.beginScoring();
    } else if (closing) {
      await this.finishEnd();
    } else {
      // A conversational turn with no passage — go back to whatever they were reading.
      if (this.tracker && !this.tracker.isComplete()) {
        this.resumeReading();
      } else {
        await this.nextBeat();
      }
    }
  }

  /**
   * Everything the child's reading turn needs, ready before Ollie stops talking.
   *
   * Split out of the old `startPassage` for one reason: the mic now opens on the
   * last audible sample of the beat, so this all has to have happened by then.
   * It is safe to do early — no audio can reach scoring while the mic is shut,
   * and the browser holds the words back until his voice has finished.
   */
  private preparePassage(passage: string) {
    void this.pron?.close();
    this.pron = null;

    this.tracker = new PassageTracker(passage);
    this.coachAttempts.clear();
    this.celebrated.clear();
    this.coachEventsThisPassage = 0;
    this.nudgeStage = 0;
    this.turnsWithoutProgress = 0;
    this.lastTurnAt = Date.now();

    this.log('child_passage', passage);
    this.send({ t: 'passage', text: passage, words: tokenize(passage) });
    this.send({ t: 'cursor', index: 0 });

    this.pron = new PronunciationSession(passage, {
      onPartial: (text) => {
        this.lastTurnAt = Date.now();
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
  }

  /** The beat has been heard and the mic is live. Start writing the next one. */
  private beginScoring() {
    this.lastTurnAt = Date.now();
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

  /**
   * Azure has scored some of what the child just read.
   *
   * Scoring and the on-screen state only. This method used to also SPEAK — a
   * coaching line the moment a word came back low, a celebration the moment a
   * hard word landed — and it cannot any more, because the child's mic is open
   * for the whole of their reading turn and nothing may talk over it.
   *
   * That is not a limitation being worked around; it is the interaction model
   * asserting itself. Ollie interrupting a five-year-old mid-sentence to correct
   * their pronunciation was only ever possible because both of us could talk at
   * once. What the child gets instead is to finish their line, and then be
   * helped with the word — which is what a person sitting next to them would do.
   *
   * So this records what needs saying, and `afterReadingTurn` says it once the
   * floor comes back.
   */
  private async onWords(words: any[], recognized: string) {
    if (!this.tracker || this.closed) return;
    if (this.mode !== 'CHILD_READS' && this.mode !== 'COACH') return;

    this.lastTurnAt = Date.now();
    this.nudgeStage = 0;
    this.scoredAt = Date.now();
    this.debug('azureRecognized', recognized);

    // Whether the child MEANT to read this is not asked here and must not be:
    // this layer is strict on purpose, and the transcript of the same turn is
    // branched separately to decide whether anything they said needs answering.
    // An aside mixed into a line comes back from Azure as Insertions, which the
    // tracker discards (§9.4/§9.6), so talking mid-line cannot corrupt a score.
    const before = this.tracker.cursor;
    const result = this.tracker.ingest(words);
    this.debug('lastWords', this.tracker.summary());

    // Forward progress through the line — the one thing that clears the stall
    // counter. Not "the child took a turn", not "somebody said something":
    // words on the screen actually got read.
    if (this.tracker.cursor > before) this.turnsWithoutProgress = 0;

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

    // A word they were stuck on and just got right. Worth marking, and it is
    // still templated so it lands the instant the floor comes back rather than
    // after a round trip.
    const wonBack = result.updates.find(
      (u) =>
        u.word.status === 'passed' &&
        (this.coachAttempts.get(u.index) ?? 0) > 0 &&
        !this.celebrated.has(u.index),
    );
    if (wonBack) this.pendingCelebration = wonBack.index;
    if (result.needsCoaching !== null) this.pendingCoach = result.needsCoaching;

    // Every word of the line, read. That is the end of the reading turn, known
    // from its CONTENT rather than from silence — and known sooner, because it
    // does not have to wait out the silence threshold first. Same close, same
    // commit, same rules: only ever for a turn the system armed.
    if (result.complete) {
      const mic = this.machine.snapshot.mic;
      if (mic?.autoCloseArmed) {
        this.debug('turnEndedByContent', { turnId: mic.turnId });
        this.machine.send({ t: 'SPEECH_END_DETECTED', turnId: mic.turnId });
      }
    }
  }

  /**
   * The reading turn is over and the floor is ours. Now say something about it.
   *
   * One place decides what follows a reading turn, and it runs after the turn is
   * closed and classified rather than in the middle of it.
   */
  private async afterReadingTurn() {
    if (this.closed || !this.tracker) return;
    if (this.mode !== 'CHILD_READS' && this.mode !== 'COACH') return;

    // Azure and the transcription model are two services racing on the same
    // audio, and either can answer first. Give scoring a moment to finish
    // before concluding the child did not finish the line — deciding on a
    // half-arrived score would coach them on a word they had already read.
    await this.waitForScoring();
    if (this.closed || !this.tracker) return;

    const celebrate = this.pendingCelebration;
    const coachIndex = this.pendingCoach;
    this.pendingCelebration = null;
    this.pendingCoach = null;

    if (celebrate !== null && !this.celebrated.has(celebrate)) {
      this.celebrated.add(celebrate);
      const word = this.tracker.words[celebrate];
      this.log('coach', `celebrated "${word.expected}"`, { word: word.expected });
      await this.speak(T.gotItLine(word.expected), {
        handoff: this.tracker.isComplete() ? null : 'READ',
      });
    }

    if (this.tracker.isComplete()) {
      await this.onPassageComplete();
      return;
    }

    if (coachIndex !== null) {
      await this.coach(coachIndex);
      return;
    }

    // They stopped part-way through with nothing to help them with. Hand the
    // floor straight back so they can carry on: making a child ask permission to
    // continue a sentence they were half-way through is absurd.
    this.handFloorToChild('READ');
  }

  /**
   * Wait briefly for pronunciation assessment to catch up.
   *
   * Returns as soon as the passage is complete, or once scoring has been quiet
   * for a moment, or at the cap — whichever is first.
   */
  private async waitForScoring() {
    const deadline = Date.now() + SCORING_GRACE_MS;
    while (!this.closed && Date.now() < deadline) {
      if (this.tracker?.isComplete()) return;
      if (this.scoredAt && Date.now() - this.scoredAt > SCORING_QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 50));
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
      // Only hand over if there is still something to read.
      await this.speak(line, { handoff: this.tracker.isComplete() ? null : 'READ' });

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
    // Back to the same word: `handoff` reopens the mic the moment this lands,
    // so the retry needs no press. Coaching used to interrupt them mid-line;
    // now it waits for them to finish, which is what a person would do.
    await this.speak(line, { handoff: 'READ' });

    this.setMode('CHILD_READS');
    this.lastTurnAt = Date.now();
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
      if (attempt === 0) await this.speak(T.continueRepromptLine(), { handoff: 'ANSWER' });
    }
    return null;
  }

  private async continueStory() {
    if (this.closed) return;

    // Say yes out loud before doing any work — extending the plan is an LLM call,
    // and the child has just committed to more reading.
    // More story is being written: Ollie keeps the floor through the wait.
    await this.speak(T.keepGoingLine(), { handoff: null });

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
  private async handleChildSpeech(
    transcript: string,
    source: 'off_script' | 'barge_in' | 'aside',
    opts: { holdFloor?: boolean } = {},
  ) {
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
        // The reply lands first; whatever happens next (a fixed template, a
        // resync, going back to the passage) decides who gets the floor.
        await this.speak(speakText, { handoff: null });
        return true;
      },
    });

    this.debug('lastIntent', { transcript, intent: reply.intent, source, requestedTopic: reply.requestedTopic });
    this.send({ t: 'talk_closed', transcript, intent: reply.intent });

    // Remember before replying, so anything generated afterwards already knows it.
    this.rememberFact(reply.fact, reply.interestTopic, reply.factKind);

    await this.actOnIntent(reply.intent, transcript, reply, reply.alreadySpoken, opts.holdFloor === true);
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
    /** The caller still has something to say about this turn. Keep the floor. */
    holdFloor = false,
  ) {
    /** The reply may already be in the air — never say it twice. */
    const sayReply = async () => {
      if (!alreadySpoken) await this.speak(reply.speakText, { handoff: null });
    };

    /**
     * Hand the floor back, saying what the reply just obliged them to do.
     *
     * The last leak in the one rule, closed. The responder writes the words and
     * is free to end them with a question — and until now nothing downstream
     * knew, so the answer arrived as a brand new conversation, was matched
     * against a line it shared no words with, and came back to the responder,
     * which asked again. Nine times, in the session that prompted this.
     *
     * The model still chooses the words. Whether those words created an
     * obligation is read off them here, in code, before the floor moves.
     */
    const handBack = () => {
      if (holdFloor) return;
      const asked = asksSomething(reply.speakText);
      this.resumeReading(true, asked ? 'ANSWER' : 'READ', asked ? reply.speakText : null);
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
        await this.speak(line, { handoff: null });
        // The comfort template is the answer, and it ends with a question of
        // its own ("Should we find out what happens to...?").
        if (!holdFloor) this.resumeReading(true, 'ANSWER', line);
        return;
      }

      case 'want_to_stop':
        await this.flag('early_exit', transcript);
        this.send({ t: 'flag', type: 'early_exit', detail: transcript });
        await this.end('child wants to stop');
        return;

      // "I can't see anything." Take it literally and fix it.
      //
      // A child reporting that the thing is broken used to land in `unclear`,
      // which answered "Hmm, I didn't catch that!" — telling a five-year-old
      // that their clear, correct description of a real problem was their
      // mistake. It is the most useful thing they can possibly say.
      case 'needs_help': {
        await this.flag('needs_help', transcript);
        this.send({ t: 'flag', type: 'needs_help', detail: transcript });
        await sayReply();
        this.resync();
        handBack();
        return;
      }

      case 'change_request': {
        this.discardBuffer();
        this.setMode('REMIX', transcript);

        // Say something back BEFORE any of the story work. Rebuilding a plan is
        // seconds of silence, and they have just told us they are not enjoying it.
        await sayReply();

        // What they asked for, read from every source we have — including their
        // own words, which is the one that used to be thrown away. The responder
        // returns `requested_topic: null` whenever it judges a request too vague
        // to act on, and "change the topic to something religious" is exactly
        // that: vague to a schema, perfectly clear to a person.
        const favourite = this.favouriteTopic();
        let topic = resolveTopic({
          requested: reply.requestedTopic,
          interest: reply.interestTopic,
          transcript,
        });

        // "I'm bored" is a change request with nothing to change to. Rebuilding
        // the story around the word "bored" is not an answer — asking them what
        // they would rather have is, and it is what a person would do.
        //
        // ONCE. Whatever comes back, the next thing that happens is a story: a
        // child who has been asked what they want twice has been heard neither
        // time, and the second question is the one that makes it feel like
        // nobody is listening.
        if (!topic) {
          // The reply almost certainly already asked; only add a prompt if not.
          // Either way the floor has to change hands — a question nobody can
          // answer without hunting for the button is a question we did not
          // really ask. The reply itself was spoken with the floor held.
          if (!/\?/.test(reply.speakText)) {
            await this.speak(T.whatWouldYouLikeLine(favourite), { handoff: 'ANSWER' });
          } else {
            this.handFloorToChild('ANSWER', reply.speakText);
          }

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
            // `said` used to be the last resort here, which is how "no
            // preference, pick any" became the subject of a story — and a
            // narrator handed that as a subject asks what they meant.
            topic = resolveTopic({
              requested: answer.requestedTopic,
              interest: answer.interestTopic,
              transcript: said,
              favourite,
            });
          } else {
            // No answer. Their favourite thing is a far better guess than carrying
            // on with the story they just said they were bored of.
            topic = cleanTopic(favourite);
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

        // With no subject the narrator is told to PICK one, never to ask. It is
        // the only writer left in the loop at this point, and a beat that comes
        // back as a third question is how a child ends up having said what they
        // wanted three times and read nothing.
        const direction = topic
          ? `They want the story to be about: ${topic}. Rebuild the next beat around that — really change it, do not just mention it once.`
          : `They did not name a subject, so choose a completely new one yourself and commit to it. Do NOT ask them what they would like — they have already been asked.`;

        await this.narrate(
          'REMIX',
          `The child said: "${transcript}". ${direction} Keep difficulty ${this.plan.difficulty}, the same target skills, and the same must-use words: ${this.plan.vocab_constraints.must_use_words.join(', ')}.`,
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
        handBack();
        return;

      case 'chitchat':
        if (reply.interestTopic) {
          this.interestSignals.push(reply.interestTopic);
          this.debug('interestSignals', this.interestSignals);
        }
        await sayReply();
        handBack();
        return;

      // help_with_word, unclear, and anything else: say the reply and carry on.
      // There is no branch here that stays silent.
      default:
        await sayReply();
        handBack();
        return;
    }
  }

  /**
   * Push the whole visible state down again.
   *
   * A dropped message, a reconnect, a caption that never landed — any of them
   * leave a child looking at a screen with nothing on it, and they have no way
   * to fix that except to tell us. So when they do, we say everything again
   * rather than assuming the client already knows it.
   */
  private resync() {
    this.send({ t: 'mode', mode: this.mode });
    if (this.plan) this.send({ t: 'ready', childName: this.child.name, plan: this.plan });
    if (this.tracker) {
      this.send({
        t: 'passage',
        text: this.tracker.passage,
        words: tokenize(this.tracker.passage),
      });
      for (const w of this.tracker.words) {
        this.send({ t: 'word', index: w.index, status: w.status, score: w.bestScore, errorType: w.errorType });
      }
      this.send({ t: 'cursor', index: this.tracker.cursor });
    }
    // Who has the floor is part of the visible state, and the most important
    // part: a child looking at a mic button that disagrees with the server has
    // no way to get un-stuck.
    this.send({ t: 'voice_sync', snapshot: this.machine.snapshot });
    this.debug('resync', { passage: this.tracker?.passage ?? null, mode: this.mode });
  }

  /**
   * Return to the passage the child was on, restarting assessment on it.
   *
   * `handOver` is false in exactly one situation: an aside mixed into a line,
   * where the reading half still has a coaching line waiting to be said. Opening
   * the mic there would refuse that line, because nothing may speak over an open
   * mic — so the caller keeps the floor and hands it over when it is done.
   */
  private resumeReading(handOver = true, purpose: TurnPurpose = 'READ', question?: string | null) {
    if (this.closed || this.mode === 'END') return;

    // Nothing to go back to. The floor must STILL change hands: a reply that
    // ends with the mic shut and nobody speaking is a session waiting to be
    // rescued by a five-year-old finding a button, and it used to be reachable
    // by saying anything at all after finishing a passage.
    if (!this.tracker || this.tracker.isComplete()) {
      if (handOver) this.handFloorToChild(purpose === 'READ' ? 'FREE' : purpose, question);
      return;
    }

    const passage = this.tracker.passage;
    if (!this.pron) {
      this.pron = new PronunciationSession(passage, {
        onPartial: (text) => {
          this.lastTurnAt = Date.now();
          this.nudgeStage = 0;
          this.debug('azurePartial', text);
        },
        onWords: (words, recognized) => void this.onWords(words, recognized),
        onError: (m) => console.error('[azure]', m),
      });
    }
    this.setMode('CHILD_READS', 'back to the story');
    this.lastTurnAt = Date.now();
    this.nudgeStage = 0;
    this.send({ t: 'cursor', index: this.tracker.cursor });

    // Their turn again. Said out loud rather than inferred: the last thing
    // spoken here was an answer to a question, not a passage, so the utterance's
    // own handoff flag was false and something has to hand the floor over.
    if (handOver) this.handFloorToChild(purpose, question);
  }

  // -------------------------------------------------------------------------
  // Timers: the idle ladder
  // -------------------------------------------------------------------------

  /**
   * Has the child gone away?
   *
   * This used to be a silence ladder — no audio for 8s, 20s, 45s — which no
   * longer means anything, because the mic is shut most of the time and hearing
   * nothing is now the ordinary state of the world. Silence is not the signal.
   *
   * What is: nobody has taken a turn. No tap, no reading, no answer, since the
   * last thing Ollie said. That is the same question the old ladder was really
   * asking, phrased in terms of something the new model can actually observe.
   *
   * The ladder never runs while the child holds the floor. It cannot: speaking
   * over an open mic is refused by the machine, so at worst a nudge would be
   * dropped — but not asking is better than asking and being refused.
   */
  private onTick() {
    if (this.closed) return;

    // The backstop, and deliberately NOT turn detection.
    //
    // Onboarding never closes the mic on silence, because a child pausing to
    // think keeps their turn. But "never" and "forever" are different promises:
    // nothing may speak while the mic is open, so a child who taps and then
    // wanders off would otherwise mute the session permanently. This is the
    // only thing that closes a manual turn, and it is a minute and a half long
    // precisely so that no child thinking about an answer ever meets it.
    const mic = this.machine?.snapshot.mic;
    if (mic && !mic.autoCloseArmed && Date.now() - mic.openedAt > MIC_MAX_OPEN_MS) {
      console.warn(`[voice] turn ${mic.turnId} open for ${MIC_MAX_OPEN_MS}ms — closing it`);
      this.debug('micTimedOut', { turnId: mic.turnId });
      this.machine.send({ t: 'MIC_TAP' });
      return;
    }

    if (this.machine.state !== 'IDLE' && this.machine.state !== 'MIC_OPEN') return;
    if (this.mode !== 'CHILD_READS') return;

    // Their mic is open and they are working on it. The auto-close detector owns
    // this turn; nagging into a live microphone is exactly wrong.
    if (this.machine.micIsOpen) return;

    const idle = Date.now() - this.lastTurnAt;

    if (idle > IDLE_PAUSE_MS && this.nudgeStage < 3) {
      this.nudgeStage = 3;
      this.setMode('PAUSED', 'nobody has taken a turn for 50s');
      void this.speak(T.pausedLine(), { handoff: null });
      return;
    }
    if (idle > IDLE_CHECKIN_MS && this.nudgeStage < 2) {
      this.nudgeStage = 2; // never nag more than twice
      this.send({ t: 'nudge', text: 'checking in' });
      void this.speak(T.stillThereLine(), { handoff: 'ANSWER' });
      return;
    }
    if (idle > IDLE_NUDGE_MS && this.nudgeStage < 1) {
      this.nudgeStage = 1;
      const w = this.tracker?.words[this.tracker.cursor];
      if (w) {
        this.send({ t: 'nudge', text: 'gentle prompt' });
        // Hands the floor back with the nudge, so a child who was waiting for
        // permission gets a live mic rather than another thing to press.
        void this.speak(T.silenceNudge(w.expected), { handoff: 'READ' });
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
    this.setMode('END', reason);
    this.stopWaitingForReply();

    await this.pron?.close();
    this.pron = null;

    // Stopped before there was a story — during onboarding, or while the plan was
    // still being written. There is nothing to wrap up, so say goodbye kindly.
    if (!this.narrator) {
      await this.speak(T.goodbyeLine(this.child.name || 'friend', 'Come back and read with me soon!'), {
        handoff: null,
      });
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
    // Only now. `end()` deliberately leaves the machine alive so the closing
    // line can be spoken — ENDED refuses every request to speak, goodbye
    // included, and a session that ends in silence is not an ending.
    this.machine?.send({ t: 'SESSION_END' });

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
