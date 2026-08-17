import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ACCURACY_THRESHOLD_FACTOR,
  BASE_MIN_MOVEMENT_M,
  EARTH_RADIUS_M,
  ELEVATION_GAIN_JITTER_THRESHOLD_M,
  MAX_GPS_ACCURACY_M,
  MAX_IMPLIED_SPEED_KMH,
  MIN_TRACK_POINTS,
  MOVEMENT_CONFIRM_SAMPLES,
  bearingDegrees,
  buildGpxFilename,
  buildGpxTrackName,
  buildGpxXml,
  buildTrackLineGeoJson,
  computeTrackStats,
  createInitialRecorderState,
  escapeXml,
  formatDistanceValue,
  getActiveDurationMs,
  getDurationParts,
  getVisualPosition,
  haversineDistanceMeters,
  movementThresholdM,
  normalizeTrackPoint,
  trackRecorderReducer,
  usesKilometers,
} from "../components/MountainMap/trackRecording.ts";
import {
  clearPendingRecordingDraft,
  loadPendingRecordingDraft,
  normalizePendingRecordingDraft,
  parsePendingRecordingDraft,
  persistPendingRecordingDraft,
  PENDING_RECORDING_STORAGE_KEY,
  serializePendingRecordingDraft,
} from "../components/MountainMap/pendingRecordingDraft.ts";
import {
  USER_RECORDED_PREVIEW_SOURCE_ID,
  USER_RECORDED_TRACK_SOURCE_ID,
  synchronizeTrackRecordingSources,
} from "../components/MountainMap/trackRecordingLayers.ts";

const LOCALES = ["de", "en", "ru", "fr", "it", "es"];

function gpsPosition(overrides = {}) {
  return {
    latitude: 47.05,
    longitude: 8.3,
    altitudeM: 1500,
    accuracyM: 10,
    altitudeAccuracyM: null,
    speedMps: null,
    headingDeg: null,
    timestamp: 1755400000000,
    ...overrides,
  };
}

function recordingState(points = []) {
  return {
    ...createInitialRecorderState(),
    status: "recording",
    startedAt: 1000,
    segmentStartedAt: 1000,
    points,
  };
}

function testNormalization() {
  const point = normalizeTrackPoint(gpsPosition());
  assert.ok(point, "valid position must normalize");
  assert.equal(point.latitude, 47.05);
  assert.equal(point.longitude, 8.3);
  assert.equal(point.altitudeM, 1500);
  assert.equal(point.accuracyM, 10);
  assert.equal(point.timestamp, 1755400000000);

  const nullAltitude = normalizeTrackPoint(
    gpsPosition({ altitudeM: null }),
  );
  assert.equal(nullAltitude.altitudeM, null);

  const finiteAltitude = normalizeTrackPoint(
    gpsPosition({ altitudeM: 42.5 }),
  );
  assert.equal(finiteAltitude.altitudeM, 42.5);
}

function testInvalidCoordinateRejection() {
  const invalidPositions = [
    gpsPosition({ latitude: 91 }),
    gpsPosition({ latitude: -91 }),
    gpsPosition({ longitude: 181 }),
    gpsPosition({ longitude: -181 }),
    gpsPosition({ latitude: Number.NaN }),
    gpsPosition({ longitude: Number.POSITIVE_INFINITY }),
    gpsPosition({ accuracyM: Number.NaN }),
    gpsPosition({ accuracyM: -1 }),
    gpsPosition({ timestamp: 0 }),
    gpsPosition({ timestamp: -100 }),
    gpsPosition({ timestamp: Number.NaN }),
  ];

  for (const position of invalidPositions) {
    assert.equal(
      normalizeTrackPoint(position),
      null,
      `expected rejection for ${JSON.stringify(position)}`,
    );
  }

  assert.equal(
    normalizeTrackPoint(gpsPosition({ latitude: 90.0001 })),
    null,
    "pole latitude is out of range",
  );
  assert.equal(
    normalizeTrackPoint(gpsPosition({ latitude: -90.0001 })),
    null,
  );
  assert.equal(
    normalizeTrackPoint(gpsPosition({ longitude: 180.0001 })),
    null,
  );
  assert.equal(
    normalizeTrackPoint(gpsPosition({ longitude: -180.0001 })),
    null,
  );

  assert.ok(
    normalizeTrackPoint(gpsPosition({ latitude: 90, longitude: 180 })),
    "boundary coordinates are valid",
  );
  assert.ok(
    normalizeTrackPoint(gpsPosition({ latitude: -90, longitude: -180 })),
    "boundary coordinates are valid",
  );
}

function testPoorAccuracyRejection() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ accuracyM: MAX_GPS_ACCURACY_M + 1 }),
  });

  assert.equal(state.points.length, 0);
  assert.equal(state.lastRejectedReason, "accuracy");

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      accuracyM: MAX_GPS_ACCURACY_M + 1,
      timestamp: 1755400000001,
    }),
  });

  assert.equal(state.points.length, 0, "repeat poor samples stay rejected");

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      accuracyM: MAX_GPS_ACCURACY_M,
      timestamp: 1755400000002,
    }),
  });

  assert.equal(state.points.length, 1);
  assert.equal(state.lastRejectedReason, null);

  assert.equal(MAX_GPS_ACCURACY_M, 50);
  assert.equal(MAX_IMPLIED_SPEED_KMH, 25);
  assert.equal(BASE_MIN_MOVEMENT_M, 8);
  assert.equal(ACCURACY_THRESHOLD_FACTOR, 0.8);
  assert.equal(MOVEMENT_CONFIRM_SAMPLES, 3);
  assert.equal(movementThresholdM(10, 10), 8);
  assert.equal(movementThresholdM(10, 15), 12);
  assert.equal(movementThresholdM(20, 25), 20);
  assert.equal(movementThresholdM(2, 2), 8);
}

function testDuplicateRejection() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  assert.equal(state.points.length, 1, "exact duplicate must be skipped");
  assert.equal(state.lastRejectedReason, "duplicate");

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1755400000001 }),
  });

  assert.equal(
    state.points.length,
    1,
    "same coordinates with a new timestamp are stationary jitter",
  );
  assert.equal(state.lastRejectedReason, "too-close");
}

function testIdleIgnoresSamples() {
  const state = trackRecorderReducer(createInitialRecorderState(), {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  assert.equal(state.status, "idle");
  assert.equal(state.points.length, 0);
}

function testRecordingAcceptsSamples() {
  let state = trackRecorderReducer(createInitialRecorderState(), {
    type: "start",
    now: 1000,
  });

  assert.equal(state.status, "recording");
  assert.equal(state.startedAt, 1000);
  assert.equal(state.segmentStartedAt, 1000);

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  assert.equal(state.points.length, 1);
  assert.equal(state.points[0].latitude, 47.05);
}

function testPausedIgnoresSamples() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  state = trackRecorderReducer(state, { type: "pause", now: 5000 });

  assert.equal(state.status, "paused");
  assert.equal(state.segmentStartedAt, null);
  assert.equal(state.activeDurationMs, 4000);

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1755400000001 }),
  });

  assert.equal(state.points.length, 1, "paused must ignore samples");
}

function testResumeAcceptsNewSamples() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  state = trackRecorderReducer(state, { type: "pause", now: 5000 });
  state = trackRecorderReducer(state, { type: "resume", now: 9000 });

  assert.equal(state.status, "recording");
  assert.equal(state.segmentStartedAt, 9000);

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1755400000001 }),
  });

  assert.equal(state.points.length, 2, "resumed recording must accept samples");

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1755400000001 }),
  });

  assert.equal(state.points.length, 2, "no duplicate of the last point");
}

