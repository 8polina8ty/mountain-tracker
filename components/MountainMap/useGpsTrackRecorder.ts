"use client";

import {
  useCallback,
  useMemo,
  useReducer,
  useState,
} from "react";

import {
  computeTrackStats,
  createInitialRecorderState,
  trackRecorderReducer,
} from "./trackRecording";
import type {
  TrackRecorderState,
  TrackStats,
  FinishedRecordingSnapshot,
} from "./trackRecording";
import type { UserGpsPosition } from "./types";

export type GpsTrackRecorder = {
  state: TrackRecorderState;
  stats: TrackStats;
  gpsUnavailable: boolean;
  start: (
    initialPosition?: UserGpsPosition | null,
  ) => void;
  pause: () => void;
  resume: () => void;
  finish: () => void;
  reset: () => void;
  restoreFinished: (snapshot: FinishedRecordingSnapshot) => void;
  acceptGpsPosition: (position: UserGpsPosition) => void;
  acceptGpsError: () => void;
};

export function useGpsTrackRecorder(): GpsTrackRecorder {
  const [state, dispatch] = useReducer(
    trackRecorderReducer,
    undefined,
    createInitialRecorderState,
  );

  const [gpsUnavailable, setGpsUnavailable] =
    useState(false);

  const start = useCallback(
    (initialPosition?: UserGpsPosition | null) => {
      setGpsUnavailable(false);
      dispatch({ type: "start", now: Date.now() });

      if (initialPosition) {
        dispatch({
          type: "acceptPosition",
          position: initialPosition,
        });
      }
    },
    [],
  );

  const pause = useCallback(() => {
    dispatch({ type: "pause", now: Date.now() });
  }, []);

  const resume = useCallback(() => {
    setGpsUnavailable(false);
    dispatch({ type: "resume", now: Date.now() });
  }, []);

  const finish = useCallback(() => {
    dispatch({ type: "finish", now: Date.now() });
  }, []);

  const reset = useCallback(() => {
    setGpsUnavailable(false);
    dispatch({ type: "reset" });
  }, []);

  const restoreFinished = useCallback((snapshot: FinishedRecordingSnapshot) => {
    setGpsUnavailable(false);
    dispatch({ type: "restoreFinished", snapshot });
  }, []);

  const acceptGpsPosition = useCallback(
    (position: UserGpsPosition) => {
      setGpsUnavailable(false);
      dispatch({ type: "acceptPosition", position });
    },
    [],
  );

  const acceptGpsError = useCallback(() => {
    setGpsUnavailable(true);
  }, []);

  const stats = useMemo(
    () => computeTrackStats(state.points),
    [state.points],
  );

  return {
    state,
    stats,
    gpsUnavailable,
    start,
    pause,
    resume,
    finish,
    reset,
    restoreFinished,
    acceptGpsPosition,
    acceptGpsError,
  };
}
