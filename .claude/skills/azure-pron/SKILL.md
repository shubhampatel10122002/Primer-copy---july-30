---
name: azure-pron
description: Conventions for Azure Pronunciation Assessment integration in this repo
---

# Azure Pronunciation Assessment

Implementation lives in `server/azure.ts`, and it does exactly one job: scoring.
`PronunciationSession` is created per passage and answers only "how well were
those words said" — never "did the child mean to read them", which the turn's
transcript answers separately (`lib/conversation.ts`).

Audio reaches it only while the mic is open, so it can never be handed Ollie's
own voice. There used to be a second class here, `ConversationEar`, held open for
the whole session; transcription moved to the Realtime session and it has been
deleted.

## Final config values

```ts
const config = sdk.SpeechConfig.fromSubscription(key, region); // region: eastus
config.speechRecognitionLanguage = 'en-US';

const format = sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1); // 16kHz mono PCM16
const push = sdk.AudioInputStream.createPushStream(format);

const pa = new sdk.PronunciationAssessmentConfig(
  passage,                                              // referenceText
  sdk.PronunciationAssessmentGradingSystem.HundredMark,
  sdk.PronunciationAssessmentGranularity.Phoneme,
  true,                                                 // enableMiscue
);
pa.nbestPhonemeCount = 5;   // REQUIRED — see "actual phonemes" below
pa.applyTo(recognizer);
recognizer.startContinuousRecognitionAsync();
```

Audio is 16kHz because that is what Azure's push stream wants. The browser
AudioWorklet resamples from the AudioContext rate (usually 44.1k or 48k) before
the frames ever leave the client.

## Result parsing decisions

**Do not use the typed `PronunciationAssessmentResult.detailResult`.** Its
`WordResult.Phonemes[]` type omits per-phoneme `AccuracyScore` — the field exists
at runtime but is not in the SDK's `.d.ts`. Parse the raw JSON instead:

```ts
const json = e.result.properties.getProperty(
  sdk.PropertyId.SpeechServiceResponse_JsonResult,
);
const words = JSON.parse(json)?.NBest?.[0]?.Words;
```

Each word gives:
- `Word` — with `enableMiscue`, this is the **reference** token for everything
  except Insertions, which is why the tracker aligns by normalized word match.
- `PronunciationAssessment.AccuracyScore` — 0-100.
- `PronunciationAssessment.ErrorType` — `None | Mispronunciation | Omission | Insertion`.
- `Phonemes[].Phoneme` — the **expected** phoneme.
- `Phonemes[].PronunciationAssessment.NBestPhonemes[]` — what Azure **actually
  heard**, best first. Only populated when `nbestPhonemeCount` is set.

The expected-vs-actual distinction is load-bearing: without `NBestPhonemes` you
know a phoneme scored badly but not what the child said instead, and the leniency
table degrades to guessing.

## Leniency table

Lives in `lib/leniency.ts`, deliberately separate so it can be tuned during kid
testing without touching the recognizer.

| Expected | Forgiven substitutions | Forgive without evidence? |
|---|---|---|
| `r`, `ɹ`, `ɝ`, `ɚ` | w, ʋ, ʁ, ə | yes |
| `l`, `ɫ` | w, j, ʋ | yes |
| `θ` (th) | f, s, t | yes |
| `ð` (th) | d, v, z | yes |
| `s` / `z` | θ, ʃ / ð, ʒ | no — evidence required |
| `tʃ` / `dʒ` / `ʃ` / `ʒ` | ʃ, t, ts / ʒ, d, dz / s / z | no |
| `v` | b | no |

**Velar fronting (k→t, g→d) is deliberately excluded.** It largely resolves by
~3;6, and keying on `/k/` and `/g/` forgives a large share of common words (cat,
go, come, back) on the strength of one weak phoneme.

Three guards stop the table over-forgiving:
- `LENIENCY_SCORE_FLOOR = 30` — below this it is a different word, not a lisp.
- `MAX_FORGIVEN_FRACTION = 0.5` — a word with most phonemes wrong is unknown.
- Without `NBestPhonemes` evidence, only the `FORGIVE_WITHOUT_EVIDENCE` set applies.

A forgiven word is logged with `error_type = 'Developmental'` and counts as
**correct** for mastery.

## Gotchas discovered while building

- A leniency false positive is much worse than a false negative: it silently
  turns coaching off for a word the child genuinely cannot read. When in doubt,
  do not forgive.
- Never score a spoken word against a reference word it does not match. If the
  normalized word is not found within the lookahead window, drop the result —
  crediting or penalising the wrong word corrupts both the UI and mastery. This
  was a real bug caught by `npm run selftest`.
- `pushStream.write()` wants an `ArrayBuffer`. Slice the Node `Buffer` view
  (`buf.buffer.slice(byteOffset, byteOffset + byteLength)`), or you hand Azure
  the entire pooled allocation.
- The SDK hangs silently when the host is unreachable — no error, no rejection.
  Any connectivity check needs its own timeout (`scripts/smoke.ts` uses 25s).
- Recognizer teardown is async. Always `await close()` before starting the next
  passage's recognizer, or two recognizers briefly compete for the same stream.

## Verifying without a network

`npm run selftest` constructs the whole recognizer graph offline and asserts the
serialized config (`referenceText`, `gradingSystem`, `granularity`,
`enableMiscue`). Only `startContinuousRecognitionAsync` touches the network, so
this catches API misuse without credentials.
