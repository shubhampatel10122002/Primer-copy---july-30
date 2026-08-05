/**
 * What did the child ask the story to be about?
 *
 * Deterministic, because the alternative is asking again — and asking again is
 * the whole bug this file exists for. A child said "change topic to something
 * religious", was asked which topic, answered "no preference, pick any", and was
 * asked a second time whether they had a specific story in mind. Twice told,
 * twice not heard, and no new story either way.
 *
 * Two failures produced that, and both are answered here rather than in a
 * prompt:
 *
 *   1. The subject they named never survived the trip. When the responder
 *      returns `requested_topic: null` — which it does whenever it judges an
 *      answer too vague to act on — the words the child actually used were the
 *      only remaining record of what they wanted, and nothing read them.
 *
 *   2. "You pick" is an answer. It was treated as a topic, so the story became
 *      one about "no preference, pick any" — which reads to a narrator as a
 *      question rather than a subject, so it asked it.
 *
 * So: `topicFrom` reads a request the way a person would, `isTopicDeferral`
 * recognises being handed the choice, and `cleanTopic` refuses to let a
 * non-answer through as if it were a subject. The session may ask what they
 * would like exactly once; after that it picks, because a child who has said
 * "you choose" twice has been ignored twice.
 */

/**
 * Phrases that mean "you pick". Substring matches, so they survive whatever a
 * child wraps around them ("um, no preference, you pick one!").
 */
const DEFERRAL_PHRASES = [
  'no preference',
  'any is fine',
  'anything is fine',
  'anything you',
  'anything else',
  'something else',
  'whatever you',
  'you pick',
  'you choose',
  'you decide',
  'your choice',
  'your pick',
  'up to you',
  'pick any',
  'pick one',
  'pick anything',
  'pick something',
  'choose any',
  'choose one',
  'surprise me',
  'you can pick',
  'another one',
  'different one',
  "i don't mind",
  'i dont mind',
  "don't mind",
  'dont mind',
  "don't care",
  'dont care',
  "doesn't matter",
  'doesnt matter',
  'does not matter',
  'no idea',
  'not sure',
  "don't know",
  'dont know',
];

/**
 * Whole utterances that are a shrug and nothing else.
 *
 * Matched against the ENTIRE cleaned string, never as a substring: "anything"
 * on its own is a deferral, "anything with dinosaurs" is a topic, and the
 * difference is the only thing standing between a child and a dinosaur story.
 */
const DEFERRAL_WORDS = new Set([
  'any', 'anything', 'anyone', 'something', 'whatever', 'either', 'both',
  'idk', 'dunno', 'unsure', 'nothing', 'none',
  'no', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'maybe', 'hmm', 'um', 'uh',
]);

/**
 * Words that carry no subject.
 *
 * Used for one question only: once the "you choose" part of a sentence is taken
 * out, did the child actually name something? "I don't mind, maybe dinosaurs"
 * did. "I don't mind, really" did not.
 */
const EMPTY_WORDS = new Set([
  'i', 'im', "i'm", 'you', 'we', 'me', 'it', 'is', 'are', 'am', 'be',
  'a', 'an', 'the', 'to', 'of', 'for', 'on', 'with', 'about', 'at', 'in',
  'and', 'or', 'but', 'just', 'really', 'very', 'too', 'also', 'all', 'right',
  'now', 'then', 'well', 'so', 'like', 'please', 'thanks', 'thank', 'maybe',
  'think', 'guess', 'want', 'wanna', 'thing', 'things', 'one', 'some', 'more',
  'story', 'stories', 'read', 'reading', 'do', 'can', 'could', 'lets', "let's",
]);

/**
 * Ways a child asks for a different story, and where the subject sits in each.
 *
 * Ordered most specific first: "change the topic to X" must win over the bare
 * "about X" catch-all at the bottom, which would otherwise match the wrong half
 * of "how about we change the topic to space".
 */
