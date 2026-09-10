import type { ImportRunState, TrackProcessingState } from "./types.ts";

const RUN_TRANSITIONS: Record<ImportRunState, readonly ImportRunState[]> = {
  PLANNED: ["RUNNING", "CANCELLED"],
  RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "FAILED", "CANCELLED"],
  COMPLETED: [],
  FAILED: ["RUNNING", "CANCELLED"],
  CANCELLED: [],
};

const TRACK_TRANSITIONS: Record<TrackProcessingState, readonly TrackProcessingState[]> = {
  DISCOVERED: ["DOWNLOADED", "REJECTED", "PROCESSING_FAILED"],
  DOWNLOADED: ["PARSED", "REJECTED", "PROCESSING_FAILED"],
  PARSED: ["NORMALIZED", "REJECTED", "PROCESSING_FAILED"],
  NORMALIZED: ["MATCHED", "REJECTED", "PROCESSING_FAILED"],
  MATCHED: ["DEDUPLICATED", "REVIEW_REQUIRED", "REJECTED", "PROCESSING_FAILED"],
  DEDUPLICATED: ["QUALIFIED", "REVIEW_REQUIRED", "REJECTED", "PROCESSING_FAILED"],
  QUALIFIED: ["REVIEW_REQUIRED", "APPROVED", "REJECTED"],
  REVIEW_REQUIRED: ["APPROVED", "REJECTED"],
  APPROVED: ["PUBLISHED", "WITHDRAWN"],
  REJECTED: [],
  PROCESSING_FAILED: ["DISCOVERED"],
  PUBLISHED: ["WITHDRAWN"],
  WITHDRAWN: [],
};

export const VALID_RUN_STATES = Object.keys(RUN_TRANSITIONS) as ImportRunState[];
export const VALID_TRACK_STATES = Object.keys(
  TRACK_TRANSITIONS,
) as TrackProcessingState[];

export function canTransitionRun(from: ImportRunState, to: ImportRunState): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionTrack(
  from: TrackProcessingState,
  to: TrackProcessingState,
): boolean {
  return from === to || TRACK_TRANSITIONS[from].includes(to);
}

export function transitionRun(from: ImportRunState, to: ImportRunState): ImportRunState {
  if (!canTransitionRun(from, to)) {
    throw new Error(`Illegal import run transition ${from} -> ${to}`);
  }
  return to;
}

export function transitionTrack(
  from: TrackProcessingState,
  to: TrackProcessingState,
): TrackProcessingState {
  if (!canTransitionTrack(from, to)) {
    throw new Error(`Illegal track transition ${from} -> ${to}`);
  }
  return to;
}
