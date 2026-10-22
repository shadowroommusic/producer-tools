import assert from "node:assert/strict";
import { test } from "node:test";
import { parseButlerCommand } from "../src/lib/butler-command.ts";
import { routeNeedsConfirmation } from "../src/lib/route-policy.ts";

const call = (name, result, routeSource) => ({
  id: "command-1",
  name,
  detail: JSON.stringify({
    arguments: {},
    result: { content: [{ type: "text", text: JSON.stringify(result) }] },
  }),
  ...(routeSource === undefined ? {} : { routeSource }),
});

test("app_command navigate parses the steward echo, not model arguments", () => {
  const parsed = parseButlerCommand(
    call(
      "app_command",
      { accept: true, op: "navigate", view: "studio", reason: "打开 Studio" },
      { text: "去 Studio", mentions: [], sessionId: "butler-1" },
    ),
  );
  assert.deepEqual(parsed, {
    op: "navigate",
    view: "studio",
    reason: "打开 Studio",
    commandId: "command-1",
    sourceText: "去 Studio",
    sourceSessionId: "butler-1",
  });
});

test("app_command dispatch keeps the validated route and source attachments", () => {
  const mention = { name: "hum.wav", path: "/tmp/hum.wav", label: "哼唱" };
  const parsed = parseButlerCommand(
    call(
      "app_command",
      {
        accept: true,
        op: "dispatch",
        route: {
          accept: true,
          target: "studio",
          action_summary: "把哼唱写成 MIDI",
          required_context: ["projectId"],
          confidence: 0.93,
          context_satisfied: false,
          missing_context: ["projectId"],
        },
        reason: "交给 Studio",
      },
      { text: "把这个写成 MIDI", mentions: [mention], sessionId: "butler-1" },
    ),
  );
  assert.equal(parsed?.op, "dispatch");
  assert.equal(parsed?.route.target, "studio");
  assert.equal(parsed?.route.actionSummary, "把哼唱写成 MIDI");
  assert.equal(parsed?.route.confidence, 0.93);
  assert.deepEqual(parsed?.route.missingContext, ["projectId"]);
  assert.equal(parsed?.route.sourceMentions?.[0]?.path, "/tmp/hum.wav");
});

test("legacy route_intent rows remain readable as dispatch commands", () => {
  const parsed = parseButlerCommand(
    call("route_intent", {
      accept: true,
      target: "dj",
      action_summary: "按能量重排当前 Set",
      confidence: 0.88,
      context_satisfied: true,
      missing_context: [],
    }),
  );
  assert.equal(parsed?.op, "dispatch");
  assert.equal(parsed?.route.target, "dj");
});

test("dispatch authorization runs on the nested route, not the navigation wrapper", () => {
  const destructive = parseButlerCommand(
    call("app_command", {
      accept: true,
      op: "dispatch",
      route: {
        accept: true,
        target: "studio",
        action_summary: "删除当前工程",
        confidence: 0.99,
        context_satisfied: true,
        missing_context: [],
      },
    }),
  );
  assert.equal(destructive?.op, "dispatch");
  if (destructive?.op !== "dispatch") throw new Error("expected dispatch");
  assert.equal(routeNeedsConfirmation(destructive.route), true);
});

test("unknown or cross-wired commands fail closed", () => {
  for (const result of [
    { accept: true, op: "navigate", view: "desktop", reason: "打开桌面" },
    { accept: true, op: "navigate", view: "studio", reason: "打开 Studio", selector: ".sr-dock" },
    { accept: true, op: "navigate", view: "studio", route: { target: "studio" } },
    { accept: true, op: "dispatch", view: "studio", route: { target: "studio" } },
    {
      accept: true,
      op: "dispatch",
      route: { target: "settings", action_summary: "打开设置", confidence: 1 },
    },
    { accept: false, op: "navigate", view: "studio" },
  ]) {
    assert.equal(parseButlerCommand(call("app_command", result)), null);
  }
});

test("answer and unknown tool names never become app commands", () => {
  assert.equal(
    parseButlerCommand(call("route_intent", { accept: true, target: "butler_direct" })),
    null,
  );
  assert.equal(
    parseButlerCommand(call("some_other_tool", { accept: true, op: "navigate", view: "studio" })),
    null,
  );
});
