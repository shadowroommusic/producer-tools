/** Page-owned facts sent with a worker turn. They are message metadata, never separate threads. */

export type DjAgentContext = {
  id: string;
  name: string;
  trackCount: number;
  overlapMs: number;
  tracks: Array<{
    trackId: number;
    title: string;
    bpm: number | null;
    key: string | null;
    durationMs: number | null;
  }>;
};

export type LibraryAgentContext = {
  total: number;
  visible: number;
  filters: {
    query: string;
    bpmMin: string;
    bpmMax: string;
    camelot: string;
    tag: string;
  };
  selected: {
    id: number;
    title: string;
    artist: string | null;
    bpm: number | null;
    key: string | null;
  } | null;
};

/** A tool result may update Studio only if its originating project is still the one on screen. */
export function toolResultBelongsToOpenProject(
  kind: string,
  turnProjectId: string | undefined,
  currentProjectId: string | undefined,
): boolean {
  return kind !== "studio" || turnProjectId === undefined || turnProjectId === currentProjectId;
}