function testFinishedIgnoresSamples() {
  let state = recordingState([
    {
      latitude: 47.05,
      longitude: 8.3,
      altitudeM: null,
      accuracyM: 10,
      timestamp: 1755400000000,
    },
    {
      latitude: 47.051,
      longitude: 8.301,
      altitudeM: null,
      accuracyM: 10,
      timestamp: 1755400000001,
    },
  ]);

  state = trackRecorderReducer(state, { type: "finish", now: 7000 });

  assert.equal(state.status, "finished");
  assert.equal(state.finishedAt, 7000);

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1755400000002 }),
  });

  assert.equal(state.points.length, 2, "finished must ignore samples");
}

function testMinimumTrackOnFinish() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition(),
  });

  state = trackRecorderReducer(state, { type: "finish", now: 5000 });

  assert.equal(state.status, "recording", "finish requires at least 2 points");

  // Need 3 samples outside the 15m release radius
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(20),
      timestamp: 1755400000001 + 9000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(40),
      timestamp: 1755400000001 + 18000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(60),
      timestamp: 1755400000001 + 27000,
    }),
  });

  assert.equal(
    state.points.length,
    2,
    "movement is confirmed after three sustained samples outside release radius",
  );

  state = trackRecorderReducer(state, { type: "finish", now: 7000 });

  assert.equal(state.status, "finished");
  assert.equal(MIN_TRACK_POINTS, 2);
}

function testStateTransitions() {
  let state = trackRecorderReducer(createInitialRecorderState(), {
    type: "start",
    now: 1000,
  });

  state = trackRecorderReducer(state, { type: "start", now: 2000 });
  assert.equal(state.status, "recording", "start from recording is ignored");

  state = trackRecorderReducer(state, { type: "finish", now: 3000 });
  assert.equal(state.status, "recording", "finish with no points is ignored");

  state = trackRecorderReducer(state, { type: "pause", now: 4000 });
  state = trackRecorderReducer(state, { type: "pause", now: 5000 });
  assert.equal(state.status, "paused", "pause from paused is ignored");

  state = trackRecorderReducer(state, { type: "resume", now: 6000 });
  state = trackRecorderReducer(state, { type: "resume", now: 7000 });
  assert.equal(state.status, "recording", "resume from recording is ignored");

  const resetState = trackRecorderReducer(state, { type: "reset" });
  assert.deepEqual(resetState, createInitialRecorderState());
}

function testHaversineDistance() {
  const oneDegree = haversineDistanceMeters(
    { latitude: 0, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 1 },
    { latitude: 0, longitude: 1, altitudeM: null, accuracyM: 10, timestamp: 2 },
  );

  assert.ok(
    Math.abs(oneDegree - (Math.PI / 180) * EARTH_RADIUS_M) < 1,
    `expected ~111195 m, got ${oneDegree}`,
  );

  const tenMillidegrees = haversineDistanceMeters(
    { latitude: 0, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 1 },
    { latitude: 0.001, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 2 },
  );

  assert.ok(
    Math.abs(tenMillidegrees - 111.19) < 0.1,
    `expected ~111.19 m, got ${tenMillidegrees}`,
  );

  const stats = computeTrackStats([
    { latitude: 0, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 1 },
    { latitude: 0.001, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 2 },
    { latitude: 0.002, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 3 },
  ]);

  assert.ok(Math.abs(stats.distanceM - 222.38) < 0.2);
  assert.equal(stats.pointCount, 3);
}

function testActiveDurationExcludesPause() {
  let state = recordingState();

  assert.equal(getActiveDurationMs(state, 5000), 4000);

  state = trackRecorderReducer(state, { type: "pause", now: 5000 });
  assert.equal(getActiveDurationMs(state, 9000), 4000, "pause time excluded");

  state = trackRecorderReducer(state, { type: "resume", now: 9000 });
  assert.equal(getActiveDurationMs(state, 11000), 6000);

  state = trackRecorderReducer(state, { type: "pause", now: 11000 });
  assert.equal(getActiveDurationMs(state, 50000), 6000);

  const parts = getDurationParts(3723000);
  assert.deepEqual(parts, { hours: 1, minutes: 2, seconds: 3 });

  assert.deepEqual(getDurationParts(-5000), {
    hours: 0,
    minutes: 0,
    seconds: 0,
  });
}

function testElevationGainJitterThreshold() {
  const stats = computeTrackStats([
    { latitude: 0, longitude: 0, altitudeM: 1000, accuracyM: 10, timestamp: 1 },
    { latitude: 0.001, longitude: 0, altitudeM: 1002.9, accuracyM: 10, timestamp: 2 },
    { latitude: 0.002, longitude: 0, altitudeM: 1010, accuracyM: 10, timestamp: 3 },
    { latitude: 0.003, longitude: 0, altitudeM: 1000, accuracyM: 10, timestamp: 4 },
    { latitude: 0.004, longitude: 0, altitudeM: 1003, accuracyM: 10, timestamp: 5 },
  ]);

  assert.equal(
    ELEVATION_GAIN_JITTER_THRESHOLD_M,
    3,
    "jitter threshold is documented at 3 m",
  );
  assert.ok(
    Math.abs(stats.elevationGainM - 10.1) < 0.001,
    `expected 2.9 below threshold ignored, 7.1 and 3 accumulated (10.1), got ${stats.elevationGainM}`,
  );
  assert.equal(stats.hasAltitudeData, true);

  const noAltitude = computeTrackStats([
    { latitude: 0, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 1 },
    { latitude: 0.001, longitude: 0, altitudeM: null, accuracyM: 10, timestamp: 2 },
  ]);

  assert.equal(noAltitude.elevationGainM, 0);
  assert.equal(noAltitude.hasAltitudeData, false);
}

function testGeoJsonCoordinateOrder() {
  const points = [
    { latitude: 47.05, longitude: 8.3, altitudeM: null, accuracyM: 10, timestamp: 1 },
    { latitude: 47.051, longitude: 8.301, altitudeM: null, accuracyM: 10, timestamp: 2 },
    { latitude: 47.052, longitude: 8.302, altitudeM: null, accuracyM: 10, timestamp: 3 },
  ];

  const geoJson = buildTrackLineGeoJson(points);

  assert.equal(geoJson.type, "FeatureCollection");
  assert.equal(geoJson.features.length, 1);
  assert.equal(geoJson.features[0].geometry.type, "LineString");
  assert.deepEqual(geoJson.features[0].geometry.coordinates[0], [8.3, 47.05]);
  assert.deepEqual(geoJson.features[0].geometry.coordinates[2], [8.302, 47.052]);

  const empty = buildTrackLineGeoJson([points[0]]);
  assert.equal(empty.type, "FeatureCollection");
  assert.deepEqual(empty.features, []);

  const twoPointLine = buildTrackLineGeoJson(points.slice(0, 2));
  assert.equal(twoPointLine.features[0].geometry.coordinates.length, 2);

  const ninePoints = Array.from({ length: 9 }, (_, index) => ({
    ...points[0],
    latitude: points[0].latitude + index * 0.001,
    longitude: points[0].longitude + index * 0.001,
    timestamp: index + 1,
  }));
  const ninePointLine = buildTrackLineGeoJson(ninePoints);
  assert.equal(ninePointLine.features[0].geometry.coordinates.length, 9);
  assert.deepEqual(ninePointLine.features[0].geometry.coordinates[8], [8.308, 47.058]);
}

