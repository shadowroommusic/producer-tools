/**
 * The DJ page's planner payloads: cue roles must land on the planner's A/B segment points (that
 * is what plan_set times and what the topbar readouts are checked against), and the duration
 * format must match the plugin's format_duration to the second.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPlanDuration, plannerTrackPayload } from "../src/lib/dj-plan.ts";

test("formatPlanDuration matches the plugin's format_duration", () => {
  assert.equal(formatPlanDuration(0), "0:00");
  assert.equal(formatPlanDuration(59_500), "1:00"); // rounds to the nearest second
  assert.equal(formatPlanDuration(754_000), "12:34");
  assert.equal(formatPlanDuration(3_600_000), "1:00:00");
  assert.equal(formatPlanDuration(3_723_400), "1:02:03");
  assert.equal(formatPlanDuration(-5), "0:00");
});

test("plannerTrackPayload maps cue roles to the planner's A/B points", () => {
  const payload = plannerTrackPayload({
    id: 7,
    title: "T",
    artist: null,
    bpm: 128,
    key: "Am",
    camelot: "8A",
    energy: 5,
    duration_ms: 300_000,
    genre: "house",
    cues: [
      { position_ms: 1_000, role: "in", kind: "cue" },
      { position_ms: 200_000, role: "out", kind: "cue" },
      { position_ms: 50_000, kind: "loop", end_ms: 60_000 },
      { position_ms: 70_000, kind: "cue" }, // a hot cue without a role is not timing data
      { position_ms: 80_000, kind: "loop" }, // a loop without an end cannot bound a segment
    ],
  });
  assert.deepEqual(payload.cues, [
    { name: "A", position_ms: 1_000, kind: "cue", end_ms: undefined },
    { name: "B", position_ms: 200_000, kind: "cue", end_ms: undefined },
    { name: "A", position_ms: 50_000, kind: "loop", end_ms: 60_000 },
  ]);
  assert.equal(payload.key, "8A"); // Camelot wins over musical notation
  assert.deepEqual(payload.genres, ["house"]);
});

test("plannerTrackPayload tolerates missing metadata", () => {
  const payload = plannerTrackPayload({
    id: 3,
    title: null,
    artist: null,
    bpm: null,
    key: null,
    camelot: null,
    energy: null,
    duration_ms: null,
  });
  assert.equal(payload.id, "3");
  assert.equal(payload.key, null);
  assert.deepEqual(payload.genres, []);
  assert.deepEqual(payload.cues, []);
});