const REQUEST_FRAMES: RegExp[] = [
  /\b(?:change|switch|make)\s+(?:the\s+)?(?:topic|subject|story|theme)\s+(?:to|into|about)\s+(.+)/i,
  /\b(?:change|switch)\s+(?:it|this|things?)\s+(?:to|into)\s+(.+)/i,
  /\b(?:can|could|would|will)\s+(?:we|you|i)\s+(?:please\s+)?(?:do|read|have|hear|make|try|tell\s+me)\s+(?:me\s+)?(?:a|an|the)?\s*(?:new\s+|different\s+|other\s+)?(?:story|one)?\s*(?:about|on|with|of)\s+(.+)/i,
  /\b(?:i\s+want|i'?d\s+like|i\s+would\s+like|i\s+wanna|i\s+like)\s+(?:a|an|the)?\s*(?:new\s+|different\s+|other\s+)?(?:story|one)?\s*(?:about|on|with|of)\s+(.+)/i,
  /\b(?:tell|read)\s+me\s+(?:a|an|the)?\s*(?:story\s+)?(?:about|on|with)\s+(.+)/i,
  /\b(?:let'?s|lets)\s+(?:do|read|have|make|try)\s+(?:a|an|the)?\s*(?:story\s+)?(?:about|on|with)?\s*(.+)/i,
  /\b(?:how\s+about|what\s+about|instead\s+of\s+this)\s+(.+)/i,
  /\b(?:story|one)\s+(?:about|on|with)\s+(.+)/i,
  /\babout\s+(.+)/i,
];

/**
 * Filler a child leads with, which is never part of what they asked for.
 *
 * Stripped repeatedly, so "um, well, i think, dinosaurs" gets all the way down
 * to the dinosaurs.
 */
const LEADING_FILLER =
  /^(?:um+|uh+|er+|hmm+|well|so|like|ok|okay|yeah|yes|please|maybe|actually|just|and|but|then|i|we|think|guess|want|wanna)\b[\s,]*/i;

/** Trailing politeness, likewise. */
const TRAILING_FILLER = /[\s,]*\b(?:please|thanks|thank\s+you|instead|now|today|ok|okay|too)\b[\s.!?]*$/i;

/** A topic longer than this is a sentence, and a sentence is not a subject. */
const MAX_TOPIC_WORDS = 8;

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Lowercased, punctuation-free, for matching only. Never for storing. */
function forMatching(text: string): string {
  return squash(text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' '));
}

/** What is left once every "you choose" has been taken out of a sentence. */
function withoutDeferrals(text: string): string {
  let s = forMatching(text);
  for (const phrase of DEFERRAL_PHRASES) s = s.split(phrase).join(' ');
  return squash(s);
}

/** Does anything here name a subject? */
function namesSomething(text: string): boolean {
  return squash(text)
    .split(' ')
    .some((w) => w && !EMPTY_WORDS.has(w) && !DEFERRAL_WORDS.has(w));
}

/**
 * Did they hand the choice back to us?
 *
 * True is an ANSWER, not a failure to answer: the child has told us they are
 * happy with anything, and the only wrong response to that is to ask again.
 */
export function isTopicDeferral(text: string | null | undefined): boolean {
  if (!text) return false;
  const s = forMatching(text);
  if (!s) return true;
  if (DEFERRAL_WORDS.has(s)) return true;
  if (!DEFERRAL_PHRASES.some((p) => s.includes(p))) return false;
  // A shrug with a subject attached is still a subject. "I don't mind, maybe
  // dinosaurs" chose dinosaurs, and hearing only the shrug would be the second
  // time in one conversation that a clear answer went unheard.
  return !namesSomething(withoutDeferrals(s));
}

/**
 * Is this usable as the subject of a story?
 *
 * Returns the tidied topic, or null — and null means "we still do not know",
 * which the caller must resolve by choosing, never by asking a second time.
 */
export function cleanTopic(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let topic = squash(raw);
  // Quotes and end punctuation first, so "space!" and "space" are one request.
  topic = topic.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '').replace(/[.!?,;:]+$/g, '');

  let previous = '';
  while (previous !== topic) {
    previous = topic;
    topic = squash(topic.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, ''));
  }

  if (!topic) return null;
  if (!/[a-z]/i.test(topic)) return null;
  if (isTopicDeferral(topic)) return null;
  if (!namesSomething(forMatching(topic))) return null;

  const words = topic.split(' ');
  return words.length > MAX_TOPIC_WORDS ? words.slice(0, MAX_TOPIC_WORDS).join(' ') : topic;
}

/**
 * The subject inside a request, read straight from what the child said.
 *
 * The backstop for a responder that returns no topic. It is not cleverer than
 * the model — it is simply still holding the child's own words, which is more
 * than `requested_topic: null` is.
 */
export function topicFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const said = squash(text);
  if (!said) return null;

  for (const frame of REQUEST_FRAMES) {
    const match = frame.exec(said);
    const found = match && cleanTopic(match[1]);
    if (found) return found;
  }

  // Nothing framed it. Take out anything that means "you choose" and see what
  // they are left having said — often the whole answer is just the thing.
  return cleanTopic(withoutDeferrals(said));
}

/**
 * The topic to build the story around, from every source we have, best first.
 *
 * Ordered by how directly each came from the child: what the responder pulled
 * out, then their own words, then what they are known to love. The last of
 * those is a guess, but it is a guess about them — and it is only ever reached
 * once we have already asked and still do not know.
 */
export function resolveTopic(args: {
  /** `requested_topic` from the responder, if it named one. */
  requested?: string | null;
  /** `interest_topic` from the same reply. */
  interest?: string | null;
  /** What the child actually said, verbatim. */
  transcript?: string | null;
  /** Their strongest known interest, for when they told us to choose. */
  favourite?: string | null;
}): string | null {
  return (
    cleanTopic(args.requested) ??
    cleanTopic(args.interest) ??
    topicFrom(args.transcript) ??
    cleanTopic(args.favourite)
  );
}