function testPendingRecordingDraft() {
  const points = [
    { latitude: 47.05, longitude: 8.3, altitudeM: 1500, accuracyM: 8, timestamp: 1000 },
    { latitude: 47.051, longitude: 8.301, altitudeM: 1510, accuracyM: 9, timestamp: 2000 },
  ];
  const serialized = serializePendingRecordingDraft(
    { points, startedAt: 900, finishedAt: 2900, activeDurationMs: 1800 },
    "Morning route",
  );
  assert.ok(serialized);
  assert.ok(!serialized.includes("previewPoints"));
  assert.ok(!serialized.includes("rejected"));
  assert.ok(!serialized.includes("rawSamples"));

  const restored = parsePendingRecordingDraft(serialized);
  assert.ok(restored);
  assert.equal(restored.trackName, "Morning route");
  assert.deepEqual(restored.points, points);

  const restoredState = trackRecorderReducer(createInitialRecorderState(), {
    type: "restoreFinished",
    snapshot: restored,
  });
  assert.equal(restoredState.status, "finished");
  assert.deepEqual(restoredState.points, points);
  assert.deepEqual(restoredState.previewPoints, []);
  assert.equal(restoredState.activeDurationMs, 1800);

  for (const malformed of [
    "not json",
    JSON.stringify({ version: 2, points }),
    JSON.stringify({ version: 1, points: [points[0]], startedAt: 900, finishedAt: 2900, activeDurationMs: 1800, trackName: "x" }),
    JSON.stringify({ version: 1, points, previewPoints: points, startedAt: 900, finishedAt: 2900, activeDurationMs: 1800, trackName: "x" }),
  ]) {
    assert.equal(parsePendingRecordingDraft(malformed), null);
  }

  assert.equal(normalizePendingRecordingDraft({
    version: 1,
    points: [{ ...points[0], raw: true }, points[1]],
    startedAt: 900,
    finishedAt: 2900,
    activeDurationMs: 1800,
    trackName: "x",
  }), null);

  const storage = new Map();
  const originalWindow = globalThis.window;
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  };
  try {
    assert.equal(persistPendingRecordingDraft(restored, restored.trackName), true);
    assert.ok(storage.has(PENDING_RECORDING_STORAGE_KEY));
    assert.equal(loadPendingRecordingDraft()?.trackName, "Morning route");
    clearPendingRecordingDraft();
    assert.equal(storage.has(PENDING_RECORDING_STORAGE_KEY), false);

    storage.set(PENDING_RECORDING_STORAGE_KEY, "malformed");
    assert.equal(loadPendingRecordingDraft(), null);
    assert.equal(storage.has(PENDING_RECORDING_STORAGE_KEY), false);
  } finally {
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  }
}

function testTrackSourceSynchronization() {
  const sources = new Map();
  const layers = new Map([["opentopomap", { id: "opentopomap" }]]);
  const setDataCalls = new Map();
  const fakeMap = {
    isStyleLoaded: () => true,
    getSource: (id) => sources.get(id),
    addSource: (id, definition) => {
      const source = {
        definition,
        data: definition.data,
        setData(data) {
          this.data = data;
          setDataCalls.set(id, (setDataCalls.get(id) ?? 0) + 1);
        },
      };
      sources.set(id, source);
    },
    getLayer: (id) => layers.get(id),
    addLayer: (layer) => layers.set(layer.id, layer),
    moveLayer: (id) => {
      const layer = layers.get(id);
      layers.delete(id);
      layers.set(id, layer);
    },
  };

  const confirmed = buildTrackLineGeoJson([
    gpsPosition({ timestamp: 1000 }),
    gpsPosition({ latitude: 47.051, timestamp: 2000 }),
  ]);
  const preview = buildTrackLineGeoJson([]);
  assert.equal(synchronizeTrackRecordingSources(fakeMap, confirmed, preview), true);
  assert.deepEqual(sources.get(USER_RECORDED_TRACK_SOURCE_ID).data, confirmed);
  assert.deepEqual(sources.get(USER_RECORDED_PREVIEW_SOURCE_ID).data, preview);
  assert.equal(setDataCalls.get(USER_RECORDED_TRACK_SOURCE_ID), 1);

  const ninePointConfirmed = buildTrackLineGeoJson(
    Array.from({ length: 9 }, (_, index) =>
      gpsPosition({ latitude: 47.05 + index * 0.001, timestamp: 1000 + index }),
    ),
  );
  assert.equal(synchronizeTrackRecordingSources(fakeMap, ninePointConfirmed, preview), true);
  assert.deepEqual(sources.get(USER_RECORDED_TRACK_SOURCE_ID).data, ninePointConfirmed);
  assert.equal(setDataCalls.get(USER_RECORDED_TRACK_SOURCE_ID), 2);
  assert.equal(layers.get("user-recorded-track-line").source, USER_RECORDED_TRACK_SOURCE_ID);
  assert.equal(layers.get("user-recorded-track-line").layout.visibility, "visible");
  assert.ok(layers.get("user-recorded-track-line").paint["line-width"] > 0);
  assert.ok(layers.get("user-recorded-track-line").paint["line-opacity"] > 0);
  assert.equal(typeof layers.get("user-recorded-track-line").paint["line-color"], "string");

  const layerOrder = [...layers.keys()];
  assert.ok(layerOrder.indexOf("opentopomap") < layerOrder.indexOf("user-recorded-track-line"));
  assert.ok(layerOrder.indexOf("user-recorded-preview-line") < layerOrder.indexOf("user-recorded-track-line"));
  assert.ok(layerOrder.indexOf("user-recorded-track-line") < layerOrder.indexOf("user-location-point"));

  sources.clear();
  for (const layerId of [...layers.keys()]) {
    if (layerId !== "opentopomap") layers.delete(layerId);
  }
  assert.equal(synchronizeTrackRecordingSources(fakeMap, ninePointConfirmed, preview), true);
  assert.deepEqual(sources.get(USER_RECORDED_TRACK_SOURCE_ID).data, ninePointConfirmed);
}

function testGpxXmlEscaping() {
  const trackName = `<Mountain & "Tracker" 'Tour'>`;

  const xml = buildGpxXml(
    [
      {
        latitude: 47.05,
        longitude: 8.3,
        altitudeM: 1500.5,
        accuracyM: 10,
        timestamp: Date.parse("2026-08-16T12:00:00.000Z"),
      },
    ],
    trackName,
  );

  assert.ok(xml.includes("&lt;Mountain &amp; &quot;Tracker&quot; &apos;Tour&apos;&gt;"));
  assert.equal(escapeXml(`<a & "b" 'c'>`), "&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;");
}

function testGpxTimestampsAndElevation() {
  const timestamp = Date.parse("2026-08-16T12:00:00.000Z");

  const withElevation = buildGpxXml(
    [
      {
        latitude: 47.05,
        longitude: 8.3,
        altitudeM: 1500.5,
        accuracyM: 10,
        timestamp,
      },
    ],
    "test",
  );

  assert.ok(withElevation.includes('<trkpt lat="47.0500000" lon="8.3000000">'));
  assert.ok(withElevation.includes("<ele>1500.5</ele>"));
  assert.ok(withElevation.includes("<time>2026-08-16T12:00:00.000Z</time>"));
  assert.ok(withElevation.includes('<gpx version="1.1"'));
  assert.ok(withElevation.includes("<trkseg>"));

  const withoutElevation = buildGpxXml(
    [
      {
        latitude: 47.05,
        longitude: 8.3,
        altitudeM: null,
        accuracyM: 10,
        timestamp,
      },
    ],
    "test",
  );

  assert.ok(!withoutElevation.includes("<ele>"), "<ele> omitted for null altitude");
  assert.ok(withoutElevation.includes("<time>2026-08-16T12:00:00.000Z</time>"));
}

function testGpxFilename() {
  const startedAt = new Date(2026, 7, 16, 9, 5).getTime();

  assert.equal(
    buildGpxFilename(startedAt),
    "mountain-tracker-track-2026-08-16-0905.gpx",
  );

  assert.equal(
    buildGpxTrackName(startedAt),
    "mountain-tracker-track-2026-08-16",
  );
}

function testDistanceFormatting() {
  assert.equal(formatDistanceValue(438, "en"), "438");
  assert.equal(formatDistanceValue(438, "de"), "438");
  assert.equal(usesKilometers(999.9), false);
  assert.equal(usesKilometers(1000), true);
  assert.equal(formatDistanceValue(3419.5, "en"), "3.42");
  assert.equal(formatDistanceValue(3419.5, "de"), "3,42");
  assert.equal(formatDistanceValue(3419.5, "ru"), "3,42");
}

