import assert from "node:assert/strict";
import { before, test } from "node:test";

let scopedMcpServers;
let scopeAllowsTool;
let developerInstructionsFor;
let flattenAdapterTools;

before(async () => {
  process.env.SHADOWROOM_ADAPTER_TEST = "1";
  ({ scopedMcpServers, scopeAllowsTool, developerInstructionsFor, flattenAdapterTools } =
    await import("../../../tools/agent-bridge.mjs"));
});

test("butler sees only the steward ledger", () => {
  const servers = scopedMcpServers("butler");
  assert.equal(servers.steward.enabled, undefined);
  assert.deepEqual(servers.steward.enabled_tools, [
    "situation_report",
    "recent_events",
    "focus_change",
    "report_done",
    "route_intent",
  ]);
  for (const name of Object.keys(servers).filter((name) => name !== "steward")) {
    assert.equal(servers[name].enabled, false, `${name} must be hidden from butler`);
  }
});

test("butler routes executable domain work only, not conversational replies", () => {
  const text = developerInstructionsFor("butler");
  assert.match(text, /只有用户明确要求执行一个会改变 Studio\/DJ\/曲库状态的领域动作/);
  assert.match(text, /「不需要了」/);
  assert.match(text, /直接回答，不要调用 route_intent/);
  assert.match(text, /使用该附件/);
  assert.match(text, /不要回复让用户重新录一遍/);
});

test("Studio and DJ cannot drift into each other's tools", () => {
  const studio = scopedMcpServers("studio");
  assert.equal(studio["set-planner"].enabled, false);
  assert.equal(studio["rekordbox-serato-bridge"].enabled, false);
  assert.equal(studio["shadow-music-generator"].enabled, undefined);
  assert.equal(studio["stem-splitter"].enabled, undefined);
  assert.equal(studio["soundfont-renderer"].enabled, undefined);

  const dj = scopedMcpServers("dj");
  assert.equal(dj["shadow-music-generator"].enabled, false);
  assert.equal(dj["stem-splitter"].enabled, false);
  assert.equal(dj["soundfont-renderer"].enabled, false);
  assert.equal(dj["rekordbox-serato-bridge"].enabled, false);
  assert.equal(dj["set-planner"].enabled, undefined);
  assert.ok(!dj.library.enabled_tools.some((name) => /crate_(create|add|remove)|track_(remove|rename|edit)/.test(name)));
});

test("library hides creation tools; Grabber remains page-local", () => {
  const library = scopedMcpServers("library");
  assert.equal(library["shadow-music-generator"].enabled, false);
  assert.equal(library.ShadowMusicGrabber.enabled, undefined);
  assert.equal(library.library.enabled, undefined);
  assert.deepEqual(library["stem-splitter"].enabled_tools, ["stem_backends", "stem_job_status"]);
});

test("all nine servers are explicitly projected for every scope", () => {
  for (const scope of ["butler", "studio", "dj", "library"]) {
    const servers = scopedMcpServers(scope);
    assert.equal(Object.keys(servers).length, 9, `${scope} must project all servers with disabled ones explicit`);
  }
});

test("execution-time guard mirrors each scope instead of trusting the exposed schema", () => {
  assert.equal(scopeAllowsTool("butler", "steward", "route_intent"), true);
  assert.equal(scopeAllowsTool("butler", "shadow-music-generator", "render_song"), false);
  assert.equal(scopeAllowsTool("studio", "shadow-music-generator", "render_song"), true);
  assert.equal(scopeAllowsTool("studio", "set-planner", "plan_set"), false);
  assert.equal(scopeAllowsTool("dj", "set-planner", "plan_set"), true);
  assert.equal(scopeAllowsTool("dj", "set_planner", "plan_set"), true);
  assert.equal(scopeAllowsTool("dj", "audio_analysis_dedupe", "detect_tempo"), true);
  assert.equal(scopeAllowsTool("dj", "rekordbox-serato-bridge", "list_sets"), false);
  assert.equal(scopeAllowsTool("library", "library", "scan_folder"), true);
  assert.equal(scopeAllowsTool("library", "ShadowMusicGrabber", "convert_audio"), true);
  assert.equal(scopeAllowsTool("library", "shadow-music-generator", "render_song"), false);
});

test("page prompts mention only capabilities that page can call", () => {
  const dj = developerInstructionsFor("dj");
  assert.match(dj, /set-planner/);
  assert.doesNotMatch(dj, /render_song|separate_stems|rekordbox-serato-bridge/);

  const library = developerInstructionsFor("library");
  assert.match(library, /ShadowMusicGrabber/);
  assert.doesNotMatch(library, /render_song|plan_set|set-planner/);
});

test("chat providers receive MCP tools only, never Codex shell or subagent tools", () => {
  const { tools, nameMap } = flattenAdapterTools([
    { type: "function", name: "exec_command" },
    { type: "function", name: "multi_agent_v1" },
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [{ type: "function", name: "spawn_agent", parameters: { type: "object" } }],
    },
    {
      type: "namespace",
      name: "mcp__steward",
      tools: [{ type: "function", name: "route_intent", parameters: { type: "object" } }],
    },
  ]);
  assert.deepEqual(tools.map((tool) => tool.function.name), ["mcp__steward__route_intent"]);
  assert.deepEqual(nameMap.get("mcp__steward__route_intent"), { server: "steward", tool: "route_intent" });
});

// think 跨 chunk 的剥离已上收到 tools/think-stream.mjs 的流式状态机（bridge 的 delta 出口），
// adapter 不再做可见文本过滤——同一场景的断言在 tests/think-stream.test.mjs。

test("every scope carries the voice call rules (S5 contract)", () => {
  for (const scope of ["butler", "studio", "dj", "library"]) {
    const text = developerInstructionsFor(scope);
    assert.ok(text.includes("[voice_call_rules]"), `${scope} 缺 voice_call_rules`);
    assert.ok(text.includes("第一句直接给回答"), `${scope} 缺「先答结论」`);
    assert.ok(text.includes("不主动播报"), `${scope} 缺「不播报状态」`);
    assert.ok(text.includes("永不朗读"), `${scope} 缺「不朗读日志」`);
  }
});
