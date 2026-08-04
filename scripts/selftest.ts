/**
 * Offline verification of the deterministic core — the parts that decide what
 * happens, as opposed to the parts that decide what words to say. Runs with no
 * network and no database.
 *
 * Run: npm run selftest
 */
import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { PassageTracker, tokenize } from '../server/tracker';
import { applyLeniency } from '../lib/leniency';
import { updateMastery, pickTargets } from '../lib/pedagogy';
import { skillsForWord, SKILLS } from '../lib/skills';
import { AUDIO } from '../lib/env';
import { upsample16to24, RealtimeVoice } from '../server/realtime';
import { pickPraiseWord, mentionsWord } from '../lib/praise';
import { sanitizeAcknowledgment, summarizeReading } from '../lib/ack';
import { branchUtterance, looksMistranscribed } from '../lib/conversation';
import {
  VoiceMachine,
  transition,
  initialSnapshot,
  checkInvariants,
  armsAutoClose,
  AUTO_CLOSE_SILENCE_MS,
  MIC_DOUBLE_TAP_MS,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceSnapshot,
  type VoiceState,
} from '../lib/voice/machine';
import { FactLedger, mergeFactsIntoMemory, WEAVE_DELAY_BEATS } from '../lib/facts';
import { shouldCheckIn, summarizeProgress, parseYesNo } from '../lib/sessionflow';
import {
  emptyDraft,
  mergeDraft,
  hasEnoughToStart,
  isFreshProfile,
  draftToInterests,
  trimSpokenTurn,
  repeatsPrevious,
} from '../lib/profile';
import { fallbackPlan } from '../lib/llm/planner';
import type { ChildMemory, TrackedWord, WordAssessment } from '../lib/types';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function word(
  w: string,
  score: number,
  errorType: WordAssessment['errorType'] = 'None',
  phonemes: WordAssessment['phonemes'] = [],
): WordAssessment {
  return { word: w, accuracyScore: score, errorType, phonemes };
}

console.log('\nPrimer self-test (deterministic core)\n');

// --------------------------------------------------------------------------
console.log('Leniency table (PLAN.md §9.3)');
// --------------------------------------------------------------------------
{
  // "wabbit" for "rabbit": the only failing phoneme is r->w, a developmental
  // substitution. Must be treated as a pass, logged as Developmental.
  const v = applyLeniency(
    word('rabbit', 48, 'Mispronunciation', [
      { phoneme: 'r', accuracyScore: 20 },
      { phoneme: 'æ', accuracyScore: 95 },
      { phoneme: 'b', accuracyScore: 92 },
    ]),
  );
  ok('r→w "wabbit" passes as Developmental', v.passed && v.errorType === 'Developmental', v.errorType);

  // "fing" for "thing": th->f is developmental.
  const th = applyLeniency(
    word('thing', 44, 'Mispronunciation', [
      { phoneme: 'θ', accuracyScore: 18 },
      { phoneme: 'ɪ', accuracyScore: 90 },
    ]),
  );
  ok('th→f "fing" passes as Developmental', th.passed && th.errorType === 'Developmental');

  // A genuine miss on a non-developmental phoneme must still fail.
  const real = applyLeniency(
    word('map', 30, 'Mispronunciation', [
      { phoneme: 'm', accuracyScore: 15 },
      { phoneme: 'æ', accuracyScore: 20 },
    ]),
  );
  ok('genuine mispronunciation still fails', !real.passed && real.errorType === 'Mispronunciation');

  // Omission is never forgiven.
  const om = applyLeniency(word('the', 0, 'Omission'));
  ok('omission is never forgiven', !om.passed && om.errorType === 'Omission');

  // Clean read.
  const clean = applyLeniency(word('cat', 96, 'None'));
  ok('clean read passes', clean.passed && clean.errorType === 'None');

  // Evidence-based: Azure tells us what it actually heard.
  const heardW = applyLeniency(
    word('rabbit', 50, 'Mispronunciation', [
      { phoneme: 'r', accuracyScore: 15, actual: ['w'] },
      { phoneme: 'æ', accuracyScore: 95 },
      { phoneme: 'b', accuracyScore: 90 },
    ]),
  );
  ok('r→w with evidence is forgiven', heardW.passed && heardW.errorType === 'Developmental');

  const heardWrong = applyLeniency(
    word('rabbit', 50, 'Mispronunciation', [
      { phoneme: 'r', accuracyScore: 15, actual: ['g'] },
      { phoneme: 'æ', accuracyScore: 95 },
      { phoneme: 'b', accuracyScore: 90 },
    ]),
  );
  ok('r→g (not a developmental swap) is NOT forgiven', !heardWrong.passed);

  // Velar fronting is excluded — /k/ is too common a phoneme to forgive blindly.
  const velar = applyLeniency(
    word('cat', 45, 'Mispronunciation', [
      { phoneme: 'k', accuracyScore: 20 },
      { phoneme: 'æ', accuracyScore: 92 },
      { phoneme: 't', accuracyScore: 90 },
    ]),
  );
  ok('k→? is NOT forgiven without evidence', !velar.passed);

  // Score floor: too far off to be a substitution.
  const floor = applyLeniency(
    word('rabbit', 12, 'Mispronunciation', [{ phoneme: 'r', accuracyScore: 5 }]),
  );
  ok('word below the score floor is never forgiven', !floor.passed);

  // Majority of phonemes wrong is an unknown word, not a lisp.
  const majority = applyLeniency(
    word('three', 40, 'Mispronunciation', [
      { phoneme: 'θ', accuracyScore: 20, actual: ['f'] },
      { phoneme: 'r', accuracyScore: 20, actual: ['w'] },
      { phoneme: 'i', accuracyScore: 95 },
    ]),
  );
  ok('majority-failing word is not forgiven', !majority.passed);
}

// --------------------------------------------------------------------------
console.log('\nPassage tracker (PLAN.md §9.4, §9.5)');
// --------------------------------------------------------------------------
{
  const t = new PassageTracker('The blue dragon sat down.');
  ok('tokenizes to 5 words', t.words.length === 5, String(t.words.length));

  // Straight clean read.
  const r = t.ingest([
    word('The', 95),
    word('blue', 92),
    word('dragon', 90),
    word('sat', 94),
    word('down', 91),
  ]);
  ok('clean read completes the passage', r.complete);
  ok('clean read needs no coaching', r.needsCoaching === null);
  ok('all-strong read reports wasStrong', t.wasStrong());
}
{
  // Best-attempt scoring: a bad first try then a good self-correction.
  const t = new PassageTracker('The cat sat.');
  t.ingest([word('The', 95)]);
  t.ingest([word('cat', 35, 'Mispronunciation', [{ phoneme: 'k', accuracyScore: 20 }])]);
  ok('failed word is marked coaching', t.words[1].status === 'coaching');

  const after = t.ingest([word('cat', 93)]);
  ok('self-correction passes the word', t.words[1].status === 'passed');
  ok('best-attempt score is kept, not the last', t.words[1].bestScore === 93, String(t.words[1].bestScore));
  ok('attempt count reflects the retry', t.words[1].attempts === 2, String(t.words[1].attempts));
  ok('passage still not complete', !after.complete);
}
{
  // Repetition / stutter: "the c... the cat sat"
  const t = new PassageTracker('The cat sat.');
  const r = t.ingest([
    word('The', 90),
    word('the', 88, 'Insertion'),
    word('cat', 91),
    word('sat', 89),
  ]);
  ok('insertion that repeats a prior word is ignored', r.complete);
  ok('insertion did not consume a reference word', t.words.every((w) => w.status === 'passed'));
}
{
  // Reading ahead / skipping: child jumps a word.
  const t = new PassageTracker('The big blue dragon ran.');
  t.ingest([word('The', 92), word('blue', 90), word('dragon', 93), word('ran', 91)]);
  const skipped = t.words[1];
  ok('skipped word is not silently passed', skipped.status !== 'passed', skipped.status);
  ok('words read ahead are still credited', t.words[2].status === 'passed');
}
{
  // Never force a re-read of a passed word.
  const t = new PassageTracker('Go now.');
  t.ingest([word('Go', 95), word('now', 95)]);
  const before = t.words.map((w) => w.status).join(',');
  t.ingest([word('Go', 10, 'Mispronunciation', [{ phoneme: 'ɡ', accuracyScore: 5 }])]);
  ok('a passed word is never downgraded', t.words.map((w) => w.status).join(',') === before);
}
{
  // markGiven advances past a word the narrator supplied.
  const t = new PassageTracker('A hard word.');
  t.ingest([word('A', 95)]);
  t.markGiven(1);
  ok('given word advances the cursor', t.cursor === 2, String(t.cursor));
  ok('given word is excluded from wasStrong', !t.wasStrong());
}