function testFullRecordingFlow() {
  let state = trackRecorderReducer(createInitialRecorderState(), {
    type: "start",
    now: 1000,
  });

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1001 }),
  });
  // Need 3 samples outside 15m release radius
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(20),
      timestamp: 1001 + 9000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(40),
      timestamp: 1001 + 18000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(60),
      timestamp: 1001 + 27000,
    }),
  });

  assert.equal(
    state.points.length,
    2,
    "three sustained samples outside release radius confirm one accepted point",
  );

  state = trackRecorderReducer(state, { type: "pause", now: 100000 });
  state = trackRecorderReducer(state, { type: "resume", now: 120000 });

  // After resume, first point accepted as new segment start
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(60),
      timestamp: 1001 + 120000,
    }),
  });
  // Then need 3 more samples outside new anchor (at 60m)
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(80),
      timestamp: 1001 + 129000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(100),
      timestamp: 1001 + 138000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(120),
      timestamp: 1001 + 147000,
    }),
  });

  state = trackRecorderReducer(state, { type: "finish", now: 240000 });

  assert.equal(state.status, "finished");
  assert.equal(state.finishedAt, 240000);
  assert.equal(state.points.length, 4);
  assert.equal(state.activeDurationMs, 219000);

const stats = computeTrackStats(state.points);
  assert.equal(stats.pointCount, 4);
  assert.ok(
    Math.abs(stats.distanceM - 120) < 5,
    `expected ~120 m of confirmed walking, got ${stats.distanceM}`,
  );

  const resetState = trackRecorderReducer(state, { type: "reset" });
  assert.deepEqual(resetState, createInitialRecorderState());
}

function testStationaryJitterRejected() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 8; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude:
          47.05 + (i % 2 === 0 ? 1 : -1) * 0.00002,
        timestamp: 1000 + i * 2000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    1,
    "jitter under 4 m must not be recorded",
  );
  assert.equal(state.lastRejectedReason, "too-close");

  const stats = computeTrackStats(state.points);
  assert.equal(stats.distanceM, 0);
  assert.equal(stats.elevationGainM, 0);
  assert.equal(stats.pointCount, 1);
}

function testFirstPointAccepted() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ accuracyM: 45 }),
  });

  assert.equal(
    state.points.length,
    1,
    "the first valid GPS point must always be accepted",
  );
  assert.equal(state.lastRejectedReason, null);
}

function testNormalWalkingPointsAccepted() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Need 3 samples outside 15m release radius: 5.56m per step, so need ~3 steps beyond 15m
  // 15m / 5.56m = 2.7, so steps 3, 4, 5 = 3 samples outside radius
  for (let i = 1; i <= 6; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + 0.00005 * i,
        timestamp: 1000 + i * 4000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    2,
    "walking pace points are confirmed and accepted",
  );

  const stats = computeTrackStats(state.points);
  assert.ok(
    Math.abs(stats.distanceM - 33.36) < 0.5,
    `expected ~33.36 m after confirmation, got ${stats.distanceM}`,
  );
}

function testImpossibleJumpRejected() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.1,
      timestamp: 1000 + 10000,
    }),
  });

  assert.equal(
    state.points.length,
    1,
    "jumps above 25 km/h must be rejected",
  );
  assert.equal(state.lastRejectedReason, "implausible-speed");
}

function testRejectedSamplesDoNotBecomeBaseline() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + 0.000027,
      timestamp: 1000 + 2000,
    }),
  });

  assert.equal(
    state.points.length,
    1,
    "3 m sample is rejected as too close",
  );
  assert.equal(state.lastRejectedReason, "too-close");

  // Need 3 samples outside 15m release radius
  // 0.00009 deg = ~10m (within 15m)
  // 0.00018 deg = ~20m (outside 15m) - evidence count 1
  // 0.00027 deg = ~30m (outside 15m) - evidence count 2
  // 0.00036 deg = ~40m (outside 15m) - evidence count 3 -> confirmed
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + 0.00009,
      timestamp: 1000 + 4000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + 0.00018,
      timestamp: 1000 + 8000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + 0.00027,
      timestamp: 1000 + 12000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + 0.00036,
      timestamp: 1000 + 16000,
    }),
  });

  assert.equal(
    state.points.length,
    2,
    "movement is confirmed against the original baseline",
  );

  const stats = computeTrackStats(state.points);
  assert.ok(
    Math.abs(stats.distanceM - 40) < 0.5,
    `distance must be measured from the last accepted point, got ${stats.distanceM}`,
  );
}

function testPauseResumeNoArtificialDistance() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000, altitudeM: 1500 }),
  });

  state = trackRecorderReducer(state, { type: "pause", now: 5000 });
  state = trackRecorderReducer(state, { type: "resume", now: 6000 });

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518,
      altitudeM: 1600,
      timestamp: 7000,
    }),
  });

  assert.equal(state.points.length, 2, "resumed baseline must be accepted");

  const stats = computeTrackStats(state.points);
  assert.equal(
    stats.distanceM,
    0,
    "movement across the paused period must not count",
  );
  assert.equal(
    stats.elevationGainM,
    0,
    "elevation across the paused period must not count",
  );

  // Need 3 samples outside 15m release radius from new anchor
  // 0.00009 deg = ~10m (within 15m) - rejected
  // 0.00018 deg = ~20m (outside 15m) - evidence 1
  // 0.00027 deg = ~30m (outside 15m) - evidence 2
  // 0.00036 deg = ~40m (outside 15m) - evidence 3 -> confirmed
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00009,
      timestamp: 7000 + 4000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00018,
      timestamp: 7000 + 8000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00027,
      timestamp: 7000 + 12000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00036,
      timestamp: 7000 + 16000,
    }),
  });

  const walkingStats = computeTrackStats(state.points);
  assert.ok(
    Math.abs(walkingStats.distanceM - 40) < 0.5,
    `only confirmed post-resume movement must count, got ${walkingStats.distanceM}`,
  );
  assert.equal(
    walkingStats.elevationGainM,
    0,
    "flat post-resume walking adds no elevation",
  );
}

function testStationaryJitterAroundOneLocationStaysNearZero() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 15; i += 1) {
    const wobbleDegrees =
      (i % 3 === 0 ? -1 : 1) * (i % 4) * 0.000009;

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + wobbleDegrees,
        timestamp: 1000 + i * 2000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    1,
    "GPS jitter around one location must not accumulate points",
  );

  const stats = computeTrackStats(state.points);
  assert.equal(stats.distanceM, 0);
}

const METERS_PER_DEGREE_LAT = 111_195;

function latitudeOffsetDegrees(meters) {
  return meters / METERS_PER_DEGREE_LAT;
}

function testStationaryJitterSixtySeconds() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 60; i += 1) {
    const offsetM = ((i * 11) % 21) - 10;

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    1,
    "stationary jitter must not accumulate points",
  );
  assert.equal(computeTrackStats(state.points).distanceM, 0);
  assert.equal(state.sampleCounters.rawSamples, 61);
  assert.equal(state.sampleCounters.acceptedPoints, 1);
  assert.equal(
    state.sampleCounters.rejectedTooClose +
      state.sampleCounters.rejectedUnconfirmed,
    60,
  );
}

function testWorseGpsJitterSixtySeconds() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000, accuracyM: 10 }),
  });

  for (let i = 1; i <= 60; i += 1) {
    const accuracyM = 12 + (i % 4) * 4;
    const offsetM = ((i * 7) % 13) - 6;

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        accuracyM,
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    1,
    "poor-accuracy drift must not record points",
  );
  assert.equal(computeTrackStats(state.points).distanceM, 0);
  assert.equal(state.sampleCounters.rejectedTooClose, 60);
}

