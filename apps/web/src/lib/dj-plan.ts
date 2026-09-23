/**
 * The DJ set's timing payloads: how a library track becomes a planner track (cue roles become
 * the planner's A/B segment points) and the duration format plan_set itself prints, so the
 * topbar readouts match the plugin to the second.
 */

/** Minimal track shape the planner payload needs; TrackDetail in DjPage satisfies it. */
export type PlannerSource = {
  id: number;
  title: string | null;
  artist: string | null;
  bpm: number | null;
  key: string | null;
  camelot: string | null;
  energy: number | null;
  duration_ms: number | null;
  genre?: string | null;
  cues?: Array<{
    position_ms: number;
    end_ms?: number | null;
    kind?: string;
    role?: string | null;
  }>;
};

/**
 * plan_set/order_set speak cue A / cue B: role "in" is A, role "out" is B, and a loop with an
 * end_ms bounds the segment from the A side. Hot cues without a role are not timing data and a
 * loop without an end cannot bound anything, so neither is sent.
 */
export function plannerTrackPayload(track: PlannerSource) {
  return {
    id: String(track.id),
    title: track.title ?? "",
    artist: track.artist ?? "",
    bpm: track.bpm,
    key: track.camelot ?? track.key,
    genres: track.genre ? [track.genre] : [],
    energy: track.energy,
    duration_ms: track.duration_ms,
    cues: (track.cues ?? [])
      .filter((cue) => cue.role === "in" || cue.role === "out" || (cue.kind === "loop" && cue.end_ms != null))
      .map((cue) => ({
        name: cue.role === "out" ? "B" : "A",
        position_ms: cue.position_ms,
        kind: cue.kind === "loop" ? "loop" : "cue",
        end_ms: cue.kind === "loop" ? (cue.end_ms ?? undefined) : undefined,
      })),
  };
}

/** Same format as the plugin's format_duration: m:ss, or h:mm:ss past the hour. */
export function formatPlanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
