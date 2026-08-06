/**
 * Non-LLM template lines. Used for the fixed sensitive-topic response (PLAN.md §5,
 * which must never be improvised), for the nudge ladder, and as the safe fallback
 * when the narrator's safety pass fails twice (PLAN.md §7).
 */

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Sound out a word letter by letter: "b... l... ue". */
function soundOut(word: string): string {
  return word.replace(/[^a-zA-Z]/g, '').split('').join('... ');
}

export const coachLine = (word: string, attempt: number): string => {
  const clean = word.replace(/[^a-zA-Z']/g, '');
  if (attempt <= 1) {
    return pick([
      `Let's sound it out together: ${soundOut(clean)}. What word is that?`,
      `Try that one again with me. ${soundOut(clean)}.`,
      `Nice try! Look at the letters: ${soundOut(clean)}.`,
    ]);
  }
  return pick([
    `That one is tricky. It says "${clean}". Say it with me: ${clean}.`,
    `This word is "${clean}". You've got it — let's keep going.`,
  ]);
};

export const giveWordLine = (word: string): string => {
  const clean = word.replace(/[^a-zA-Z']/g, '');
  return pick([
    `That word is "${clean}". Great sticking with it. Let's keep reading!`,
    `It says "${clean}". You worked hard on that one. Onward!`,
  ]);
};

/**
 * Fallback only — the acknowledgment between turns is normally model-generated
 * (lib/llm/acknowledge.ts) so it fits what the child just did. These are used
 * when that call fails or returns something unusable.
 */
export const ackFallback = (band: 'flawless' | 'solid' | 'effortful'): string => {
  if (band === 'flawless') return pick(['Perfect!', 'Wow, every word!', 'Beautiful reading!']);
  if (band === 'effortful') return pick(['You stuck with it!', 'Good work on that one!', 'Nice effort!']);
  return pick(['Nice!', 'Great job!', 'Well done!', 'Lovely!']);
};

/**
 * The moment a coached word finally lands. Templated rather than generated
 * because it has to arrive instantly — a two-second LLM pause after a child
 * nails a word they were stuck on is the wrong kind of silence.
 */
export const gotItLine = (word: string): string => {
  const clean = word.replace(/[^a-zA-Z']/g, '');
  return pick([
    `Yes! ${clean}. You got it!`,
    `That's it — ${clean}! Nice work.`,
    `${clean}! You figured it out.`,
    `There it is! ${clean}.`,
  ]);
};

/** Fallback check-in when the narrator cannot produce one. Must still ask. */
export const checkInLine = (name: string): string =>
  `You've been doing such good reading, ${name}. Do you want to keep going, or should we stop here for today?`;

/**
 * The child wants something different but did not say what. Asked immediately,
 * from a template, because "oh no, what would you rather?" three seconds after
 * they said they were bored is three seconds too late.
 */
export const whatWouldYouLikeLine = (favourite: string | null): string =>
  favourite
    ? pick([
        `Oh no, let's fix that! What should the story be about — something with ${favourite}?`,
        `Okay! You tell me. What do you want this story to be about? We could do ${favourite}!`,
      ])
    : pick([
        `Oh no, let's fix that! What do you want the story to be about?`,
        `Okay! You pick. What should we make the story about?`,
      ]);

/**
 * Break a stall. Says something warm and then gets out of the way.
 *
 * NEVER a question — that is the entire point of it, and the reason these are
 * templated rather than generated. A session that has spent two turns going
 * nowhere got there by asking, and the model cannot be relied on not to ask
 * again: it can see it is repeating itself and still does, because choosing to
 * stop is not a choice about words.
 */
export const backToTheLineLine = (firstWord: string | null): string => {
  const clean = (firstWord ?? '').replace(/[^a-zA-Z']/g, '');
  return clean
    ? pick([
        `Let's read it together. Your line starts with "${clean}".`,
        `Here we go — start us off with "${clean}".`,
        `I'm listening. Off you go, starting with "${clean}".`,
      ])
    : pick([`Here we go — your turn to read!`, `I'm listening. Off you go!`]);
};

/** The stall outlasted talking about it. Move the story and say so, warmly. */
export const movingOnLine = (): string =>
  pick([
    `Let's try a different bit — I've got a good one coming up.`,
    `I'll bring us something new. Here it comes!`,
  ]);

/** Instant reply to "yes, keep reading" while the next beats are being written. */
export const keepGoingLine = (): string =>
  pick([`Yes! Let's keep going.`, `Wonderful — more story it is!`, `Yay! Here comes more.`]);

/** Asked again when a yes/no answer did not arrive. */
export const continueRepromptLine = (): string =>
  pick([
    `Should we keep reading? Say yes or no!`,
    `Do you want more story, or are you all done for today?`,
  ]);

export const encourageLine = (detail: string): string =>
  pick([
    `Wow, you read ${detail} perfectly! Your reading voice is getting so strong.`,
    `That was beautiful reading — ${detail} came out just right!`,
    `You nailed ${detail}. I could really hear the story!`,
  ]);

export const silenceNudge = (firstWord: string): string => {
  const letter = firstWord.replace(/[^a-zA-Z]/g, '').charAt(0).toLowerCase();
  return `Take your time. The first word starts with ${letter}${letter}${letter}...`;
};

export const stillThereLine = (): string =>
  pick([`Are you still there, friend?`, `Still with me? I'm right here when you're ready.`]);

export const pausedLine = (): string =>
  `I'll wait right here. Just say something whenever you're ready!`;

/**
 * FIXED comfort template for sensitive topics. Never LLM-generated. PLAN.md §5.
 */
export const sensitiveTopicLine = (character: string): string =>
  `That's a really big question, and I'm glad you told me. That's a great thing to talk about with your grown-up. They give the best hugs too. Should we find out what happens to ${character}?`;

/** Last-resort narrator line when the safety pass fails twice. */
export const safeFallbackBeat = (character: string): string =>
  `${character} took a big breath and looked around. Something new was about to happen.`;

export const safeFallbackPassage = (): string => `The sun was warm and the path was long.`;

export const openingLine = (name: string): string =>
  `Hi ${name}! I'm so happy you're here. Let's read a story together.`;

/** First words a brand-new child hears, before any LLM has been called. */
export const helloStrangerLine = (): string =>
  `Hi there! I'm Ollie. I'm so happy you came to read with me.`;

/** Said while the story is actually being planned, so the wait has a reason. */
export const makingStoryLine = (name: string | null): string =>
  name
    ? `Give me one second, ${name} — I'm making up a story just for you.`
    : `Give me one second — I'm making up a story just for you.`;

export const goodbyeLine = (name: string, detail: string): string =>
  `That was wonderful, ${name}. ${detail} See you next time!`;

/**
 * A turn produced no words at all. Said out loud rather than shown, because a
 * child who is waiting for an answer has no reason to look at the screen.
 */
export const didNotCatchLine = (): string =>
  pick([
    `Oops — I didn't catch that. Can you tell me again?`,
    `Hmm, I missed that one. Try me once more!`,
  ]);

/**
 * Transcription has stopped working. This is the honest version: it does not
 * pretend the child did anything wrong, and it does not ask them to repeat
 * something that is not going to be heard either.
 */
export const cannotHearLine = (): string =>
  `My ears have gone funny — I can't hear you at the moment. Ask your grown-up to have a look, and tap the owl when you want to try again.`;