function testNormalWalkingTwoMinutes() {
  const speedMps = 1.39;
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 120; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(speedMps * i),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  // With stationary anchor (15m release radius) then moving mode (8m threshold),
  // we expect fewer but more accurate points
  assert.ok(
    state.points.length >= 5 && state.points.length <= 15,
    `two minutes at 5 km/h should record a reasonable number of points, got ${state.points.length}`,
  );

  const stats = computeTrackStats(state.points);
  // Theoretical distance: 1.39 m/s * 120s = 166.8m
  // Confirmed distance should be close to theoretical
  assert.ok(
    Math.abs(stats.distanceM - 166.8) < 20,
    `expected ~166.8 m of the theoretical 166.8 m, got ${stats.distanceM}`,
  );
}

function testWalkingWithTurns() {
  const speedMps = 1.39;
  const legM = speedMps * 30;
  const lonPerM =
    1 / (111_195 * Math.cos((47.05 * Math.PI) / 180));
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 90; i += 1) {
    let latitude = 47.05;
    let longitude = 8.3;

    if (i <= 30) {
      latitude += latitudeOffsetDegrees(speedMps * i);
    } else if (i <= 60) {
      latitude += latitudeOffsetDegrees(legM);
      longitude += speedMps * (i - 30) * lonPerM;
    } else {
      latitude += latitudeOffsetDegrees(
        legM + speedMps * (i - 60),
      );
      longitude += legM * lonPerM;
    }

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude,
        longitude,
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  const stats = computeTrackStats(state.points);
  // Theoretical: 3 legs * 41.7m = 125.1m
  // With stationary anchor + moving mode, distance should be reasonably close
  assert.ok(
    stats.distanceM > 70 && stats.distanceM < 140,
    `expected ~125 m around three turns, got ${stats.distanceM}`,
  );
  assert.ok(
    state.points.length >= 4,
    `turns need enough points to stay visible, got ${state.points.length}`,
  );

  const cornerOne = {
    latitude: 47.05 + latitudeOffsetDegrees(legM),
    longitude: 8.3,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 0,
  };
  const cornerTwo = {
    latitude: 47.05 + latitudeOffsetDegrees(legM),
    longitude: 8.3 + legM * lonPerM,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 0,
  };

  for (const corner of [cornerOne, cornerTwo]) {
    assert.ok(
      state.points.some(
        (point) => haversineDistanceMeters(point, corner) < 30,
      ),
      "each turn must have an accepted point nearby",
    );
  }
}

function testSingleGpsSpikeRejected() {
  const speedMps = 1.39;
  const lonPerM =
    1 / (111_195 * Math.cos((47.05 * Math.PI) / 180));
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 24; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(speedMps * i),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  const spikeLatitude =
    47.05 + latitudeOffsetDegrees(speedMps * 25);
  const spikeLongitude = 8.3 + 40 * lonPerM;

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: spikeLatitude,
      longitude: spikeLongitude,
      timestamp: 1000 + 25 * 1000,
    }),
  });

  for (let i = 26; i <= 50; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(speedMps * i),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  assert.equal(
    state.sampleCounters.rejectedImplausibleSpeed,
    1,
    "the 40 m jump one second after the last accepted point must be rejected",
  );

  const spikePoint = {
    latitude: spikeLatitude,
    longitude: spikeLongitude,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 0,
  };

  assert.ok(
    state.points.every(
      (point) => haversineDistanceMeters(point, spikePoint) > 20,
    ),
    "no accepted point may sit near the spike",
  );

  const stats = computeTrackStats(state.points);
  // With stationary anchor logic, we get fewer but more accurate points
  assert.ok(
    state.points.length >= 3 && state.points.length <= 7,
    `expected reasonable number of confirmed points, got ${state.points.length}`,
  );
  assert.ok(
    stats.distanceM > 40 && stats.distanceM < 90,
    `walking must continue correctly after the spike, got ${stats.distanceM}`,
  );
}

function testBackAndForthJitter() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 40; i += 1) {
    const offsetM = [0, 9, 0, 6][(i - 1) % 4];

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    1,
    "back-and-forth jitter must not be counted as walking",
  );
  assert.equal(computeTrackStats(state.points).distanceM, 0);
}

function testStationaryAnchorDriftTwoMinutes() {
  // Simulate 120 seconds of slow wandering GPS around one location
  // (the real-world 23 m / 2 min test case)
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000, accuracyM: 10 }),
  });

  // Simulate slow drift: ±10 m every 2 seconds for 120 seconds (60 samples)
  for (let i = 1; i <= 60; i += 1) {
    const offsetM = ((i * 11) % 21) - 10; // -10 to +10 m pattern

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        accuracyM: 10,
        timestamp: 1000 + i * 2000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    1,
    "120 s stationary drift must not accumulate confirmed points",
  );
  assert.equal(
    computeTrackStats(state.points).distanceM,
    0,
    "confirmed distance must be 0 m for stationary drift",
  );
  assert.ok(
    state.previewPoints.length > 0,
    "preview points should exist for visual feedback",
  );
}

function testPreviewDoesNotAffectStats() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Add some stationary drift that creates preview points but not confirmed points
  for (let i = 1; i <= 10; i += 1) {
    const offsetM = ((i * 7) % 13) - 6;

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + i * 2000,
      }),
    });
  }

  const stats = computeTrackStats(state.points);
  assert.equal(stats.distanceM, 0);
  assert.equal(stats.pointCount, 1);
  assert.equal(stats.elevationGainM, 0);
}

function testPreviewDoesNotAffectGpx() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Add preview points only
  for (let i = 1; i <= 5; i += 1) {
    const offsetM = ((i * 7) % 13) - 6;

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + i * 2000,
      }),
    });
  }

  // Build GPX from confirmed points only
  const gpx = buildGpxXml(state.points, "test");
  const trkptMatches = gpx.match(/<trkpt/g);
  assert.equal(trkptMatches ? trkptMatches.length : 0, 1, "GPX must only contain confirmed points");
}

function testWalkingBeginsPreviewReactsImmediately() {
  let state = recordingState();

  // Debug: check initial state
  assert.ok(Array.isArray(state.previewPoints), "initial previewPoints should be array");
  assert.equal(state.previewPoints.length, 0, "initial previewPoints should be empty");
  assert.equal(state.stationaryAnchor, null, "initial stationaryAnchor should be null");

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Debug: check after first point
  assert.ok(Array.isArray(state.previewPoints), "previewPoints should be array after first point");
  assert.equal(state.previewPoints.length, 1, "previewPoints should have 1 point after first accept");
  assert.ok(state.stationaryAnchor !== null, "stationaryAnchor should be set after first point");

  // First walking sample - should appear in preview immediately
  // Use 16m to ensure it exceeds the 15m release radius
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(16),
      timestamp: 1000 + 2000,
    }),
  });

  // Debug: check after second point
  assert.ok(Array.isArray(state.previewPoints), "previewPoints should be array after second point");

  assert.ok(
    state.previewPoints.length >= 2,
    "preview should react immediately to movement",
  );
  assert.equal(
    state.points.length,
    1,
    "confirmed points should not increase until movement is sustained",
  );
}

function testMovementConfirmation() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // 3 coherent samples outside release radius = confirmed movement
  // First evidence at 20m, need third evidence at > 35m (20+15) to account for floating point
  // Use 10s intervals to keep speed under 25 km/h
  for (let i = 1; i <= 3; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(20 + i * 8),
        timestamp: 1000 + i * 10000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    2,
    "movement confirmed after 3 sustained samples outside release radius",
  );
  assert.equal(state.movementState, "moving");
}

function testWalkingThenStoppingTwoMinutes() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Walk for 30 seconds (10 samples at 3s intervals, ~5 km/h)
  for (let i = 1; i <= 10; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(i * 4),
        timestamp: 1000 + i * 3000,
      }),
    });
  }

  const walkingPoints = state.points.length;
  const walkingDistance = computeTrackStats(state.points).distanceM;

  // Stop for 2 minutes (60 samples at 2s intervals, jitter ±3m around 35m)
  // Center near last confirmed point (32m) to ensure sub-threshold samples
  for (let i = 1; i <= 60; i += 1) {
    const offsetM = ((i * 7) % 7) - 3; // ±3m jitter

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(35 + offsetM),
        timestamp: 1000 + 30000 + i * 2000,
      }),
    });
  }

  assert.equal(
    state.points.length,
    walkingPoints,
    "no new confirmed points during stationary period",
  );
  assert.equal(
    computeTrackStats(state.points).distanceM,
    walkingDistance,
    "confirmed distance must not increase during stationary period",
  );
  assert.equal(state.movementState, "stationary", "should transition back to stationary");
}