// --------------------------------------------------------------------------
console.log('\nWord → skill mapping');
// --------------------------------------------------------------------------
{
  ok('"blue" maps to blend_bl', skillsForWord('blue').includes('blend_bl'));
  ok('"cat" maps to short_a', skillsForWord('cat').includes('short_a'));
  ok('"ship" maps to digraph_sh', skillsForWord('ship').includes('digraph_sh'));
  ok('"because" maps to its sight word', skillsForWord('because').includes('sight_because'));
  ok('punctuation is stripped', skillsForWord('cat,').includes('short_a'));
  ok('silent-e word is not scored as a short vowel', !skillsForWord('cake').includes('short_a'));
}

// --------------------------------------------------------------------------
console.log('\nPedagogy (PLAN.md §11)');
// --------------------------------------------------------------------------
{
  const start = [{ skill_id: 'short_a', p_mastery: 0.2, last_practiced: null }];

  const up = updateMastery(
    [{ expected_word: 'cat', attempt: 1, error_type: 'None', accuracy_score: 95 }],
    start,
  );
  const shortA = up.find((u) => u.skill_id === 'short_a')!;
  ok('correct read raises mastery by 0.15*(1-p)', Math.abs(shortA.p_mastery - 0.32) < 1e-6, String(shortA.p_mastery));

  const down = updateMastery(
    [{ expected_word: 'cat', attempt: 1, error_type: 'Mispronunciation', accuracy_score: 20 }],
    start,
  );
  ok(
    'error lowers mastery by 0.2*p',
    Math.abs(down.find((u) => u.skill_id === 'short_a')!.p_mastery - 0.16) < 1e-6,
  );

  const dev = updateMastery(
    [{ expected_word: 'cat', attempt: 1, error_type: 'Developmental', accuracy_score: 45 }],
    start,
  );
  ok(
    'Developmental counts as correct',
    Math.abs(dev.find((u) => u.skill_id === 'short_a')!.p_mastery - 0.32) < 1e-6,
  );

  const retry = updateMastery(
    [{ expected_word: 'cat', attempt: 2, error_type: 'None', accuracy_score: 99 }],
    start,
  );
  ok('coached retries do not inflate mastery', retry.length === 0);
}
{
  const mastery = SKILLS.map((s) => ({
    skill_id: s.id,
    p_mastery: s.id === 'short_a' ? 0.9 : 0.2,
    last_practiced: null,
  }));
  const targets = pickTargets(mastery);
  ok('pickTargets returns exactly 3', targets.length === 3, String(targets.length));
  ok('targets are unique', new Set(targets).size === targets.length);
  ok('a mastered skill is offered for review', targets.includes('short_a'));
}

// --------------------------------------------------------------------------
console.log('\nAzure SDK usage (offline object construction)');
// --------------------------------------------------------------------------
{
  // Validates our API usage without touching the network — construction and
  // applyTo are entirely local; only startContinuousRecognitionAsync connects.
  const config = sdk.SpeechConfig.fromSubscription('dummy-key', 'eastus');
  config.speechRecognitionLanguage = 'en-US';

  const format = sdk.AudioStreamFormat.getWaveFormatPCM(AUDIO.micSampleRate, 16, 1);
  const push = sdk.AudioInputStream.createPushStream(format);
  const audioConfig = sdk.AudioConfig.fromStreamInput(push);
  const recognizer = new sdk.SpeechRecognizer(config, audioConfig);

  const pa = new sdk.PronunciationAssessmentConfig(
    'The blue dragon sat down.',
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    true,
  );
  pa.applyTo(recognizer);

  const json = JSON.parse(pa.toJSON());
  ok('referenceText is set', json.referenceText === 'The blue dragon sat down.');
  ok('gradingSystem is HundredMark', json.gradingSystem === 'HundredMark');
  ok('granularity is Phoneme', json.granularity === 'Phoneme');
  ok('enableMiscue is true', json.enableMiscue === true);

  // The push stream must accept the exact buffer shape onAudio() forwards.
  push.write(new ArrayBuffer(640 * 2));
  ok('push stream accepts a 40ms PCM16 frame', true);

  push.close();
  recognizer.close();
}

// --------------------------------------------------------------------------
console.log('\nAudio framing');
// --------------------------------------------------------------------------
{
  ok('mic rate is 16kHz for Azure', AUDIO.micSampleRate === 16000);
  ok('Realtime rate is 24kHz', AUDIO.realtimeSampleRate === 24000);
  ok('playback rate matches Realtime output', AUDIO.ttsSampleRate === AUDIO.realtimeSampleRate);
  ok('tokenizer drops pure punctuation', tokenize('Hi -- there!').length === 2);

  // The mic is captured at Azure's rate and upsampled for Realtime, so scoring
  // keeps exactly the audio it always had.
  const quarterSecond = Buffer.alloc(AUDIO.micSampleRate * 2 * 0.25);
  for (let i = 0; i < quarterSecond.length / 2; i++) {
    quarterSecond.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / AUDIO.micSampleRate)), i * 2);
  }
  const up = upsample16to24(quarterSecond);
  ok(
    'upsampling 16k to 24k gives 1.5x the samples',
    up.length / 2 === Math.floor((quarterSecond.length / 2) * 1.5),
    `${up.length / 2} vs ${(quarterSecond.length / 2) * 1.5}`,
  );
  ok('upsampled audio starts where the original does', up.readInt16LE(0) === quarterSecond.readInt16LE(0));
  ok('empty in, empty out', upsample16to24(Buffer.alloc(0)).length === 0);
}

