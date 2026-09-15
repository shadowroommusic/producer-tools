/**
 * One microphone, shared by whoever needs it.
 *
 * The voice mode listens almost all the time; the 录音 button needs the same device. Asking twice
 * works on macOS (the system mixes it), but it shows a second "is using the microphone" indicator,
 * costs a second permission path, and gets confusing the moment one of them stops a track the other
 * is still reading. So there is one `getUserMedia` call, reference counted: the first asker opens it,
 * the last one to let go closes it.
 *
 * Suspending the voice mode while recording would work too — and it was rejected: a suspend that is
 * never resumed looks exactly like a broken feature, and the user has no way to tell the difference.
 */

type Listener = (stream: MediaStream | null) => void;

let stream: MediaStream | null = null;
let pending: Promise<MediaStream> | null = null;
let holders = 0;
const listeners = new Set<Listener>();

function announce(): void {
  for (const listener of listeners) listener(stream);
}

/** Watch the shared stream (null while nobody holds it). Returns an unsubscribe function. */
export function onMicrophoneChange(listener: Listener): () => void {
  listeners.add(listener);
  listener(stream);
  return () => {
    listeners.delete(listener);
  };
}

/** The stream currently open, if any. */
export function currentMicrophone(): MediaStream | null {
  return stream;
}

/**
 * Take a reference to the microphone, opening it if this is the first asker.
 * @throws whatever `getUserMedia` throws (permission denied, no device).
 */
export async function acquireMicrophone(constraints?: MediaStreamConstraints): Promise<MediaStream> {
  holders += 1;
  if (stream !== null && stream.getAudioTracks().some((track) => track.readyState === "live")) {
    return stream;
  }
  if (pending === null) {
    pending = navigator.mediaDevices
      .getUserMedia(constraints ?? { audio: true })
      .then((opened) => {
        stream = opened;
        /* A device that is unplugged mid-session ends its tracks; the next asker should reopen. */
        for (const track of opened.getAudioTracks()) track.addEventListener("ended", () => announce());
        announce();
        return opened;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** Give the reference back; the last one closes the device. */
export function releaseMicrophone(): void {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return;
  const closing = stream;
  stream = null;
  if (closing !== null) for (const track of closing.getTracks()) track.stop();
  announce();
}

/** How many holders are using the microphone right now (tests and diagnostics). */
export function microphoneHolders(): number {
  return holders;
}