function testTurnPreservation() {
  const speedMps = 1.39;
  const legM = speedMps * 30;
  const lonPerM =
    1 / (111_195 * Math.cos((47.05 * Math.PI) / 180));
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 90; i += 1) {
    let latitude = 47.05;
    let longitude = 8.3;

    if (i <= 30) {
      latitude += latitudeOffsetDegrees(speedMps * i);
    } else if (i <= 60) {
      latitude += latitudeOffsetDegrees(legM);
      longitude += speedMps * (i - 30) * lonPerM;
    } else {
      latitude += latitudeOffsetDegrees(
        legM + speedMps * (i - 60),
      );
      longitude += legM * lonPerM;
    }

    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude,
        longitude,
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  const stats = computeTrackStats(state.points);
  // Theoretical: 3 legs * 41.7m = 125.1m
  // With stationary anchor + moving mode, distance should be reasonably close
  assert.ok(
    stats.distanceM > 70 && stats.distanceM < 140,
    `expected ~125 m around three turns, got ${stats.distanceM}`,
  );
  assert.ok(
    state.points.length >= 4,
    `turns need enough points to stay visible, got ${state.points.length}`,
  );

  const cornerOne = {
    latitude: 47.05 + latitudeOffsetDegrees(legM),
    longitude: 8.3,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 0,
  };
  const cornerTwo = {
    latitude: 47.05 + latitudeOffsetDegrees(legM),
    longitude: 8.3 + legM * lonPerM,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 0,
  };

  for (const corner of [cornerOne, cornerTwo]) {
    assert.ok(
      state.points.some(
        (point) => haversineDistanceMeters(point, corner) < 25,
      ),
      "each turn must have an accepted point nearby",
    );
  }
}

function testSpikeRejection() {
  const speedMps = 1.39;
  const lonPerM =
    1 / (111_195 * Math.cos((47.05 * Math.PI) / 180));
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  for (let i = 1; i <= 24; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(speedMps * i),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  const spikeLatitude =
    47.05 + latitudeOffsetDegrees(speedMps * 25);
  const spikeLongitude = 8.3 + 40 * lonPerM;

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: spikeLatitude,
      longitude: spikeLongitude,
      timestamp: 1000 + 25 * 1000,
    }),
  });

  for (let i = 26; i <= 50; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(speedMps * i),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  assert.equal(
    state.sampleCounters.rejectedImplausibleSpeed,
    1,
    "the 40 m jump one second after the last accepted point must be rejected",
  );

  const spikePoint = {
    latitude: spikeLatitude,
    longitude: spikeLongitude,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 0,
  };

  assert.ok(
    state.points.every(
      (point) => haversineDistanceMeters(point, spikePoint) > 20,
    ),
    "no accepted point may sit near the spike",
  );

  const stats = computeTrackStats(state.points);
  // With stationary anchor logic, we get fewer but more accurate points
  assert.ok(
    state.points.length >= 3 && state.points.length <= 7,
    `expected reasonable number of confirmed points, got ${state.points.length}`,
  );
  assert.ok(
    stats.distanceM > 40 && stats.distanceM < 90,
    `walking must continue correctly after the spike, got ${stats.distanceM}`,
  );
}

function testPauseResume() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000, altitudeM: 1500 }),
  });

  state = trackRecorderReducer(state, { type: "pause", now: 5000 });
  state = trackRecorderReducer(state, { type: "resume", now: 6000 });

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518,
      altitudeM: 1600,
      timestamp: 7000,
    }),
  });

  assert.equal(state.points.length, 2, "resumed baseline must be accepted");

  const stats = computeTrackStats(state.points);
  assert.equal(
    stats.distanceM,
    0,
    "movement across the paused period must not count",
  );
  assert.equal(
    stats.elevationGainM,
    0,
    "elevation across the paused period must not count",
  );

  // Need 3 samples outside 15m release radius from new anchor
  // 0.00009 deg = ~10m (within 15m) - rejected
  // 0.00018 deg = ~20m (outside 15m) - evidence 1
  // 0.00027 deg = ~30m (outside 15m) - evidence 2
  // 0.00036 deg = ~40m (outside 15m) - evidence 3 -> confirmed
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00009,
      timestamp: 7000 + 4000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00018,
      timestamp: 7000 + 8000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00027,
      timestamp: 7000 + 12000,
    }),
  });
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({
      latitude: 47.0518 + 0.00036,
      timestamp: 7000 + 16000,
    }),
  });

  const walkingStats = computeTrackStats(state.points);
  assert.ok(
    Math.abs(walkingStats.distanceM - 40) < 0.5,
    `only confirmed post-resume movement must count, got ${walkingStats.distanceM}`,
  );
  assert.equal(
    walkingStats.elevationGainM,
    0,
    "flat post-resume walking adds no elevation",
  );
}

function testFilterHelpers() {
  const origin = {
    latitude: 47,
    longitude: 8,
    altitudeM: null,
    accuracyM: 10,
    timestamp: 1,
  };

  const north = bearingDegrees(origin, {
    ...origin,
    latitude: 47.001,
  });
  const east = bearingDegrees(origin, {
    ...origin,
    longitude: 8.001,
  });
  const south = bearingDegrees(origin, {
    ...origin,
    latitude: 46.999,
  });

  assert.ok(
    Math.abs(north) < 0.5 || Math.abs(north - 360) < 0.5,
    `expected north bearing, got ${north}`,
  );
  assert.ok(Math.abs(east - 90) < 0.5);
  assert.ok(Math.abs(south - 180) < 0.5);
}

async function testPrivacyBoundary() {
  const forbiddenPatterns = [
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "supabase",
    "fetch(",
    "watchPosition",
    "navigator.geolocation",
  ];

  const files = [
    "../components/MountainMap/trackRecording.ts",
    "../components/MountainMap/useGpsTrackRecorder.ts",
  ];

  for (const file of files) {
    const source = await readFile(
      new URL(file, import.meta.url),
      "utf8",
    );

    for (const pattern of forbiddenPatterns) {
      assert.ok(
        !source.includes(pattern),
        `${file} must not use ${pattern}`,
      );
    }
  }
}