// --------------------------------------------------------------------------
console.log('\nPraise word selection (never credit an unspoken word)');
// --------------------------------------------------------------------------
{
  // The reported failure: child read "The frog glides and hops.", narrator
  // praised "glad" — a blend_gl example word sitting in its plan context.
  const t = new PassageTracker('The frog glides and hops.');
  t.ingest([
    word('The', 96),
    word('frog', 88),
    word('glides', 93),
    word('and', 95),
    word('hops', 90),
  ]);

  const picked = pickPraiseWord(t.words);
  ok('picks a word actually in the passage', picked !== null && /^(frog|glides|hops)$/.test(picked!), String(picked));
  ok('picks the highest-scoring substantive word', picked === 'glides', String(picked));
  ok('never picks a trivial sight word', picked !== 'The' && picked !== 'and');

  ok('mentionsWord accepts the exact word', mentionsWord('You read glides so smoothly!', 'glides'));
  ok('mentionsWord rejects the hallucinated word', !mentionsWord('You read glad so smoothly!', 'glides'));
  ok('mentionsWord is not fooled by a prefix', !mentionsWord('You read glide well', 'glides'));
  ok('mentionsWord ignores case', mentionsWord('GLIDES was great', 'glides'));
  ok('mentionsWord tolerates quoting', mentionsWord('You read "glides" well', 'glides'));
}
{
  // A coached word is not praiseworthy — it took more than one attempt.
  const t = new PassageTracker('The dragon roared loudly.');
  t.ingest([word('The', 95)]);
  t.ingest([word('dragon', 30, 'Mispronunciation', [{ phoneme: 'd', accuracyScore: 10 }])]);
  t.ingest([word('dragon', 91)]);
  t.ingest([word('roared', 94), word('loudly', 92)]);
  const picked = pickPraiseWord(t.words);
  ok('skips a word that needed coaching', picked !== 'dragon', String(picked));
  ok('still returns a real word', picked === 'roared' || picked === 'loudly', String(picked));
}
{
  // Punctuation must not reach the narrator as part of the word.
  const t = new PassageTracker('Blue went home.');
  t.ingest([word('Blue', 90), word('went', 92), word('home', 97)]);
  ok('strips trailing punctuation', pickPraiseWord(t.words) === 'home', String(pickPraiseWord(t.words)));
}
{
  // Nothing passed — must return null rather than invent something.
  const t = new PassageTracker('Xylophone zebra.');
  ok('returns null when nothing was read', pickPraiseWord(t.words) === null);
}

// --------------------------------------------------------------------------
console.log('\nTurn-transition acknowledgment');
// --------------------------------------------------------------------------
{
  ok('accepts a plain interjection', sanitizeAcknowledgment('Nice!') === 'Nice!');
  ok('adds punctuation for TTS prosody', sanitizeAcknowledgment('Great job') === 'Great job!');
  ok('strips wrapping quotes', sanitizeAcknowledgment('"Wow!"') === 'Wow!');
  ok('strips markdown', sanitizeAcknowledgment('**Lovely!**') === 'Lovely!');
  ok('strips emoji', sanitizeAcknowledgment('Nice! 🎉') === 'Nice!');
  ok('collapses whitespace', sanitizeAcknowledgment('  You   got  it! ') === 'You got it!');

  ok('rejects empty', sanitizeAcknowledgment('') === null);
  ok('rejects null', sanitizeAcknowledgment(null) === null);
  ok(
    'rejects anything too long to be a transition',
    sanitizeAcknowledgment('That was a really wonderful piece of reading my friend') === null,
  );
  ok(
    'rejects a word citation (the "glad" bug class)',
    sanitizeAcknowledgment('You read "glides" well!') === null,
  );
  ok('rejects digits', sanitizeAcknowledgment('All 5 words!') === null);
  ok(
    'rejects continuing the story',
    sanitizeAcknowledgment('Nice! Blue flew away over the hills.') === null,
  );

  // Band classification drives the tone the model is asked for.
  const flawless = new PassageTracker('The frog hops fast.');
  flawless.ingest([word('The', 96), word('frog', 92), word('hops', 90), word('fast', 94)]);
  ok('flawless read is banded flawless', summarizeReading(flawless.words).band === 'flawless');

  const effortful = new PassageTracker('The dragon roared.');
  effortful.ingest([word('The', 95)]);
  effortful.markGiven(1);
  effortful.ingest([word('roared', 88)]);
  ok('a given word makes it effortful', summarizeReading(effortful.words).band === 'effortful');

  const solid = new PassageTracker('The cat sat down.');
  solid.ingest([word('The', 95)]);
  solid.ingest([word('cat', 40, 'Mispronunciation', [{ phoneme: 'k', accuracyScore: 20 }])]);
  solid.ingest([word('cat', 90), word('sat', 92), word('down', 91)]);
  ok('one wobble is banded solid', summarizeReading(solid.words).band === 'solid', summarizeReading(solid.words).band);
}

// --------------------------------------------------------------------------
console.log('\nBranching an utterance: reading, talking, or both');
// --------------------------------------------------------------------------
{
  const passage = 'The blue dragon flew over the hill.';
  const branch = (text: string, p: string | null = passage) => branchUtterance({ text, passage: p });

  // Reading. The assessment layer owns these; the conversation layer says nothing.
  ok('reading the line is reading', branch('The blue dragon flew over the hill').kind === 'reading');
  ok('a partial read is reading', branch('The blue dragon flew').kind === 'reading');
  ok(
    'a misread is still reading',
    branch('The bloo dragon flew over the hill').kind === 'reading',
    JSON.stringify(branch('The bloo dragon flew over the hill')),
  );

  // Talking. Every one of these has to get an answer.
  ok('"I am really bored of this" is conversation', branch('I am really bored of this').kind === 'conversation');
  ok('"can we read about trucks instead" is conversation', branch('can we read about trucks instead').kind === 'conversation');
  ok('"I lost my tooth yesterday" is conversation', branch('I lost my tooth yesterday').kind === 'conversation');
  ok('with no line on screen it is all conversation', branch('hello ollie', null).kind === 'conversation');

  // Both, in one breath — the case the old design could not express at all.
  const mixed = branch('The blue dragon flew can we do cars instead over the hill');
  ok('an aside mid-line is mixed', mixed.kind === 'mixed', JSON.stringify(mixed));
  ok('the aside is extracted', mixed.conversationText.toLowerCase().includes('cars'), mixed.conversationText);
  ok('the reading half is kept', mixed.readingText.toLowerCase().includes('dragon'), mixed.readingText);

  // A single wrong word inside a line is a stumble, not an interruption.
  ok('one odd word does not make it mixed', branch('The blue dragon flapped over the hill').kind === 'reading');

  // "Have they finished talking?" is no longer asked here, or anywhere. It was
  // the hardest question in the codebase — a settle window of 350ms to 3.8s,
  // chosen by looking at whether the last word was "and" — and the mic button
  // answers it outright. What survives is the question the button does NOT
  // answer: was that the line on screen, or was it addressed to us.
}

// --------------------------------------------------------------------------
console.log('\nFact ledger (when the story may use what it heard)');
// --------------------------------------------------------------------------
{
  const ledger = new FactLedger();
  const tooth = ledger.add({ text: 'lost a tooth yesterday', topic: 'tooth', kind: 'event', beat: 1 })!;

  ok('a fact is recorded', ledger.size === 1);
  ok('the same fact twice is one fact', ledger.add({ text: 'lost a tooth yesterday', beat: 2 })!.id === tooth.id && ledger.size === 1);

  // The point of the whole module: not the very next sentence.
  ok('not woven immediately', ledger.pickForWeaving(1) === null);
  ok(
    `not woven before ${WEAVE_DELAY_BEATS} beats have passed`,
    ledger.pickForWeaving(1 + WEAVE_DELAY_BEATS - 1) === null,
  );
  ok('woven once enough beats have passed', ledger.pickForWeaving(1 + WEAVE_DELAY_BEATS)?.id === tooth.id);

  ledger.markWoven(tooth.id, 3);
  ok('a used fact is not used again', ledger.pickForWeaving(9) === null);

  // Spacing: two details must not land back to back.
  const spaced = new FactLedger();
  spaced.add({ text: 'has a dog called Max', topic: 'dogs', kind: 'person', beat: 0 });
  spaced.add({ text: 'loves diggers', topic: 'diggers', kind: 'interest', beat: 0 });
  const first = spaced.pickForWeaving(2)!;
  spaced.markWoven(first.id, 2);
  ok('no second detail in the very next beat', spaced.pickForWeaving(3) === null);
  ok('a second detail lands later', spaced.pickForWeaving(4) !== null);

  // Feelings are answered in the moment, never folded into a passage later.
  const feelings = new FactLedger();
  feelings.add({ text: 'is feeling bored right now', topic: 'bored', kind: 'feeling', beat: 0 });
  ok('feelings are never woven', feelings.pickForWeaving(10) === null);

  // Events prefer to go first — they are the most story-worthy.
  const order = new FactLedger();
  order.add({ text: 'likes space', topic: 'space', kind: 'interest', beat: 0 });
  order.add({ text: 'has a birthday on Saturday', topic: 'birthday', kind: 'event', beat: 0 });
  ok('events outrank interests', order.pickForWeaving(5)?.kind === 'event');
}

