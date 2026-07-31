import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { env, AUDIO } from '../lib/env';
import type { ErrorType, WordAssessment } from '../lib/types';

/**
 * Azure Speech integration. Two modes (PLAN.md §9):
 *   - PronunciationSession: reading mode, referenceText = the child's passage.
 *   - TalkRecognizer: plain conversational recognition for TALK mode.
 *
 * Audio arrives as 16kHz mono PCM16 from the browser AudioWorklet and is pushed
 * into an Azure push stream. We never use the browser's SpeechRecognition API.
 */

function speechConfig(): sdk.SpeechConfig {
  const c = sdk.SpeechConfig.fromSubscription(env.azureKey, env.azureRegion);
  c.speechRecognitionLanguage = 'en-US';
  return c;
}

function pcmFormat() {
  return sdk.AudioStreamFormat.getWaveFormatPCM(AUDIO.micSampleRate, 16, 1);
}

/** Azure's typed DetailResult omits per-phoneme scores, but the runtime JSON has them. */
interface RawWord {
  Word: string;
  PronunciationAssessment?: { AccuracyScore: number; ErrorType: string };
  Phonemes?: {
    Phoneme?: string;
    PronunciationAssessment?: {
      AccuracyScore?: number;
      NBestPhonemes?: { Phoneme: string }[];
    };
  }[];
}

function toErrorType(raw: string | undefined): ErrorType {
  switch (raw) {
    case 'Mispronunciation':
    case 'Omission':
    case 'Insertion':
      return raw;
    case 'None':
    case undefined:
      return 'None';
    default:
      return 'Mispronunciation';
  }
}

function parseWords(words: RawWord[] | undefined): WordAssessment[] {
  if (!words) return [];
  return words.map((w) => ({
    word: w.Word ?? '',
    accuracyScore: w.PronunciationAssessment?.AccuracyScore ?? 0,
    errorType: toErrorType(w.PronunciationAssessment?.ErrorType),
    phonemes: (w.Phonemes ?? []).map((p) => ({
      phoneme: (p.Phoneme ?? '').toLowerCase(),
      accuracyScore: p.PronunciationAssessment?.AccuracyScore ?? 100,
      actual: (p.PronunciationAssessment?.NBestPhonemes ?? [])
        .map((n) => (n.Phoneme ?? '').toLowerCase())
        .filter(Boolean),
    })),
  }));
}

export interface PronunciationCallbacks {
  /** Interim hypothesis — used to advance the on-screen cursor while they read. */
  onPartial?: (text: string) => void;
  /** Final per-word assessment for one utterance. */
  onWords: (words: WordAssessment[], recognizedText: string) => void;
  onError?: (message: string) => void;
}

export class PronunciationSession {
  private recognizer: sdk.SpeechRecognizer;
  private pushStream: sdk.PushAudioInputStream;
  private closed = false;

  constructor(referenceText: string, private cb: PronunciationCallbacks) {
    this.pushStream = sdk.AudioInputStream.createPushStream(pcmFormat());
    const audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);
    this.recognizer = new sdk.SpeechRecognizer(speechConfig(), audioConfig);

    const paConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      /* enableMiscue */ true,
    );
    // Ask for the phonemes Azure actually heard, so the leniency table can
    // verify a real developmental substitution instead of assuming one.
    paConfig.nbestPhonemeCount = 5;
    paConfig.applyTo(this.recognizer);

    this.recognizer.recognizing = (_s, e) => {
      if (e.result?.text) this.cb.onPartial?.(e.result.text);
    };

    this.recognizer.recognized = (_s, e) => {
      if (e.result.reason !== sdk.ResultReason.RecognizedSpeech) return;
      try {
        const json = e.result.properties.getProperty(
          sdk.PropertyId.SpeechServiceResponse_JsonResult,
        );
        const parsed = json ? JSON.parse(json) : null;
        const rawWords: RawWord[] | undefined = parsed?.NBest?.[0]?.Words;
        this.cb.onWords(parseWords(rawWords), e.result.text ?? '');
      } catch (err) {
        this.cb.onError?.(`failed to parse assessment: ${String(err)}`);
      }
    };

    this.recognizer.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        this.cb.onError?.(`azure canceled: ${e.errorDetails}`);
      }
    };

    this.recognizer.startContinuousRecognitionAsync(
      () => {},
      (err) => this.cb.onError?.(`azure start failed: ${err}`),
    );
  }

  write(pcm: Buffer) {
    if (this.closed) return;
    // Azure wants an ArrayBuffer; slice to avoid handing it the whole pooled buffer.
    this.pushStream.write(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pushStream.close();
    } catch {
      /* already closed */
    }
    await new Promise<void>((resolve) => {
      this.recognizer.stopContinuousRecognitionAsync(
        () => resolve(),
        () => resolve(),
      );
    });
    try {
      this.recognizer.close();
    } catch {
      /* ignore */
    }
  }
}

