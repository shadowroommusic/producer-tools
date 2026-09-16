/**
 * agent-bridge 的 noteMediaEvent：适配器内部跑过的媒体工具要被记录（Studio 靠它吸收结果）。
 *
 * 桥的函数不导出（它是一个服务器脚本），所以测试从**真实源文件**里提取这一个函数再在桩上运行——
 * 源文件一改，测试跟着改，不会测到一份过时的拷贝。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const bridge = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tools", "agent-bridge.mjs"),
  "utf8",
);
const start = bridge.indexOf("function noteMediaEvent(entry) {");
const end = bridge.indexOf("\n}", start);
if (start === -1 || end === -1) throw new Error("noteMediaEvent not found in agent-bridge.mjs");
const source = bridge.slice(start, end + 2);

/** Run the real function body against a fresh stub. */
function record(entry) {
  const MEDIA_EVENTS = [];
  const fn = new Function("MEDIA_EVENTS", source + "\nreturn noteMediaEvent;");
  const noteMediaEvent = fn(MEDIA_EVENTS);
  noteMediaEvent(entry);
  return MEDIA_EVENTS;
}

test("the media-event whitelist covers the tools Studio absorbs", () => {
  const tools = [
    "render_song",
    "render_part",
    "regenerate_part", // 「只改鼓」换片段文件：结果里的文件路径 + 参数里的 clip_id
    "separate_stems",
    "generate_music",
    "transform_notes", // 音符编辑：靠参数里的 clip_id
    "arrange", // 结构编辑
  ];
  for (const tool of tools) {
    const events = record({ server: "shadow-music-generator", tool, ok: true, resultText: "{}", args: {} });
    assert.equal(events.length, 1, `${tool} must be recorded`);
  }
  const ignored = record({ server: "shadow-music-generator", tool: "detect_tempo", ok: true, resultText: "{}", args: {} });
  assert.equal(ignored.length, 0, "analysis tools are not media: no event");
});

test("the event carries the call's arguments (clip_id lives only there)", () => {
  const args = { clip_id: "clip-abc", patch: { gain_db: -4 } };
  const [event] = record({
    server: "shadow-music-generator",
    tool: "regenerate_part",
    ok: true,
    resultText: '{"path": "/tmp/drums-v2.wav"}',
    args,
  });
  assert.equal(event.tool, "regenerate_part");
  assert.deepEqual(event.args, args);
  assert.equal(event.text, '{"path": "/tmp/drums-v2.wav"}');
  assert.equal(typeof event.id, "number");
  assert.equal(typeof event.at, "number");
});

test("ids stay monotonic even past the 50-event ring", () => {
  // 旧实现 id = length+1，环形裁剪后 id 会撞车，轮询游标（since=）会漏事件。
  
  const MEDIA_EVENTS = Array.from({ length: 50 }, (_, index) => ({ id: index + 1 }));
  const fn = new Function("MEDIA_EVENTS", source + "\nreturn noteMediaEvent;");
  fn(MEDIA_EVENTS)({ server: "s", tool: "render_song", ok: true, resultText: "", args: {} });
  assert.equal(MEDIA_EVENTS.length, 50);
  assert.equal(MEDIA_EVENTS[MEDIA_EVENTS.length - 1].id, 51, "new id must be past every id ever issued");
});