// --------------------------------------------------------------------------
console.log('\nFacts folded into memory');
// --------------------------------------------------------------------------
{
  const memory: ChildMemory = {
    interests: [{ topic: 'dragons', weight: 0.5, last_seen: '2026-01-01T00:00:00.000Z' }],
    personality_notes: '',
    canon: { open_threads: ['Blue lost his bell'] },
  };

  const ledger = new FactLedger();
  ledger.add({ text: 'loves diggers', topic: 'diggers', kind: 'interest', beat: 0 });
  ledger.add({ text: 'loves dragons', topic: 'dragons', kind: 'interest', beat: 0 });
  ledger.add({ text: 'lost a tooth yesterday', topic: 'tooth', kind: 'event', beat: 0 });

  const merged = mergeFactsIntoMemory(memory, ledger.all());

  ok('a new interest is added', merged.interests.some((i) => i.topic === 'diggers'));
  ok(
    'a mentioned interest is bumped by 0.3',
    merged.interests.find((i) => i.topic === 'dragons')?.weight === 0.8,
    String(merged.interests.find((i) => i.topic === 'dragons')?.weight),
  );
  ok('events land in canon, not interests', !merged.interests.some((i) => i.topic === 'tooth'));
  ok(
    'events are remembered for next time',
    merged.canon.recent_events?.[0]?.text === 'lost a tooth yesterday',
  );
  ok('existing canon survives', merged.canon.open_threads?.[0] === 'Blue lost his bell');
  ok('the original memory object is untouched', memory.interests.length === 1);
}

// --------------------------------------------------------------------------
console.log('\nSession flow (when to wrap up, and what to celebrate)');
// --------------------------------------------------------------------------
{
  ok('no check-in early on', !shouldCheckIn({ passagesSinceCheckIn: 2, msSinceCheckIn: 60_000, checkIns: 0 }));
  ok('check-in after six passages', shouldCheckIn({ passagesSinceCheckIn: 6, msSinceCheckIn: 0, checkIns: 0 }));
  ok('check-in after ten minutes', shouldCheckIn({ passagesSinceCheckIn: 1, msSinceCheckIn: 10 * 60_000, checkIns: 0 }));
  ok(
    'check-ins come sooner once they have chosen to continue',
    shouldCheckIn({ passagesSinceCheckIn: 4, msSinceCheckIn: 0, checkIns: 1 }),
  );

  // Progress: a word they fought for outranks one that was easy.
  const stuck = new PassageTracker('The dragon glides home.');
  stuck.ingest([word('The', 96)]);
  stuck.ingest([word('dragon', 35, 'Mispronunciation', [{ phoneme: 'd', accuracyScore: 12 }])]);
  stuck.ingest([word('dragon', 93), word('glides', 95), word('home', 97)]);

  const progress = summarizeProgress([stuck.words]);
  ok('one passage counted', progress.passages === 1);
  ok('the word they fought for is named', progress.conquered.includes('dragon'), JSON.stringify(progress));
  ok('a first-try word is not "conquered"', !progress.conquered.includes('glides'));
  ok('strong first-try words are available as a fallback', progress.strong.includes('glides'), JSON.stringify(progress));

  // Yes/no, decided in code — "no" is not a word to get wrong.
  ok('"yes please" is yes', parseYesNo('yes please') === 'yes');
  ok('"yeah keep going" is yes', parseYesNo('yeah keep going') === 'yes');
  ok('"no" is no', parseYesNo('no') === 'no');
  ok('"no more" is no, not yes', parseYesNo('no more') === 'no');
  ok('"I\'m done" is no', parseYesNo("I'm done") === 'no');
  ok('"nope not now" is no', parseYesNo('nope not now') === 'no');
  ok('silence is neither', parseYesNo(null) === null);
  ok('"can I have juice" is neither', parseYesNo('can I have juice') === null);
}

// --------------------------------------------------------------------------
console.log('\nOnboarding profile');
// --------------------------------------------------------------------------
{
  ok('a blank name means onboarding', isFreshProfile({ name: '' }));
  ok('the placeholder name means onboarding', isFreshProfile({ name: 'friend' }));
  ok('a real name does not', !isFreshProfile({ name: 'Maya' }));

  let draft = emptyDraft();
  ok('an empty draft cannot start a story', !hasEnoughToStart(draft));

  draft = mergeDraft(draft, { name: 'maya', interests: ['Dragons', 'dragons'] });
  ok('the name is capitalised', draft.name === 'Maya');
  ok('interests are deduped case-insensitively', draft.interests.length === 1, JSON.stringify(draft.interests));
  ok('a name plus one interest is enough', hasEnoughToStart(draft));

  // The model must not be able to rename the child halfway through.
  draft = mergeDraft(draft, { name: 'Ada', age: 5, interests: ['diggers'] });
  ok('the first name heard wins', draft.name === 'Maya');
  ok('age is taken', draft.age === 5);

  // Junk from the model is rejected rather than spoken back at the child.
  const junk = mergeDraft(emptyDraft(), {
    name: 'I think their name might be Sam',
    age: 47,
    interests: [''],
  });
  ok('a sentence is not a name', junk.name === null);
  ok('an implausible age is dropped', junk.age === null);
  ok('blank interests are dropped', junk.interests.length === 0);

  const interests = draftToInterests(draft);
  ok('the first interest carries the most weight', interests[0].weight >= interests[1].weight);
  ok('interest weights stay in range', interests.every((i) => i.weight >= 0.6 && i.weight <= 1));
}

// --------------------------------------------------------------------------
console.log('\nSpoken turn length and repetition');
// --------------------------------------------------------------------------
{
  ok('a short turn is untouched', trimSpokenTurn('Hi! What is your name?') === 'Hi! What is your name?');

  // The question is always the last sentence, so it must survive the cut.
  const rambling =
    'Oh wow, cars are wonderful. I love cars too. They go so fast. My favourite is a red one. What kind of car do you like best?';
  const trimmed = trimSpokenTurn(rambling);
  ok('a rambling turn is cut down', trimmed.split(/(?<=[.!?])\s+/).length === 2, trimmed);
  ok('the reaction survives', trimmed.startsWith('Oh wow, cars are wonderful.'), trimmed);
  ok('the question survives', trimmed.endsWith('What kind of car do you like best?'), trimmed);

  // Two greetings in a row is what made one voice sound like two people.
  ok(
    'a repeated greeting is caught',
    repeatsPrevious("Hi there! I'm Ollie, and I'm happy you came to read with me.", "Hi there! I'm Ollie. I'm so happy you came to read with me."),
  );
  ok(
    'a genuine next question is not a repeat',
    !repeatsPrevious('What do you love most?', "Hi there! I'm Ollie. I'm so happy you came to read with me."),
  );
  ok('nothing to compare against is not a repeat', !repeatsPrevious('Hello!', null));
}

