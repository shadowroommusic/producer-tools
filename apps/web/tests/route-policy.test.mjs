import assert from "node:assert/strict";
import { test } from "node:test";
import { routeCanRunDirectly, routeNeedsConfirmation } from "../src/lib/route-policy.ts";

const route = (actionSummary, confidence = 0.94, target = "studio") => ({
  target,
  actionSummary,
  confidence,
  contextSatisfied: true,
  missingContext: [],
});

test("高置信度生成/编辑请求直接执行，不要求点击确认", () => {
  assert.equal(routeCanRunDirectly(route("生成一套 4 小节的 tech house 工程")), true);
  assert.equal(routeCanRunDirectly(route("把 Bass 调暗一点")), true);
  assert.equal(routeNeedsConfirmation(route("导出这首歌")), false);
});

test("空工程上下文不会把安全的生成请求降级成确认卡", () => {
  assert.equal(
    routeCanRunDirectly({
      ...route("生成一首 122 BPM 的 tech house"),
      contextSatisfied: false,
      missingContext: ["projectId"],
    }),
    true,
  );
});

test("低置信度请求仍需确认", () => {
  assert.equal(routeNeedsConfirmation(route("处理一下那个", 0.4)), true);
});

test("破坏性文件/工程操作始终需要确认", () => {
  for (const action of [
    "删除当前工程",
    "清空这个轨道",
    "覆盖原文件",
    "把曲目移到别的文件夹",
    "批量重命名曲目",
    "delete every clip",
  ]) {
    assert.equal(routeNeedsConfirmation(route(action)), true, action);
  }
});

test("非页面目标不进入路径执行", () => {
  assert.equal(routeCanRunDirectly(route("直接回答", 0.99, "butler_direct")), false);
  assert.equal(routeNeedsConfirmation(route("补一句名字", 0.3, "ask_user")), false);
});