export interface TalkCallbacks {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (message: string) => void;
  /**
   * Report EVERY recognized segment instead of only the first.
   *
   * Azure ends an utterance at a pause, and children pause constantly — mid
   * list, mid thought, hunting for the next word. Settling on the first segment
   * is how "I like cars, like Lamborghini... and Bugatti" becomes "I like cars"
   * and the child gets talked over. Callers that need a whole answer set this
   * and decide for themselves when the child is actually finished.
   */
  continuous?: boolean;
}

/**
 * Plain conversational recognition for TALK mode — no pronunciation config.
 * Used for the talk button, for onboarding and check-in replies, and for
 * listening over our own voice during barge-in. PLAN.md §9.2.
 */
export class TalkRecognizer {
  private recognizer: sdk.SpeechRecognizer;
  private pushStream: sdk.PushAudioInputStream;
  private closed = false;
  private settled = false;

  constructor(private cb: TalkCallbacks) {
    this.pushStream = sdk.AudioInputStream.createPushStream(pcmFormat());
    const audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);
    this.recognizer = new sdk.SpeechRecognizer(speechConfig(), audioConfig);

    this.recognizer.recognizing = (_s, e) => {
      if (e.result?.text) this.cb.onPartial?.(e.result.text);
    };
    this.recognizer.recognized = (_s, e) => {
      if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) {
        if (this.settled) return;
        if (!this.cb.continuous) this.settled = true;
        this.cb.onFinal(e.result.text);
      }
    };
    this.recognizer.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        this.cb.onError?.(`azure canceled: ${e.errorDetails}`);
      }
    };

    this.recognizer.startContinuousRecognitionAsync(
      () => {},
      (err) => this.cb.onError?.(`azure start failed: ${err}`),
    );
  }

  write(pcm: Buffer) {
    if (this.closed) return;
    this.pushStream.write(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.pushStream.close();
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      this.recognizer.stopContinuousRecognitionAsync(
        () => resolve(),
        () => resolve(),
      );
    });
    try {
      this.recognizer.close();
    } catch {
      /* ignore */
    }
  }
}

/** One-shot connectivity check used by scripts/smoke.ts. */
export async function checkAzureCredentials(): Promise<void> {
  const c = speechConfig();
  const stream = sdk.AudioInputStream.createPushStream(pcmFormat());
  const recognizer = new sdk.SpeechRecognizer(c, sdk.AudioConfig.fromStreamInput(stream));
  await new Promise<void>((resolve, reject) => {
    recognizer.canceled = (_s, e) => {
      if (e.reason === sdk.CancellationReason.Error) reject(new Error(e.errorDetails));
    };
    recognizer.startContinuousRecognitionAsync(
      () => {
        // 200ms of silence is enough for Azure to reject bad credentials.
        stream.write(new ArrayBuffer(AUDIO.micSampleRate * 2 * 0.2));
        setTimeout(() => {
          stream.close();
          recognizer.stopContinuousRecognitionAsync(
            () => {
              recognizer.close();
              resolve();
            },
            () => resolve(),
          );
        }, 1500);
      },
      (err) => reject(new Error(String(err))),
    );
  });
}
