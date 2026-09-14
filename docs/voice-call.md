# The voice call

What the microphone button does, and how the turn-taking is decided. The behaviour below was measured
in Chrome (headless, with `--use-file-for-fake-audio-capture`) plus `apps/web/tests/voice.test.mjs`;
the thresholds will be revisited on real speakers.

## Shape

One tap starts a **call**, not a dictation. The composer card becomes 48 live bars, the microphone
stays open for the whole call, and every turn carries the WAV of the phrase that asked for it (saved
through `POST /api/agent/audio` into `~/Documents/ShadowRoom/recordings`). The answer is spoken with
`speechSynthesis` and the call goes back to listening.

## Two detectors, one microphone

`apps/web/src/lib/voice.ts` holds both as pure functions so they can be driven with synthetic
loudness traces (`pnpm test`):

| Detector | Decides | While |
| --- | --- | --- |
| `createTurnDetector` | the user's turn is over after ~900 ms of quiet following speech | the user has the turn |
| `createBargeIn` | the user is talking over the answer | the answer is playing |

The turn end is **not** the recognizer's final result: Chrome ends results on its own (a pause in the
middle of a sentence splits them), so the text accumulates and quiet decides. The noise floor adapts
(falls at once, creeps back up) so a fan in the room does not become the baseline.

Barge-in cannot use an absolute level, because the answer itself leaks into the microphone on
speakers. It fires on a *jump above a peak-hold baseline* (the answer's own loudness) sustained for
260 ms, and ignores the first 500 ms so an answer cannot cut itself off on its first word. Two
measured traps, both now covered by tests:

- a plain EMA baseline (5 %/frame) swallowed a 0.45 voice over a 0.18 answer within ~250 ms — the
  answer rose to meet the interruption and nothing ever fired;
- an averaging baseline dropped during the pauses between words, so the next word looked like a
  voice-over; a peak hold with a slow decay fixed that.

## Three races the state machine has to handle

1. **A stopped recognizer still fires `onend`.** `moveVoice()` writes the state ref before React's
   state, because stopping the recognizer calls back synchronously and the old code saw "still
   listening" and opened the user's turn a second time.
2. **A replaced session still fires `onresult`/`onend`.** Every listening session carries a token
   (`listenToken`); callbacks from an older one are dropped. Without it a phrase came back as the
   phrase twice.
3. **A canceled answer still fires `onend`.** `answerToken` invalidates the callback of an answer the
   user interrupted, so it cannot resume listening twice.

`SpeechSynthesis` is also fed `speechText()` — the answer with code fences, backticks, markdown
emphasis and links removed, since those only make sense on screen.

## Not verified yet

Real speakers (echo that survives `echoCancellation`), an actual human interrupting, and Chrome's
own recognition behaviour on a long call. The thresholds live in one place (`createTurnDetector` /
`createBargeIn` defaults) precisely so they can be tuned after that test.