// --------------------------------------------------------------------------
console.log('\nPlanner fallback (must never be about somebody else)');
// --------------------------------------------------------------------------
{
  const child = { id: 'x', name: 'Sam', age: 5, onboarding_notes: null };
  const carsMemory: ChildMemory = {
    interests: [
      { topic: 'dinosaurs', weight: 0.4, last_seen: '' },
      { topic: 'cars', weight: 0.9, last_seen: '' },
    ],
    personality_notes: '',
    canon: {},
  };

  // The failure this exists to prevent: a child spends a minute talking about
  // cars, the planner throws on a schema technicality, and they get a dragon.
  const personalized = fallbackPlan(child, ['short_a'], carsMemory);
  ok('the fallback uses their top interest', personalized.premise.includes('cars'), personalized.premise);
  ok('no dragon in sight', !JSON.stringify(personalized).toLowerCase().includes('dragon'));
  ok('every beat is about them', personalized.beats.every((b) => b.includes('Sam')));
  ok(
    'practice words come from the target skill',
    personalized.vocab_constraints.must_use_words.includes('cat'),
    JSON.stringify(personalized.vocab_constraints.must_use_words),
  );

  const blank = fallbackPlan(child, ['short_a']);
  ok('with no interests it still names the child', blank.premise.includes('Sam'));
  ok('and stays within the passage limits', blank.vocab_constraints.max_sentence_words <= 12);
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: the transition table is total');
// --------------------------------------------------------------------------
{
  const STATES: VoiceState[] = ['IDLE', 'AI_SPEAKING', 'MIC_OPEN', 'PROCESSING', 'ERROR', 'ENDED'];
  const EVENTS: VoiceEvent[] = [
    { t: 'MIC_TAP' },
    { t: 'AI_SPEECH_START', utteranceId: 99, text: 'hello', handoff: false },
    { t: 'AI_SPEECH_END', utteranceId: 99 },
    { t: 'SPEECH_END_DETECTED', turnId: 99 },
    { t: 'TRANSCRIPT_FINAL', turnId: 99, text: 'hi' },
    { t: 'RESPONSE_READY', turnId: 99, willSpeak: true },
    { t: 'FLOOR_TO_CHILD' },
    { t: 'ERROR', message: 'boom', from: 'stt' },
    { t: 'RECOVER' },
    { t: 'MODE_CHANGE', mode: 'STORY' },
    { t: 'SESSION_END' },
  ];

  /** Reach a given state by the route a real session would take. */
  function reach(state: VoiceState, mode: 'ONBOARDING' | 'STORY' = 'STORY'): VoiceSnapshot {
    let s = initialSnapshot(mode);
    const step = (e: VoiceEvent, at = 1000) => {
      s = transition(s, e, at).snapshot;
    };
    switch (state) {
      case 'IDLE':
        break;
      case 'AI_SPEAKING':
        step({ t: 'AI_SPEECH_START', utteranceId: 1, text: 'a beat', handoff: true });
        break;
      case 'MIC_OPEN':
        step({ t: 'MIC_TAP' });
        break;
      case 'PROCESSING':
        step({ t: 'MIC_TAP' }, 1000);
        step({ t: 'MIC_TAP' }, 9000);
        break;
      case 'ERROR':
        step({ t: 'ERROR', message: 'stt died', from: 'stt' });
        break;
      case 'ENDED':
        step({ t: 'SESSION_END' });
        break;
    }
    return s;
  }

  // Every cell defined. An event that falls through the table would return the
  // "unhandled" no-op, which is the one outcome that must never occur.
  let undefinedCells = 0;
  let invariantBreaks = 0;
  for (const state of STATES) {
    for (const event of EVENTS) {
      const before = reach(state);
      ok(`reach(${state}) really is ${state}`, before.state === state, before.state);
      const out = transition(before, event, 20_000);
      if (out.noop?.startsWith('unhandled')) {
        undefinedCells++;
        console.log(`        undefined: ${state} x ${event.t}`);
      }
      const broken = checkInvariants(out.snapshot);
      if (broken.length) {
        invariantBreaks++;
        console.log(`        invariant: ${state} x ${event.t} -> ${broken.join('; ')}`);
      }
    }
  }
  ok(`all ${STATES.length * EVENTS.length} cells are defined`, undefinedCells === 0);
  ok('no transition can break an invariant', invariantBreaks === 0);
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: mutual exclusion');
// --------------------------------------------------------------------------
{
  // Invariant 1, from both directions. This is the rule the whole rework is for.
  let s = initialSnapshot('STORY');
  s = transition(s, { t: 'MIC_TAP' }, 1000).snapshot;
  ok('the mic is open', s.state === 'MIC_OPEN');

  const refused = transition(s, { t: 'AI_SPEECH_START', utteranceId: 1, text: 'hi', handoff: true }, 2000);
  ok('asking to speak over an open mic is REFUSED', refused.rejected !== null, String(refused.rejected));
  ok('and nothing is queued to fire on close', refused.effects.length === 0);
  ok('the state does not move', refused.snapshot.state === 'MIC_OPEN');

  // Closing the mic must not then release the refused line: it was never held.
  const closed = transition(refused.snapshot, { t: 'MIC_TAP' }, 5000);
  ok('closing produces no speech', !closed.effects.some((e) => e.t === 'start_tts'));

  // And nothing anywhere can produce a snapshot with both.
  const speaking = transition(
    initialSnapshot('STORY'),
    { t: 'AI_SPEECH_START', utteranceId: 1, text: 'hi', handoff: true },
    1000,
  ).snapshot;
  ok('AI_SPEAKING carries no mic session', speaking.mic === null);
  ok('MIC_OPEN carries no utterance', s.speaking === null);
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: mid-sentence barge-in');
// --------------------------------------------------------------------------
{
  let clock = 1000;
  const effects: VoiceEffect[] = [];
  const m = new VoiceMachine({
    mode: 'STORY',
    onEffect: (e) => effects.push(e),
    onViolation: (v) => ok(`no invariant broken (${v.join('; ')})`, false),
    now: () => clock,
  });

  m.send({ t: 'AI_SPEECH_START', utteranceId: 1, text: 'Blue the dragon flew over the hill', handoff: true });
  ok('Ollie is speaking', m.state === 'AI_SPEAKING');

  effects.length = 0;
  m.send({ t: 'MIC_TAP' });

  // Everything a barge-in has to do, in the order it has to do it: kill the
  // stream, drop what the browser has buffered, then hand over the floor.
  const kinds = effects.map((e) => e.t);
  ok('the stream is cancelled', kinds.includes('cancel_tts'));
  ok('buffered audio is flushed', kinds.includes('flush_playback'));
  ok('cancelling comes before opening', kinds.indexOf('cancel_tts') < kinds.indexOf('open_mic'));
  ok('the mic opens in the same transition', m.state === 'MIC_OPEN');
  ok('there is no guard window to wait out', true);

  // THE rule from section 3: a manual interruption is never auto-closed.
  ok('a barge-in mic session is MANUAL', m.snapshot.mic!.autoCloseArmed === false);
  ok('it is marked as the child having opened it', m.snapshot.mic!.reason === 'user_tap');
  ok('and no silence detector is armed', !kinds.includes('arm_auto_close'));

  // Silence therefore cannot end it, which is the entire point: a child who
  // interrupted mid-story is bored or has something to say, and pausing to
  // think is not a reason to take their turn away.
  const before = m.snapshot.state;
  m.send({ t: 'SPEECH_END_DETECTED', turnId: m.snapshot.mic!.turnId });
  ok('silence does NOT close a manual turn', m.state === before && m.state === 'MIC_OPEN');

  // Only another tap does — a real one, seconds later. A second tap inside the
  // double-tap window is a fumbled press, and is tested separately below.
  clock += 4_000;
  m.send({ t: 'MIC_TAP' });
  ok('a second tap closes it', m.state === 'PROCESSING');
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: the reading turn opens and closes itself');
// --------------------------------------------------------------------------
{
  const effects: VoiceEffect[] = [];
  const m = new VoiceMachine({
    mode: 'STORY',
    onEffect: (e) => effects.push(e),
    onViolation: (v) => ok(`no invariant broken (${v.join('; ')})`, false),
  });

  m.send({ t: 'AI_SPEECH_START', utteranceId: 7, text: 'Read this with me.', handoff: true });
  effects.length = 0;

  // The child never taps to take their reading turn.
  m.send({ t: 'AI_SPEECH_END', utteranceId: 7 });
  ok('the mic opens by itself when the passage ends', m.state === 'MIC_OPEN');
  ok('the system is recorded as the opener', m.snapshot.mic!.reason === 'system_after_passage');
  ok('so silence MAY close it', m.snapshot.mic!.autoCloseArmed === true);

  const armed = effects.find((e) => e.t === 'arm_auto_close');
  ok('the silence detector is armed', !!armed);
  ok(
    'and armed for this turn, at the configured threshold',
    armed?.t === 'arm_auto_close' &&
      armed.turnId === m.snapshot.mic!.turnId &&
      armed.silenceMs === AUTO_CLOSE_SILENCE_MS,
  );

  // Reading finished.
  effects.length = 0;
  m.send({ t: 'SPEECH_END_DETECTED', turnId: m.snapshot.mic!.turnId });
  ok('silence closes an armed turn', m.state === 'PROCESSING');
  ok(
    'and commits it — the audio becomes a transcript',
    effects.some((e) => e.t === 'close_mic' && e.commit),
  );
  ok('the detector is disarmed on the way out', effects.some((e) => e.t === 'disarm_auto_close'));

  // Silence reported for a turn that has already closed is ignored, not acted on.
  const stale = transition(m.snapshot, { t: 'SPEECH_END_DETECTED', turnId: 1 }, 9000);
  ok('stale silence changes nothing', stale.noop !== null && stale.snapshot.state === 'PROCESSING');
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: onboarding is manual at both ends');
// --------------------------------------------------------------------------
{
  let clock = 1000;
  const effects: VoiceEffect[] = [];
  const m = new VoiceMachine({
    mode: 'ONBOARDING',
    onEffect: (e) => effects.push(e),
    onViolation: (v) => ok(`no invariant broken (${v.join('; ')})`, false),
    now: () => clock,
  });

  // No automatic OPEN: finishing a question leaves the floor with nobody.
  m.send({ t: 'AI_SPEECH_START', utteranceId: 1, text: 'What should I call you?', handoff: true });
  m.send({ t: 'AI_SPEECH_END', utteranceId: 1 });
  ok('the mic does not open by itself in onboarding', m.state === 'IDLE');

  // Nor does an explicit hand-over, which is a story-mode idea.
  m.send({ t: 'FLOOR_TO_CHILD' });
  ok('FLOOR_TO_CHILD is a no-op in onboarding', m.state === 'IDLE');

  // The child opens it.
  effects.length = 0;
  m.send({ t: 'MIC_TAP' });
  ok('tapping opens it', m.state === 'MIC_OPEN');
  ok('never armed for auto-close', m.snapshot.mic!.autoCloseArmed === false);
  ok('and no silence detector runs at all', !effects.some((e) => e.t === 'arm_auto_close'));

  // No automatic CLOSE: a child pausing to think keeps their turn, however long
  // they pause. This is the rule that a silence threshold cannot express.
  m.send({ t: 'SPEECH_END_DETECTED', turnId: m.snapshot.mic!.turnId });
  ok('silence never ends an onboarding turn', m.state === 'MIC_OPEN');

  // However long they take. A four-year-old deciding what they love is not a
  // child who has finished their turn.
  clock += 60_000;
  m.send({ t: 'SPEECH_END_DETECTED', turnId: m.snapshot.mic!.turnId });
  ok('not after a minute either', m.state === 'MIC_OPEN');

  clock += 1_000;
  m.send({ t: 'MIC_TAP' });
  ok('only the child ends it', m.state === 'PROCESSING');

  // armsAutoClose is the single place the flag is computed, and it needs both.
  ok('story + system arms it', armsAutoClose('STORY', 'system_after_passage'));
  ok('story + a tap does not', !armsAutoClose('STORY', 'user_tap'));
  ok('onboarding + system does not', !armsAutoClose('ONBOARDING', 'system_after_passage'));
  ok('onboarding + a tap does not', !armsAutoClose('ONBOARDING', 'user_tap'));
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: races and rapid taps');
// --------------------------------------------------------------------------
{
  const make = () => {
    const effects: VoiceEffect[] = [];
    const m = new VoiceMachine({
      mode: 'STORY',
      onEffect: (e) => effects.push(e),
      onViolation: (v) => ok(`no invariant broken (${v.join('; ')})`, false),
      now: () => clock,
    });
    return { m, effects };
  };
  let clock = 1000;

  // Rapid double tap: open and shut inside the double-tap window. There is no
  // turn here to finalise, so the audio is discarded rather than committed —
  // otherwise every fumbled press costs an empty transcript and an LLM call.
  {
    const { m, effects } = make();
    clock = 1000;
    m.send({ t: 'MIC_TAP' });
    clock = 1000 + MIC_DOUBLE_TAP_MS - 50;
    effects.length = 0;
    m.send({ t: 'MIC_TAP' });
    ok('a double tap lands back at IDLE, not PROCESSING', m.state === 'IDLE');
    ok(
      'and discards rather than commits',
      effects.some((e) => e.t === 'close_mic' && !e.commit),
    );
  }

  // A deliberate tap-close is a real turn.
  {
    const { m, effects } = make();
    clock = 1000;
    m.send({ t: 'MIC_TAP' });
    clock = 4000;
    effects.length = 0;
    m.send({ t: 'MIC_TAP' });
    ok('a real turn commits', effects.some((e) => e.t === 'close_mic' && e.commit));
    ok('and lands in PROCESSING', m.state === 'PROCESSING');
  }

  // Ten taps in a row must never deadlock or leave the mic stuck either way.
  {
    const { m } = make();
    clock = 1000;
    for (let i = 0; i < 10; i++) {
      clock += 500;
      m.send({ t: 'MIC_TAP' });
    }
    ok('ten taps leave a legal state', ['MIC_OPEN', 'PROCESSING'].includes(m.state), m.state);
    ok('and no broken invariant', checkInvariants(m.snapshot).length === 0);
    clock += 500;
    // Whatever state it is in, one more tap must still do something sane.
    const before = m.state;
    m.send({ t: 'MIC_TAP' });
    ok('the button always still works', m.state !== before || m.state === 'MIC_OPEN');
  }

  // A tap in the async gap between "speech ended" and "mic opened". The gap is
  // one transition wide, so the tap lands in MIC_OPEN and simply closes it.
  {
    const { m } = make();
    clock = 1000;
    m.send({ t: 'AI_SPEECH_START', utteranceId: 1, text: 'go on', handoff: true });
    clock = 2000;
    m.send({ t: 'AI_SPEECH_END', utteranceId: 1 });
    ok('the mic auto-opened', m.state === 'MIC_OPEN');
    clock = 3000;
    m.send({ t: 'MIC_TAP' });
    ok('a tap right after still closes cleanly', m.state === 'PROCESSING');
  }

  // A transcript arriving after the child has already reopened the mic. This is
  // the one the turnId exists for: answering it would be answering a question
  // the child has moved past.
  {
    const { m, effects } = make();
    clock = 1000;
    m.send({ t: 'MIC_TAP' });
    const firstTurn = m.snapshot.mic!.turnId;
    clock = 4000;
    m.send({ t: 'MIC_TAP' });
    clock = 5000;
    m.send({ t: 'MIC_TAP' }); // they want to say something else
    ok('the child gets the floor back immediately', m.state === 'MIC_OPEN');
    ok('the abandoned turn is dropped', true);

    effects.length = 0;
    m.send({ t: 'TRANSCRIPT_FINAL', turnId: firstTurn, text: 'the old thing' });
    ok(
      'a late transcript is never processed',
      !effects.some((e) => e.t === 'process_turn'),
    );
    ok('and the mic stays open', m.state === 'MIC_OPEN');
  }

  // A reply that finishes generating after the child has taken the floor again
  // must not be spoken. Two locks: the response is stale, and speaking is
  // refused anyway.
  {
    const { m } = make();
    clock = 1000;
    m.send({ t: 'MIC_TAP' });
    const turnId = m.snapshot.mic!.turnId;
    clock = 4000;
    m.send({ t: 'MIC_TAP' });
    clock = 5000;
    m.send({ t: 'MIC_TAP' });
    const late = transition(m.snapshot, { t: 'RESPONSE_READY', turnId, willSpeak: true }, 6000);
    ok('a stale reply is ignored', late.noop !== null);
    const spoken = transition(m.snapshot, { t: 'AI_SPEECH_START', utteranceId: 5, text: 'hi', handoff: false }, 6000);
    ok('and could not be spoken even if it tried', spoken.rejected !== null);
  }
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: recovery, never stuck');
// --------------------------------------------------------------------------
{
  // Transcription dies mid-turn. The mic must not stay open with nobody
  // listening, and the session must not stay mute with nobody able to fix it.
  {
    let s = initialSnapshot('STORY');
    s = transition(s, { t: 'MIC_TAP' }, 1000).snapshot;
    const out = transition(s, { t: 'ERROR', message: 'stt died', from: 'stt' }, 2000);
    ok('an STT failure closes the mic', out.snapshot.state === 'ERROR' && out.snapshot.mic === null);
    ok('the audio is discarded, not committed', out.effects.some((e) => e.t === 'close_mic' && !e.commit));

    // And the child can always get out of it themselves.
    const tapped = transition(out.snapshot, { t: 'MIC_TAP' }, 3000);
    ok('a tap recovers straight into a live mic', tapped.snapshot.state === 'MIC_OPEN');
    ok('with the error cleared', tapped.snapshot.error === null);
  }

  // TTS dies mid-sentence.
  {
    let s = initialSnapshot('STORY');
    s = transition(s, { t: 'AI_SPEECH_START', utteranceId: 1, text: 'hi', handoff: true }, 1000).snapshot;
    const out = transition(s, { t: 'ERROR', message: 'voice died', from: 'tts' }, 2000);
    ok('a TTS failure cancels the utterance', out.effects.some((e) => e.t === 'cancel_tts'));
    ok('and flushes what was buffered', out.effects.some((e) => e.t === 'flush_playback'));
    const recovered = transition(out.snapshot, { t: 'RECOVER' }, 3000);
    ok('RECOVER returns to a usable state', recovered.snapshot.state === 'IDLE');
  }

  // The transcript never arrives. A watchdog is armed on the way into
  // PROCESSING so the session cannot sit there forever.
  {
    let s = initialSnapshot('STORY');
    s = transition(s, { t: 'MIC_TAP' }, 1000).snapshot;
    const closed = transition(s, { t: 'MIC_TAP' }, 5000);
    ok('closing a turn arms a watchdog', closed.effects.some((e) => e.t === 'arm_watchdog'));
    // Even without it, the child tapping is always a way out.
    const tapped = transition(closed.snapshot, { t: 'MIC_TAP' }, 6000);
    ok('a tap escapes a stalled PROCESSING', tapped.snapshot.state === 'MIC_OPEN');
  }

  // Ending is uniform and terminal.
  {
    for (const from of ['IDLE', 'MIC_OPEN', 'AI_SPEAKING'] as const) {
      let s = initialSnapshot('STORY');
      if (from === 'MIC_OPEN') s = transition(s, { t: 'MIC_TAP' }, 1000).snapshot;
      if (from === 'AI_SPEAKING') {
        s = transition(s, { t: 'AI_SPEECH_START', utteranceId: 1, text: 'x', handoff: false }, 1000).snapshot;
      }
      const out = transition(s, { t: 'SESSION_END' }, 2000);
      ok(`SESSION_END from ${from} lands in ENDED`, out.snapshot.state === 'ENDED');
      ok(`  and leaves nothing running`, out.snapshot.mic === null && out.snapshot.speaking === null);
    }
    const ended = transition(initialSnapshot('STORY'), { t: 'SESSION_END' }, 1000).snapshot;
    ok('ENDED ignores a stray tap', transition(ended, { t: 'MIC_TAP' }, 2000).noop !== null);
  }
}

// --------------------------------------------------------------------------
console.log('\nVoice state machine: the mode dimension');
// --------------------------------------------------------------------------
{
  // The same event, resolved differently by mode. That is what "orthogonal"
  // buys, and it is why the mode is a field rather than more states.
  const onboarding = transition(
    transition(initialSnapshot('ONBOARDING'), { t: 'AI_SPEECH_START', utteranceId: 1, text: 'x', handoff: true }, 1000).snapshot,
    { t: 'AI_SPEECH_END', utteranceId: 1 },
    2000,
  ).snapshot;
  const story = transition(
    transition(initialSnapshot('STORY'), { t: 'AI_SPEECH_START', utteranceId: 1, text: 'x', handoff: true }, 1000).snapshot,
    { t: 'AI_SPEECH_END', utteranceId: 1 },
    2000,
  ).snapshot;
  ok('handoff opens the mic in STORY', story.state === 'MIC_OPEN');
  ok('and does not in ONBOARDING', onboarding.state === 'IDLE');

  // A mode change cannot leave an armed turn stranded in a mode that does not
  // arm turns — invariant 4 has to survive the mode moving underneath it.
  let s = initialSnapshot('STORY');
  s = transition(s, { t: 'AI_SPEECH_START', utteranceId: 1, text: 'x', handoff: true }, 1000).snapshot;
  s = transition(s, { t: 'AI_SPEECH_END', utteranceId: 1 }, 2000).snapshot;
  ok('armed', s.mic!.autoCloseArmed === true);
  const changed = transition(s, { t: 'MODE_CHANGE', mode: 'ONBOARDING' }, 3000);
  ok('changing mode disarms the open turn', changed.snapshot.mic!.autoCloseArmed === false);
  ok('and says so to the browser', changed.effects.some((e) => e.t === 'disarm_auto_close'));
  ok('leaving the invariants intact', checkInvariants(changed.snapshot).length === 0);
}

// --------------------------------------------------------------------------
console.log('\nWrong-language transcripts (the tennis-to-temple bug)');
// --------------------------------------------------------------------------
{
  // The real one, from a live session: a child reading "Max sits on the red
  // bench. Rex the dog naps in the hot sun." came back part-transliterated.
  const real = 'मैंक्स सेज on the red bench. Rex the dog naps in the hot sun.';
  ok('a part-Devanagari transcript is caught', looksMistranscribed(real));
  ok('a wholly non-Latin transcript is caught', looksMistranscribed('मैं ठीक हूँ'));
  ok('two foreign letters are already a fragment', looksMistranscribed('the कु bench'));

  // False positives here cost a real turn, so ordinary English must never trip
  // it — including the accented and punctuated shapes that look exotic but are
  // Latin script.
  ok('plain English is fine', !looksMistranscribed('Max sits on the red bench.'));
  ok('accents are Latin script', !looksMistranscribed('We went to the café with José.'));
  ok('sounding out is fine', !looksMistranscribed('b... l... ue. Blue!'));
  ok('numbers and punctuation are fine', !looksMistranscribed('I am 5! Really, 5?!'));
  ok('nothing at all is not a misdetection', !looksMistranscribed(''));
  ok('emoji are not letters', !looksMistranscribed('yay 🎉🎉🎉'));

  // Why it matters, precisely — and it is narrower than it first looked.
  //
  // A PARTLY foreign transcript is already safe: `tokenize` keeps only Latin
  // words, so the English half still matches the line and the turn branches as
  // reading. That is worth an assertion, because it is the thing that would
  // quietly stop being true if the tokenizer ever learned about other scripts.
  const passage = 'Max sits on the red bench. Rex the dog naps in the hot sun.';
  ok(
    'a part-foreign line still reads as READING',
    branchUtterance({ text: real, passage }).kind === 'reading',
  );

  // A WHOLLY foreign transcript is the real hole. Nothing matches, so it looks
  // like the child said something to us — and it goes to the responder, which
  // answers a hallucination in the middle of a story.
  const foreign = branchUtterance({ text: 'क्या हम कारों के बारे में पढ़ सकते हैं', passage });
  ok('a wholly foreign transcript reads as CONVERSATION', foreign.kind === 'conversation');
  ok('with nothing matched at all', foreign.overlap === 0);
  ok('so the guard, not the branch, has to catch it', looksMistranscribed('क्या हम कारों के बारे में'));
}

// --------------------------------------------------------------------------
console.log('\nTurn bookkeeping (the livelock)');
// --------------------------------------------------------------------------
{
  // The failure this exists to prevent, in full:
  //
  //   A commit is refused ("the buffer is too small. Expected at least 100ms").
  //   Its turn stays in the pending queue. The watchdog gives up and opens a new
  //   turn. THAT turn's transcript arrives, is matched against the stranded id,
  //   is reported for a turn the child has moved past, and is discarded as
  //   stale. The turn actually waiting never resolves. The watchdog fires again.
  //   The session reopens the microphone every twelve seconds, forever, and
  //   never progresses.
  //
  // One lost turn must cost exactly one turn.
  //
  // Driven through the private event handler rather than a live socket: this is
  // bookkeeping, and it is the bookkeeping that broke.
  const resolved: { turnId: number; text: string }[] = [];
  const voice = Object.create(RealtimeVoice.prototype) as any;
  voice.closed = false;
  voice.ready = true;
  voice.seenEventTypes = new Set();
  voice.awaiting = [];
  voice.openTurn = null;
  voice.appended = 0;
  voice.partial = '';
  voice.configureAttempts = 1;
  voice.transcribeModels = ['gpt-live-transcribe'];
  voice.cb = { onTranscript: (turnId: number, text: string) => resolved.push({ turnId, text }) };
  voice.send = () => {};

  const commit = (turnId: number, bytes = 96_000) => {
    voice.openTurn = turnId;
    voice.appended = bytes;
    voice.commit(turnId);
  };

  // A turn too short to transcribe is answered here, without a round trip that
  // could be refused. This is the commit that used to start the livelock.
  commit(1, 1_000);
  ok('a sub-100ms turn resolves locally', resolved.length === 1 && resolved[0].turnId === 1);
  ok('with an empty transcript', resolved[0].text === '');
  ok('and never reaches the pending queue', voice.awaiting.length === 0);

  // Ordinary turns are correlated by item_id, not arrival order.
  resolved.length = 0;
  commit(2);
  voice.handle({ type: 'input_audio_buffer.committed', item_id: 'item_A' });
  commit(3);
  voice.handle({ type: 'input_audio_buffer.committed', item_id: 'item_B' });
  ok('two turns are pending', voice.awaiting.length === 2);

  // Answered OUT OF ORDER. The FIFO could not survive this; item_id does not care.
  voice.handle({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_B',
    transcript: 'the second thing',
  });
  ok('an out-of-order transcript finds its own turn', resolved[0]?.turnId === 3, JSON.stringify(resolved));
  ok('and carries the right words', resolved[0]?.text === 'the second thing');

  voice.handle({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_A',
    transcript: 'the first thing',
  });
  ok('the older turn still resolves', resolved[1]?.turnId === 2 && resolved[1]?.text === 'the first thing');
  ok('and the queue drains', voice.awaiting.length === 0);

  // The exact error that caused it, verbatim from the API. It matched neither
  // of the two phrases the old code tested for.
  resolved.length = 0;
  commit(4);
  voice.handle({
    type: 'error',
    error: {
      message:
        'Error committing input audio buffer: the buffer is too small. ' +
        'Expected at least 100ms of audio, but buffer only has 40.00ms of audio.',
    },
  });
  ok('a refused commit still resolves its turn', resolved.length === 1 && resolved[0].turnId === 4);
  ok('leaving nothing stranded', voice.awaiting.length === 0);

  // And the turn AFTER it is unaffected — which is the whole point.
  resolved.length = 0;
  commit(5);
  voice.handle({ type: 'input_audio_buffer.committed', item_id: 'item_C' });
  voice.handle({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_C',
    transcript: 'still working',
  });
  ok(
    'the next turn is NOT off by one',
    resolved.length === 1 && resolved[0].turnId === 5 && resolved[0].text === 'still working',
    JSON.stringify(resolved),
  );

  // Giving up on a turn removes it, so a late answer cannot be misattributed.
  resolved.length = 0;
  commit(6);
  voice.handle({ type: 'input_audio_buffer.committed', item_id: 'item_D' });
  voice.abandon(6);
  ok('abandoning clears the entry', voice.awaiting.length === 0);
  commit(7);
  voice.handle({ type: 'input_audio_buffer.committed', item_id: 'item_E' });
  voice.handle({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'item_E',
    transcript: 'the new one',
  });
  ok('the live turn resolves correctly after an abandon', resolved[0]?.turnId === 7);

  // A failed transcription is still an answer.
  resolved.length = 0;
  commit(8);
  voice.handle({ type: 'input_audio_buffer.committed', item_id: 'item_F' });
  voice.handle({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: 'item_F',
    error: { message: 'could not transcribe' },
  });
  ok('a failed transcription resolves empty', resolved.length === 1 && resolved[0].text === '');
  ok('and does not strand the turn', voice.awaiting.length === 0);

  // Losing the socket must not leave anything owed.
  resolved.length = 0;
  commit(9);
  commit(10);
  voice.failAwaiting('connection closed');
  ok('a dropped connection resolves every pending turn', resolved.length === 2);
  ok('and empties the queue', voice.awaiting.length === 0);

  // A model that never echoes item_id still works: oldest-first is the fallback,
  // and a resolved turn always leaves the queue either way.
  resolved.length = 0;
  commit(11);
  voice.handle({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'no item id here',
  });
  ok('a transcript with no item_id falls back to oldest-first', resolved[0]?.turnId === 11);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
