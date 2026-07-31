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
import { floatPcmToWav } from '../lib/wav';
import { pickPraiseWord, mentionsWord } from '../lib/praise';
import { sanitizeAcknowledgment, summarizeReading } from '../lib/ack';
import {
  branchUtterance,
  looksLikeEcho,
  isInterruption,
  startsAnInterruption,
  soundsUnfinished,
  settleDelay,
} from '../lib/conversation';
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
  ok('TTS rate is 44.1kHz for Web Audio', AUDIO.ttsSampleRate === 44100);
  ok('half-duplex tail is 300ms', AUDIO.gateTailMs === 300);
  ok('tokenizer drops pure punctuation', tokenize('Hi -- there!').length === 2);
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
console.log('\nWAV encoding (audio-check isolation path)');
// --------------------------------------------------------------------------
{
  // One second of 440Hz at 44.1kHz as float32 LE, the shape Cartesia streams.
  const n = 44100;
  const pcm = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) pcm.writeFloatLE(Math.sin((2 * Math.PI * 440 * i) / n) * 0.5, i * 4);

  const wav = floatPcmToWav(pcm, 44100);

  ok('RIFF magic', wav.toString('ascii', 0, 4) === 'RIFF');
  ok('WAVE magic', wav.toString('ascii', 8, 12) === 'WAVE');
  ok('format is PCM (1)', wav.readUInt16LE(20) === 1);
  ok('mono', wav.readUInt16LE(22) === 1);
  ok('sample rate 44100', wav.readUInt32LE(24) === 44100);
  ok('16 bits per sample', wav.readUInt16LE(34) === 16);
  ok('byte rate matches', wav.readUInt32LE(28) === 44100 * 2);
  ok('block align matches', wav.readUInt16LE(32) === 2);
  ok('data chunk size matches sample count', wav.readUInt32LE(40) === n * 2);
  ok('total length = 44 + data', wav.length === 44 + n * 2);
  ok('RIFF size field = length - 8', wav.readUInt32LE(4) === wav.length - 8);
  // Clipping must saturate, not wrap around to the opposite sign.
  const loud = Buffer.alloc(8);
  loud.writeFloatLE(2.5, 0);
  loud.writeFloatLE(-2.5, 4);
  const clipped = floatPcmToWav(loud, 44100);
  ok('positive clipping saturates', clipped.readInt16LE(44) === 32767, String(clipped.readInt16LE(44)));
  ok('negative clipping saturates', clipped.readInt16LE(46) === -32768, String(clipped.readInt16LE(46)));
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

  // Knowing when they have not finished talking.
  ok('"I like cars and" is unfinished', soundsUnfinished('I like cars and'));
  ok('"I like cars, like" is unfinished', soundsUnfinished('I like cars, like'));
  ok('"I like cars" is finished', !soundsUnfinished('I like cars'));
  ok('one bare word is treated as unfinished', soundsUnfinished('Lamborghini'));
  ok('but a cue word on its own is a whole turn', !soundsUnfinished('bored'));
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
console.log('\nBarge-in (hearing the child over our own voice)');
// --------------------------------------------------------------------------
{
  const speaking = 'Blue the dragon flew over the tall green hill.';

  // Our own voice coming back through the speaker.
  ok('exact echo is echo', looksLikeEcho('Blue the dragon flew over', speaking));
  ok('partial echo is echo', looksLikeEcho('over the tall green hill', speaking));
  ok('nothing heard counts as echo', looksLikeEcho('', speaking));

  // The child, talking over it.
  ok('"I am bored" is not echo', !looksLikeEcho('I am bored', speaking));
  ok('"can we do cars instead" is not echo', !looksLikeEcho('can we do cars instead', speaking));

  // What actually gets to interrupt the story.
  ok('a cue interrupts', isInterruption('I am bored', speaking));
  ok('one cue word is enough', isInterruption('stop', speaking));
  ok('a real sentence interrupts', isInterruption('can we do cars instead', speaking));
  ok('our own voice never interrupts', !isInterruption('the dragon flew over the hill', speaking));
  ok('a stray syllable does not interrupt', !isInterruption('uh', speaking));
  ok('two tiny words do not interrupt', !isInterruption('oh a', speaking));

  // Stopping on a PARTIAL is what makes an interruption feel immediate: a final
  // arrives a second past the child's first syllable, by which point the
  // narrator has usually finished the sentence anyway.
  ok('two words stop us mid-sentence', startsAnInterruption('can we', speaking));
  ok('one cue word stops us', startsAnInterruption('bored', speaking));
  ok('a partial of our own line does not', !startsAnInterruption('the dragon flew', speaking));
  ok('a single stray syllable does not', !startsAnInterruption('uh', speaking));
  ok(
    'partials are stopped on sooner than finals are acted on',
    startsAnInterruption('can we', speaking) && !isInterruption('can we', speaking),
  );

  // The trap: while we talk, Azure transcribes US, so by the time the child cuts
  // in the partial is mostly our own words. Scored whole it reads as echo and
  // the child is ignored. Only the words that just arrived are theirs.
  const contaminated = 'Blue the dragon flew over the tall can we do cars';
  ok(
    'echo-contaminated partial reads as echo when scored whole',
    looksLikeEcho(contaminated, speaking),
  );
  ok(
    'but the new words still interrupt',
    startsAnInterruption(contaminated, speaking, 'Blue the dragon flew over the tall'),
    JSON.stringify({ contaminated }),
  );
  ok(
    'more of our own voice arriving does not interrupt',
    !startsAnInterruption('Blue the dragon flew over the tall green', speaking, 'Blue the dragon flew over'),
  );
}

// --------------------------------------------------------------------------
console.log('\nHow long to wait before answering');
// --------------------------------------------------------------------------
{
  const ms = { quick: 800, normal: 2000, patient: 3800 };
  const delay = (text: string) => settleDelay(text, ms);

  // The long wait is for thoughts still in motion.
  ok('a trailing "and" waits longest', delay('I like cars and') === ms.patient);
  ok('a trailing "like" waits longest', delay('I like cars, like') === ms.patient);
  ok('one bare word waits longest', delay('Lamborghini') === ms.patient);

  // A child who starts "I like..." is usually about to list three more things.
  ok('a list opener gets the normal wait', delay('I like cars and trucks') === ms.normal);
  ok('"my dog is called Max" gets the normal wait', delay('my dog is called Max') === ms.normal);

  // Everything else gets answered quickly — this is where the latency went.
  ok('a finished sentence is quick', delay('can we read about trucks instead') === ms.quick);
  ok('an urgent cue is quick', delay('bored') === ms.quick);
  ok('"stop" is quick', delay('stop') === ms.quick);
  ok(
    'quick really is quicker than the old flat wait',
    delay('can we read about trucks instead') < 2_500,
  );
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

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