async function testRenderingAndPersistenceContracts() {
  const layerSource = await readFile(
    new URL("../components/MountainMap/trackRecordingLayers.ts", import.meta.url),
    "utf8",
  );
  const mapSource = await readFile(
    new URL("../components/recording/TrackRecordingMap.tsx", import.meta.url),
    "utf8",
  );
  const panelSource = await readFile(
    new URL("../components/MountainMap/GpsTrackRecorderPanel.tsx", import.meta.url),
    "utf8",
  );
  const persistenceSource = await readFile(
    new URL("../components/MountainMap/saveRecordedTrack.ts", import.meta.url),
    "utf8",
  );

  const ids = [
    "user-recorded-track",
    "user-recorded-preview",
    "user-location",
    "user-location-accuracy",
    "user-recorded-track-casing",
    "user-recorded-track-line",
    "user-recorded-preview-line",
    "user-location-point",
  ];
  assert.equal(new Set(ids).size, ids.length, "recording source/layer IDs must be unique");
  assert.match(layerSource, /id: USER_RECORDED_TRACK_CASING_LAYER_ID,[\s\S]*?source: USER_RECORDED_TRACK_SOURCE_ID/);
  assert.match(layerSource, /id: USER_RECORDED_TRACK_LINE_LAYER_ID,[\s\S]*?source: USER_RECORDED_TRACK_SOURCE_ID/);
  assert.match(layerSource, /id: USER_RECORDED_PREVIEW_LINE_LAYER_ID,[\s\S]*?source: USER_RECORDED_PREVIEW_SOURCE_ID/);

  const accuracyIndex = layerSource.indexOf("if (!map.getLayer(USER_LOCATION_ACCURACY_LAYER_ID))");
  const casingIndex = layerSource.indexOf("if (!map.getLayer(USER_RECORDED_TRACK_CASING_LAYER_ID))");
  const lineIndex = layerSource.indexOf("if (!map.getLayer(USER_RECORDED_TRACK_LINE_LAYER_ID))");
  const previewIndex = layerSource.indexOf("if (!map.getLayer(USER_RECORDED_PREVIEW_LINE_LAYER_ID))");
  const locationIndex = layerSource.indexOf("if (!map.getLayer(USER_LOCATION_LAYER_ID))");
  assert.ok(accuracyIndex < previewIndex && previewIndex < casingIndex && casingIndex < lineIndex && lineIndex < locationIndex,
    "layer creation order must be accuracy, preview, confirmed casing/line, user point");
  assert.match(layerSource, /visibility: "visible"/);
  assert.match(layerSource, /"line-width": 6/);
  assert.match(layerSource, /"line-opacity": 1/);
  assert.match(mapSource, /synchronizeTrackRecordingSources\([\s\S]*?recordedTrackGeoJsonRef\.current/);
  assert.match(layerSource, /confirmedSource\.setData\(confirmedTrack\)/);
  assert.match(layerSource, /previewSource\.setData\(previewTrack\)/);
  assert.match(mapSource, /map\.on\("style\.load", synchronizeSources\)/);

  assert.match(persistenceSource, /if \(!user\) {[\s\S]*?SaveRecordedTrackAuthenticationError/);
  assert.ok(persistenceSource.indexOf("if (!user)") < persistenceSource.indexOf('.from("gps_activities")'),
    "authentication must be checked before database writes");
  assert.ok(!persistenceSource.includes("options.userId"), "browser user IDs must not be accepted");
  assert.match(panelSource, /await saveRecordedTrack\(\{[\s\S]*?points,/);
  assert.match(panelSource, /SaveRecordedTrackAuthenticationError/);
  assert.match(panelSource, /persistPendingRecordingDraft\(/);
  assert.match(panelSource, /clearPendingRecordingDraft\(\);[\s\S]*?setSaveState\("saved"\)/);
  assert.ok(!panelSource.match(/catch \(error\)[\s\S]{0,500}recorder\.reset\(\)/),
    "save rejection must not reset the completed recording");
}

async function testTranslationCoverage() {
  const catalogs = await Promise.all(
    LOCALES.map(async (locale) =>
      JSON.parse(
        await readFile(
          new URL(`../messages/${locale}/map.json`, import.meta.url),
          "utf8",
        ),
      ),
    ),
  );

  const recorders = catalogs.map(
    (catalog) => catalog.Map.TrackRecorder,
  );

  const keyList = (value) => Object.keys(value).sort().join(",");

  assert.equal(
    new Set(recorders.map((recorder) => keyList(recorder))).size,
    1,
    "TrackRecorder catalog keys differ between locales",
  );

  const requiredKeys = [
    "trackRecording",
    "startRecording",
    "pauseRecording",
    "resumeRecording",
    "finishRecording",
    "resetRecording",
    "recording",
    "paused",
    "trackComplete",
    "waitingForGps",
    "distance",
    "duration",
    "elevationGain",
    "points",
    "pointCount",
    "exportGpx",
    "trackLostOnReload",
    "poorGpsAccuracy",
    "gpsUnavailable",
    "unavailable",
    "needMorePoints",
    "meterUnit",
    "kilometerUnit",
    "durationSeconds",
    "durationMinutes",
    "durationHoursMinutes",
  ];

  for (const recorder of recorders) {
    for (const key of requiredKeys) {
      assert.equal(
        typeof recorder[key],
        "string",
        `TrackRecorder.${key} missing`,
      );
      assert.ok(recorder[key].length > 0);
    }
  }

  for (const catalog of catalogs) {
    const gps = catalog.Map.Gps;
    for (const key of [
      "latitude",
      "longitude",
      "altitude",
      "accuracy",
      "altitudeAccuracy",
      "speed",
      "heading",
      "unavailable",
      "stale",
    ]) {
      assert.equal(typeof gps[key], "string", `Gps.${key} missing`);
      assert.ok(gps[key].length > 0);
    }
  }
}

testNormalization();
testInvalidCoordinateRejection();
testPoorAccuracyRejection();
testDuplicateRejection();
testIdleIgnoresSamples();
testRecordingAcceptsSamples();
testPausedIgnoresSamples();
testResumeAcceptsNewSamples();
testFinishedIgnoresSamples();
testMinimumTrackOnFinish();
testStateTransitions();
testHaversineDistance();
testActiveDurationExcludesPause();
testElevationGainJitterThreshold();
testGeoJsonCoordinateOrder();
testPendingRecordingDraft();
testTrackSourceSynchronization();
testGpxXmlEscaping();
testGpxTimestampsAndElevation();
testGpxFilename();
testDistanceFormatting();
testFullRecordingFlow();
testStationaryJitterRejected();
testFirstPointAccepted();
testNormalWalkingPointsAccepted();
testImpossibleJumpRejected();
testRejectedSamplesDoNotBecomeBaseline();
testPauseResumeNoArtificialDistance();
testStationaryJitterAroundOneLocationStaysNearZero();
testStationaryJitterSixtySeconds();
testWorseGpsJitterSixtySeconds();
testNormalWalkingTwoMinutes();
testWalkingWithTurns();
testSingleGpsSpikeRejected();
testBackAndForthJitter();
testStationaryAnchorDriftTwoMinutes();
testPreviewDoesNotAffectStats();
testPreviewDoesNotAffectGpx();
testWalkingBeginsPreviewReactsImmediately();
testMovementConfirmation();
testWalkingThenStoppingTwoMinutes();
testTurnPreservation();
testSpikeRejection();
testPauseResume();
testFilterHelpers();

function testVisualPositionStationaryLocksToAnchor() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Add stationary jitter - should not move visual position from anchor
  for (let i = 1; i <= 5; i += 1) {
    const offsetM = ((i * 7) % 13) - 6;
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + i * 2000,
      }),
    });
  }

  const rawPosition = gpsPosition({
    latitude: 47.05 + latitudeOffsetDegrees(5), // 5m away from anchor
    timestamp: 1000 + 12000,
  });

  const visualPos = getVisualPosition(state, rawPosition);

  assert.ok(visualPos !== null, "visual position should not be null");
  assert.equal(visualPos.latitude, 47.05, "visual position should be locked to stationary anchor latitude");
  assert.equal(visualPos.longitude, 8.3, "visual position should be locked to stationary anchor longitude");
}

function testVisualPositionStationaryWithRawGpsDrift() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Simulate slow drift over 60 seconds
  for (let i = 1; i <= 60; i += 1) {
    const offsetM = ((i * 11) % 21) - 10;
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + i * 1000,
      }),
    });
  }

  // Raw GPS is now 10m away from anchor
  const rawPosition = gpsPosition({
    latitude: 47.05 + latitudeOffsetDegrees(10),
    timestamp: 1000 + 61000,
  });

  const visualPos = getVisualPosition(state, rawPosition);

  assert.ok(visualPos !== null, "visual position should not be null");
  assert.equal(visualPos.latitude, 47.05, "visual position should remain at anchor despite raw GPS drift");
  assert.equal(visualPos.longitude, 8.3, "visual position should remain at anchor despite raw GPS drift");
}

