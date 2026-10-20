/**
 * S2：句级朗读队列（任务 voice-conversation-20261020）。
 *
 * 钉四件事：串行（同一时刻只有一句在播）、句间 120ms、新句不许取消当前句、
 * 取消后迟到的 onEnd 不许再开口。另有超时与错误两条退出路径。
 *
 * Run with `pnpm test`（Node 自带 runner，`.ts` 由 Node 24 剥类型）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SPEECH_GAP_MS, createSpeechQueue } from "../src/lib/tts-queue.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 假的播放器：一次只允许一句，手动开始/结束，记录并发与 cancel 次数。 */
function createSpeaker() {
  const log = [];
  const state = { active: 0, maxActive: 0, cancelCalls: 0, pending: null };
  return {
    provider: {
      speak: (text, options) => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        log.push(text);
        state.pending = { text, options };
      },
      cancel: () => {
        state.cancelCalls += 1;
      },
    },
    log,
    start: () => {
      state.pending?.options.onStart?.();
    },
    end: () => {
      const pending = state.pending;
      state.pending = null;
      state.active -= 1;
      pending?.options.onEnd?.();
    },
    fail: (message) => {
      const pending = state.pending;
      state.pending = null;
      state.active -= 1;
      pending?.options.onError?.(message);
    },
    state,
  };
}

test("按入队顺序逐句播放，同一时刻最多一句", async () => {
  const speaker = createSpeaker();
  const queue = createSpeechQueue({ speaker: () => speaker.provider, sleep: async () => undefined });
  queue.push("第一句。");
  queue.push("第二句。");
  queue.push("第三句。");
  assert.deepEqual(speaker.log, ["第一句。"]);
  await tick();
  speaker.end();
  await tick();
  assert.deepEqual(speaker.log, ["第一句。", "第二句。"]);
  speaker.end();
  await tick();
  assert.deepEqual(speaker.log, ["第一句。", "第二句。", "第三句。"]);
  speaker.end();
  await queue.whenIdle();
  assert.equal(speaker.state.maxActive, 1, "同一时刻只能有一句在播");
  assert.equal(speaker.state.cancelCalls, 0);
});

test("句间停顿是 120ms（在 100–160ms 之内）", async () => {
  const speaker = createSpeaker();
  const gaps = [];
  const queue = createSpeechQueue({
    speaker: () => speaker.provider,
    sleep: async (ms) => {
      gaps.push(ms);
    },
  });
  queue.push("一。");
  queue.push("二。");
  queue.push("三。");
  for (let index = 0; index < 3; index += 1) {
    await tick();
    speaker.end();
  }
  await queue.whenIdle();
  assert.equal(SPEECH_GAP_MS, 120);
  assert.deepEqual(gaps, [120, 120], "只在两两之间停顿，最后一句后不再等");
  assert.ok(gaps.every((ms) => ms >= 100 && ms <= 160));
});

test("新句不取消当前句", async () => {
  const speaker = createSpeaker();
  const queue = createSpeechQueue({ speaker: () => speaker.provider, sleep: async () => undefined });
  queue.push("第一句。");
  await tick();
  queue.push("第二句。");
  assert.equal(speaker.state.cancelCalls, 0, "push 不许 cancel 正在播的那句");
  assert.equal(speaker.log.length, 1, "第二句要等第一句播完");
  speaker.end();
  await tick();
  assert.deepEqual(speaker.log, ["第一句。", "第二句。"]);
  speaker.end();
});

test("clear 幂等：只 cancel 一次，之后不再开口", async () => {
  const speaker = createSpeaker();
  const queue = createSpeechQueue({ speaker: () => speaker.provider, sleep: async () => undefined });
  queue.push("第一句。");
  await tick();
  queue.clear();
  queue.clear();
  assert.equal(speaker.state.cancelCalls, 1);
  // 被取消的那句迟到的 onEnd 不得再启动任何东西。
  speaker.end();
  await tick();
  assert.equal(speaker.log.length, 1);
  assert.equal(queue.pending(), 0);
});

test("取消后迟到的 onEnd 不触发下一句，也不触发 onIdle", async () => {
  const speaker = createSpeaker();
  let idle = 0;
  const queue = createSpeechQueue({
    speaker: () => speaker.provider,
    sleep: async () => undefined,
    onIdle: () => {
      idle += 1;
    },
  });
  queue.push("第一句。");
  queue.push("第二句。");
  await tick();
  queue.clear();
  speaker.end();
  await tick();
  assert.deepEqual(speaker.log, ["第一句。"]);
  assert.equal(idle, 0, "取消不是说完");
});

