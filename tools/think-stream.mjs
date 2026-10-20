/**
 * Streaming `<think>…</think>` splitter for assistant deltas.
 *
 * Some chat-completions providers (DeepSeek-style) inline their reasoning as literal
 * `<think>…</think>` inside the message text. The bridge must not forward that as answer text —
 * it goes out as a reasoning event instead, and the answer only carries the clean prose.
 *
 * The tags can straddle chunk boundaries in any split, so this is a small state machine that
 * holds back only the bytes that could still become a tag. `flush()` settles a stream that ends
 * mid-tag or with an unclosed think: held bytes go back to the channel they came from, so an
 * unfinished think never swallows the answer (a `<think>` that never closes still emits its
 * content as reasoning — visible, not lost).
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/**
 * How many leading bytes of `candidate` match `tag` (0 = none). Used to decide whether the tail
 * of a buffer is a (possibly partial) tag worth holding back.
 */
function prefixLen(candidate, tag) {
  const max = Math.min(candidate.length, tag.length);
  let n = 0;
  while (n < max && candidate[n] === tag[n]) n += 1;
  return n;
}

export function createThinkFilter() {
  let inside = false;
  let hold = "";

  const push = (chunk) => {
    let text = "";
    let reasoning = "";
    let buffer = hold + chunk;
    hold = "";
    while (buffer !== "") {
      const tag = inside ? CLOSE : OPEN;
      const at = buffer.indexOf("<");
      if (at === -1) {
        if (inside) reasoning += buffer;
        else text += buffer;
        buffer = "";
        break;
      }
      if (at > 0) {
        const head = buffer.slice(0, at);
        if (inside) reasoning += head;
        else text += head;
        buffer = buffer.slice(at);
      }
      const matched = prefixLen(buffer, tag);
      if (matched === tag.length) {
        buffer = buffer.slice(tag.length);
        inside = !inside;
        continue;
      }
      if (buffer.length < tag.length && matched === buffer.length) {
        // Could still grow into the tag across the next chunk — hold it back.
        hold = buffer;
        buffer = "";
        break;
      }
      // A "<" that cannot become the tag: emit it and keep scanning after it.
      if (inside) reasoning += "<";
      else text += "<";
      buffer = buffer.slice(1);
    }
    return { text, reasoning };
  };

  /** Settle the stream: held partial-tag bytes return to their own channel verbatim. */
  const flush = () => {
    if (hold === "") return { text: "", reasoning: "" };
    const out = { text: "", reasoning: "" };
    if (inside) out.reasoning = hold;
    else out.text = hold;
    hold = "";
    return out;
  };

  return { push, flush };
}

/**
 * Strip `<think>` blocks from a finished string in one pass (history migration, TTS fallback).
 * Returns the clean text and every think payload in order. An unclosed final think counts as
 * reasoning too — same rule the streaming filter applies on flush.
 */
export function splitThinkBlocks(text) {
  let clean = "";
  const thinks = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf(OPEN);
    if (open === -1) {
      clean += rest;
      break;
    }
    clean += rest.slice(0, open);
    rest = rest.slice(open + OPEN.length);
    const close = rest.indexOf(CLOSE);
    if (close === -1) {
      thinks.push(rest);
      break;
    }
    thinks.push(rest.slice(0, close));
    rest = rest.slice(close + CLOSE.length);
  }
  return { text: clean, thinks };
}

/**
 * Access presets: the one place that maps the UI's three access levels onto the sandbox and
 * approval vocabulary the Codex core understands. The web UI sends only the access id; both the
 * thread/start and thread/settings/update paths read this table (2026-10-20 verified against the
 * running app-server: the three sandboxPolicy JSON shapes and both approval values are accepted
 * and echoed back by thread/settings/updated).
 */
export const ACCESS_PRESETS = {
  "read-only": {
    sandboxSlug: "read-only",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    approvalPolicy: "on-request",
  },
  "workspace-write": {
    sandboxSlug: "workspace-write",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    approvalPolicy: "on-request",
  },
  "danger-full-access": {
    sandboxSlug: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" },
    approvalPolicy: "never",
  },
};

export function accessPreset(access) {
  return ACCESS_PRESETS[access] ?? ACCESS_PRESETS["workspace-write"];
}