function testVisualPositionStationaryForOneHundredRawUpdates() {
  let state = recordingState();
  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });
  const anchor = state.stationaryAnchor;
  assert.ok(anchor);

  for (let index = 1; index <= 100; index += 1) {
    const rawPosition = gpsPosition({
      latitude: anchor.latitude + latitudeOffsetDegrees((index % 19) - 9),
      longitude: anchor.longitude,
      timestamp: 1000 + index * 1000,
    });
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: rawPosition,
    });
    assert.deepEqual(getVisualPosition(state, rawPosition), {
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      accuracyM: anchor.accuracyM,
    });
  }
}

function testVisualPositionMovementConfirmedSwitchesToGps() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // 3 samples outside release radius to confirm movement
  for (let i = 1; i <= 3; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(20 + i * 8),
        timestamp: 1000 + i * 10000,
      }),
    });
  }

  // Now in moving state, visual position should follow GPS
  const rawPosition = gpsPosition({
    latitude: 47.05 + latitudeOffsetDegrees(50),
    timestamp: 1000 + 40000,
  });

  const visualPos = getVisualPosition(state, rawPosition);

  assert.ok(visualPos !== null, "visual position should not be null");
  assert.equal(visualPos.latitude, rawPosition.latitude, "visual position should follow raw GPS when moving");
  assert.equal(visualPos.longitude, rawPosition.longitude, "visual position should follow raw GPS when moving");
}

function testVisualPositionMovingFollowsUpdates() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Confirm movement
  for (let i = 1; i <= 3; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(20 + i * 8),
        timestamp: 1000 + i * 10000,
      }),
    });
  }

  // Multiple GPS updates while moving - visual position should follow each
  for (let i = 1; i <= 5; i += 1) {
    const rawPosition = gpsPosition({
      latitude: 47.05 + latitudeOffsetDegrees(50 + i * 2),
      timestamp: 1000 + 40000 + i * 2000,
    });

    const visualPos = getVisualPosition(state, rawPosition);

    assert.ok(visualPos !== null, "visual position should not be null");
    assert.equal(visualPos.latitude, rawPosition.latitude, `visual position should follow GPS update ${i}`);
    assert.equal(visualPos.longitude, rawPosition.longitude, `visual position should follow GPS update ${i}`);
  }
}

function testVisualPositionMovingToStationaryLocksToNewAnchor() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Confirm movement
  for (let i = 1; i <= 3; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(20 + i * 8),
        timestamp: 1000 + i * 10000,
      }),
    });
  }

  // Walk a bit more
  for (let i = 1; i <= 5; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(50 + i * 2),
        timestamp: 1000 + 40000 + i * 2000,
      }),
    });
  }

  const lastConfirmedPoint = state.points[state.points.length - 1];
  const anchorLat = lastConfirmedPoint.latitude;
  const anchorLon = lastConfirmedPoint.longitude;

  // Now stop - 5 sub-threshold samples to trigger stationary
  for (let i = 1; i <= 5; i += 1) {
    const offsetM = ((i * 7) % 7) - 3; // ±3m jitter around last point
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: anchorLat + latitudeOffsetDegrees(offsetM),
        timestamp: 1000 + 50000 + i * 2000,
      }),
    });
  }

  // Should now be stationary with new anchor at last confirmed point
  assert.equal(state.movementState, "stationary", "should be stationary after stopping");
  assert.ok(state.stationaryAnchor !== null, "should have new stationary anchor");

  // Visual position should be locked to new anchor
  const rawPosition = gpsPosition({
    latitude: anchorLat + latitudeOffsetDegrees(5), // 5m away from new anchor
    timestamp: 1000 + 60000,
  });

  const visualPos = getVisualPosition(state, rawPosition);

  assert.ok(visualPos !== null, "visual position should not be null");
  assert.equal(visualPos.latitude, anchorLat, "visual position should be locked to new anchor latitude");
  assert.equal(visualPos.longitude, anchorLon, "visual position should be locked to new anchor longitude");
}

function testVisualPositionPauseDoesNotBreak() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Pause
  state = trackRecorderReducer(state, { type: "pause", now: 5000 });

  // Visual position should still work (use latest preview or anchor)
  const visualPos = getVisualPosition(state, gpsPosition({ timestamp: 6000 }));

  assert.ok(visualPos !== null, "visual position should not be null during pause");
}

function testVisualPositionResetReturnsToNormal() {
  let state = recordingState();

  state = trackRecorderReducer(state, {
    type: "acceptPosition",
    position: gpsPosition({ timestamp: 1000 }),
  });

  // Confirm movement
  for (let i = 1; i <= 3; i += 1) {
    state = trackRecorderReducer(state, {
      type: "acceptPosition",
      position: gpsPosition({
        latitude: 47.05 + latitudeOffsetDegrees(20 + i * 8),
        timestamp: 1000 + i * 10000,
      }),
    });
  }

  // Reset
  state = trackRecorderReducer(state, { type: "reset" });

  // After reset, visual position should be null (no data)
  const visualPos = getVisualPosition(state, null);

  assert.equal(visualPos, null, "visual position should be null after reset with no GPS");
}

testVisualPositionStationaryLocksToAnchor();
testVisualPositionStationaryWithRawGpsDrift();
testVisualPositionStationaryForOneHundredRawUpdates();
testVisualPositionMovementConfirmedSwitchesToGps();
testVisualPositionMovingFollowsUpdates();
testVisualPositionMovingToStationaryLocksToNewAnchor();
testVisualPositionPauseDoesNotBreak();
testVisualPositionResetReturnsToNormal();

await testPrivacyBoundary();
await testRenderingAndPersistenceContracts();
await testTranslationCoverage();

console.log("GPS point normalization: passed");
console.log("Invalid coordinate rejection: passed");
console.log("Poor accuracy rejection (<= 50 m): passed");
console.log("Duplicate point rejection: passed");
console.log("Stationary jitter rejection (accuracy-aware threshold): passed");
console.log("First point acceptance: passed");
console.log("Walking pace point acceptance: passed");
console.log("Implausible speed rejection (> 25 km/h): passed");
console.log("Rejected samples never become the baseline: passed");
console.log("Pause/resume excludes paused-period movement: passed");
console.log("Stationary jitter around one location stays at 0 m: passed");
console.log("60 s stationary jitter stays near 0 m: passed");
console.log("60 s poor-accuracy drift stays near 0 m: passed");
console.log("2 min walking at 5 km/h records realistic distance: passed");
console.log("Walking turns stay visible: passed");
console.log("Single GPS spike rejected, route continues: passed");
console.log("Back-and-forth jitter not counted as walking: passed");
console.log("120 s stationary anchor drift stays near 0 m: passed");
console.log("Preview points do not affect stats: passed");
console.log("Preview points do not affect GPX: passed");
console.log("Walking begins, preview reacts immediately: passed");
console.log("Movement confirmation after sustained displacement: passed");
console.log("Walking then stopping for 2 min: passed");
console.log("Turn preservation: passed");
console.log("Spike rejection: passed");
console.log("Pause/resume: passed");
console.log("Visual position stationary locks to anchor: passed");
console.log("Visual position stationary with raw GPS drift: passed");
console.log("Visual position stationary across 100 raw updates: passed");
console.log("Visual position movement confirmed switches to GPS: passed");
console.log("Visual position moving follows updates: passed");
console.log("Visual position moving->stationary locks to new anchor: passed");
console.log("Visual position pause does not break: passed");
console.log("Visual position reset returns to normal: passed");
console.log("Movement threshold and bearing helpers: passed");
console.log("Recorder state machine (idle/recording/paused/finished): passed");
console.log("Minimum track requirement on finish: passed");
console.log("Haversine distance: passed");
console.log("Active duration excludes pause time: passed");
console.log("Elevation gain jitter threshold (3 m): passed");
console.log("GeoJSON lon/lat coordinate order: passed");
console.log("GPX XML escaping, timestamps, optional <ele>: passed");
console.log("GPX filename: passed");
console.log("Locale-aware distance formatting: passed");
console.log("Full recording flow: passed");
console.log("Privacy boundary (no persistence/network): passed");
console.log("Track recorder translations: passed (de/en/ru/fr/it/es, identical structure)");