test("自然播完时 onIdle 只触发一次", async () => {
  const speaker = createSpeaker();
  let idle = 0;
  const queue = createSpeechQueue({
    speaker: () => speaker.provider,
    sleep: async () => undefined,
    onIdle: () => {
      idle += 1;
    },
  });
  queue.push("一。");
  queue.push("二。");
  await tick();
  speaker.end();
  await tick();
  speaker.end();
  await queue.whenIdle();
  assert.equal(idle, 1);
  // 再播一轮，idle 再触发一次（不是永久静音）。
  queue.push("三。");
  await tick();
  speaker.end();
  await queue.whenIdle();
  assert.equal(idle, 2);
});

test("空白文本不入队", async () => {
  const speaker = createSpeaker();
  const queue = createSpeechQueue({ speaker: () => speaker.provider, sleep: async () => undefined });
  assert.equal(queue.push("   "), false);
  assert.equal(queue.pending(), 0);
  assert.equal(speaker.log.length, 0);
});

test("合成失败会报原因，并继续下一句", async () => {
  const speaker = createSpeaker();
  const errors = [];
  let idle = 0;
  const queue = createSpeechQueue({
    speaker: () => speaker.provider,
    sleep: async () => undefined,
    onError: (message) => errors.push(message),
    onIdle: () => {
      idle += 1;
    },
  });
  queue.push("一。");
  queue.push("二。");
  await tick();
  speaker.fail("voice not found");
  await tick();
  assert.deepEqual(errors, ["voice not found"]);
  assert.deepEqual(speaker.log, ["一。", "二。"]);
  speaker.end();
  await queue.whenIdle();
  assert.equal(idle, 1);
});

test("播放器不回调时会超时退出，不会卡住队列", async () => {
  const speaker = createSpeaker();
  const errors = [];
  let idle = 0;
  const queue = createSpeechQueue({
    speaker: () => speaker.provider,
    sleep: async () => undefined,
    timeoutMs: 20,
    onError: (message) => errors.push(message),
    onIdle: () => {
      idle += 1;
    },
  });
  queue.push("一。");
  await queue.whenIdle();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /超时/);
  assert.equal(speaker.state.cancelCalls, 1, "卡住的播放器要被 cancel");
  assert.equal(idle, 1);
});

test("clear 之后 whenIdle 也会放行", async () => {
  const speaker = createSpeaker();
  const queue = createSpeechQueue({ speaker: () => speaker.provider, sleep: async () => undefined });
  queue.push("一。");
  await tick();
  const settled = queue.whenIdle();
  queue.clear();
  await settled;
  assert.equal(queue.pending(), 0);
});

test("clear 取消的是实际在播的实例，不是 speaker() 现在返回的那个", async () => {
  const first = createSpeaker();
  const second = createSpeaker();
  let useSecond = false;
  const queue = createSpeechQueue({
    speaker: () => (useSecond ? second.provider : first.provider),
    sleep: async () => undefined,
  });
  queue.push("一。");
  await tick();
  // 换 plan/回退：getter 已经指向新实例，但旧音频还在响。
  useSecond = true;
  queue.clear();
  assert.equal(first.state.cancelCalls, 1, "必须取消真正在播的旧实例");
  assert.equal(second.state.cancelCalls, 0, "不许误伤新实例");
});

test("clear 进行中 push 新句：泵重启且句子不丢", async () => {
  const speaker = createSpeaker();
  const queue = createSpeechQueue({ speaker: () => speaker.provider, sleep: async () => undefined });
  queue.push("一。");
  await tick();
  queue.clear();
  queue.push("二。");
  queue.push("三。");
  await tick();
  assert.deepEqual(speaker.log, ["一。", "二。"]);
  speaker.end();
  await tick();
  assert.deepEqual(speaker.log, ["一。", "二。", "三。"]);
  speaker.end();
  await queue.whenIdle();
});

test("prepare 只在当前句开口后预取紧邻的下一句", async () => {
  const speaker = createSpeaker();
  const prepared = [];
  const provider = {
    ...speaker.provider,
    prepare: (text) => prepared.push(text),
  };
  const queue = createSpeechQueue({ speaker: () => provider, sleep: async () => undefined });
  queue.push("一。");
  queue.push("二。");
  queue.push("三。");
  await tick();
  assert.deepEqual(prepared, [], "还没开口不许预取");
  speaker.start();
  assert.deepEqual(prepared, ["二。"], "开口后只预取紧邻的一句");
  speaker.end();
  await tick();
  speaker.start();
  assert.deepEqual(prepared, ["二。", "三。"]);
  speaker.end();
  await tick();
  // 第三句也要收尾，否则队列永远等它的 onEnd。
  speaker.end();
  await queue.whenIdle();
});

test("onStart 上报当前句（首声延迟测量点）", async () => {
  const speaker = createSpeaker();
  const started = [];
  const queue = createSpeechQueue({
    speaker: () => speaker.provider,
    sleep: async () => undefined,
    onStart: (text) => started.push(text),
  });
  queue.push("一。");
  await tick();
  speaker.start();
  speaker.end();
  await queue.whenIdle();
  assert.deepEqual(started, ["一。"]);
});
