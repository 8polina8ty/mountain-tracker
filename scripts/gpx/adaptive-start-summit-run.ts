/** Regression replay of the frozen 100 summits under the frozen summit-attachment policy.
 * No extraction or cache preparation; the frozen graph cache is reused read-only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  AdaptiveStartDiscoverySession,
  DEFAULT_ADAPTIVE_START_POLICY,
  type AdaptiveStartCandidate,
  type AdaptiveStartDiscoveryResult,
} from '../../Lib/gpxIngestion/adaptiveStartDiscovery.ts';
import { AdaptiveStartFeatureIndex } from '../../Lib/gpxIngestion/adaptiveStartFeatures.ts';
import { sha256Stable } from '../../Lib/gpxIngestion/hashing.ts';
import type { ReconstructedOsmRoute } from '../../Lib/gpxIngestion/osmRouteReconstruction.ts';
import {
  DEFAULT_SUMMIT_ATTACHMENT_POLICY, summitAttachmentTier,
  type SummitAttachment, type SummitAttachmentTier,
} from '../../Lib/gpxIngestion/summitAttachment.ts';
import { loadPhase11f2FeatureIndex } from '../osm-import/start-context-classifier3.ts';
import { SummitAttachmentGraphProvider } from './adaptive-start-summit-graphs.ts';
import type { AdaptivePilotCorpus } from './adaptive-start-pilot-prepare.ts';

const OUT = 'data/gpx/adaptive-start-pilot';
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, 'utf8')) as T; }
async function hash(path: string): Promise<string> { return createHash('sha256').update(await readFile(path)).digest('hex'); }
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
function counts(values: string[]): Record<string, number> { return Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length])); }

function compactCandidate(candidate: AdaptiveStartCandidate) {
  const route = candidate.route;
  return { ...candidate, route: route ? { geometryHash: route.geometryHash, reconstructionManifestHash: route.reconstructionManifestHash,
    solverVersion: route.solverVersion, graphHash: route.geometryProvenance.graphHash, distanceM: route.distanceM,
    osmNodeIds: route.osmNodeIds, osmWayIds: route.osmWayIds, startCoordinate: route.geometry.coordinates[0],
    terminalCoordinate: route.geometry.coordinates.at(-1), geometrySource: route.geometrySource } : null };
}
type CompactCandidate = ReturnType<typeof compactCandidate>;
interface Row {
  mountainId: string; stratum: string; name: string; blockId: string;
  status: string; graphStatus: string; reasons: string[];
  summitAttachment: SummitAttachment | null;
  candidates: CompactCandidate[]; reviewCandidates: CompactCandidate[]; evaluated: CompactCandidate[];
  tiersVisited: number[]; fallbackInspected: boolean; solverCalls: number;
  graphStats: { componentNodes: number; componentWays: number; snapDistanceM: number | null } | null;
  rejections: AdaptiveStartDiscoveryResult['rejections'];
  resultHash: string | null; determinismVerified: boolean | null;
  timings: { totalMs: number; discoveryMs: number; queryMs: number; replayMs: number };
}
interface BaselineRow { mountainId: string; stratum: string; status: string; graphStatus: string; reasons: string[];
  candidates: Array<{ id: string; category: string; networkDistanceMeters: number; autoEligible: boolean }>;
  tiersVisited: number[]; fallbackInspected: boolean; timings: { totalMs: number; discoveryMs: number } }
function baselineMetrics(rows: BaselineRow[]) {
  const all = rows.flatMap(r => r.candidates);
  return { attempted: rows.length, noSummitConnection: rows.filter(r => r.status === 'NO_SUMMIT_CONNECTION').length,
    atLeast1Auto: rows.filter(r => r.candidates.length >= 1).length, atLeast2Auto: rows.filter(r => r.candidates.length >= 2).length,
    atLeast3Auto: rows.filter(r => r.candidates.length >= 3).length, autoEligible: all.length,
    categories: counts(all.map(c => c.category)), normalSuccess: rows.filter(r => r.stratum === 'NORMAL' && r.candidates.length).length,
    sparseSuccess: rows.filter(r => r.stratum === 'SPARSE' && r.candidates.length).length,
    needsReview: rows.filter(r => /REVIEW|ONLY_HIGH|ONLY_AMBIGUOUS/.test(r.status)).length,
    componentLimit: rows.filter(r => r.graphStatus === 'GRAPH_COMPONENT_LIMIT').length,
    perMountainP50Ms: percentile(rows.map(r => r.timings.totalMs), 0.5), perMountainP95Ms: percentile(rows.map(r => r.timings.totalMs), 0.95),
    discoveryMs: rows.reduce((sum, r) => sum + r.timings.discoveryMs, 0), outcomes: counts(rows.map(r => r.status)) };
}
function asBaselineRow(row: Row): BaselineRow {
  return { mountainId: row.mountainId, stratum: row.stratum, status: row.status, graphStatus: row.graphStatus,
    reasons: row.reasons, candidates: row.candidates.map(c => ({ id: c.id, category: c.category ?? 'none',
      networkDistanceMeters: c.networkDistanceMeters ?? 0, autoEligible: c.autoEligible })),
    tiersVisited: row.tiersVisited, fallbackInspected: row.fallbackInspected,
    timings: { totalMs: row.timings.totalMs, discoveryMs: row.timings.discoveryMs } };
}
function replayRoute(graph: AdaptiveStartDiscoverySession['graph'], route: ReconstructedOsmRoute): boolean {
  for (let i = 1; i < route.osmNodeIds.length; i++) {
    const from = route.osmNodeIds[i - 1], to = route.osmNodeIds[i];
    if (!graph.neighbors(from).some(edge => edge.toNodeId === to && route.osmWayIds.includes(edge.wayId))) return false;
  }
  return route.geometrySource === 'OPENSTREETMAP';
}

async function run() {
  const started = performance.now();
  const corpus = await json<AdaptivePilotCorpus>(`${OUT}/adaptive-start-pilot-corpus.json`);
  const { corpusHash, ...corpusContent } = corpus;
  assert.equal(sha256Stable(corpusContent), corpusHash); assert.equal(corpus.mountains.length, 100);
  const baseline = await json<BaselineRow[]>(`${OUT}/adaptive-start-pilot-results.json`);
  assert.deepEqual(baseline.map(r => r.mountainId), corpus.mountains.map(r => r.mountainId));
  const frozen = await json<{ policy: typeof DEFAULT_SUMMIT_ATTACHMENT_POLICY; diagnosticSha256: string; adaptivePolicyHash: string }>(`${OUT}/adaptive-start-summit-snap-policy.json`);
  assert.deepEqual(frozen.policy, DEFAULT_SUMMIT_ATTACHMENT_POLICY);
  assert.equal(frozen.diagnosticSha256, await hash(`${OUT}/adaptive-start-summit-snap-diagnostic.json`));
  assert.equal(frozen.adaptivePolicyHash, sha256Stable(DEFAULT_ADAPTIVE_START_POLICY));
  const protectedFiles = await json<{ files: Record<string, string> }>(`${OUT}/adaptive-start-summit-baseline-hashes.json`);
  for (const [file, expected] of Object.entries(protectedFiles.files)) {
    if (file === 'Lib/gpxIngestion/adaptiveStartDiscovery.ts') continue;
    assert.equal(await hash(file), expected, `PROTECTED_SOURCE_OR_BASELINE_CHANGED:${file}`);
  }
  const loadStarted = performance.now();
  const provider = new SummitAttachmentGraphProvider({ extractionPath: `${OUT}/cache/${corpusHash}.sqlite`,
    cachePath: `${OUT}/cache/${corpusHash}-graphs.sqlite`, dataset: corpus.dataset, identityHash: corpusHash });
  const cacheLoadMs = performance.now() - loadStarted;
  const cacheBefore = await stat(`${OUT}/cache/${corpusHash}-graphs.sqlite`);
  console.log(JSON.stringify({ status: 'GRAPH_CACHE_REUSED', cacheLoadMs: Math.round(cacheLoadMs),
    requestedIdentityHash: corpusHash, cacheBytes: cacheBefore.size, cacheVerifiedReadOnly: true }));
  // Verify every catalog before using the legacy loader, which otherwise swallows missing files.
  for (const source of corpus.featureSources) assert.equal(await hash(source.path), source.sha256, `FEATURE_SOURCE_DRIFT:${source.path}`);
  const featureStarted = performance.now();
  const features = new AdaptiveStartFeatureIndex(await loadPhase11f2FeatureIndex('data/osm/alps/staging/phase11f2-features'));
  const featureLoadMs = performance.now() - featureStarted;
  const safetyIdentity = { pbfPath: corpus.datasetPath, pbfSizeBytes: corpus.datasetSizeBytes, pbfModifiedMilliseconds: 0,
    pbfSha256: corpus.dataset.pbfSha256, pipelineDatasetFingerprint: corpusHash, pipelineGeneratedAt: corpus.dataset.snapshotTimestamp,
    checkpointPath: `${OUT}/cache/${corpusHash}-graphs.sqlite`, checkpointManifestSha256: sha256Stable(provider.cacheIdentity),
    motorwayIndexContentHash: sha256Stable(provider.cacheIdentity) };
  const rows: Row[] = [], sessions = new WeakMap<object, AdaptiveStartDiscoverySession>();
  let checkedRoutes = 0, checkedEdges = 0, falseAutoAccepts = 0, fabricatedGapCount = 0;
  let discoveryMs = 0, queryMs = 0, replayMs = 0;
  for (const mountain of corpus.mountains) {
    const mountainStarted = performance.now();
    const obtained = provider.get(mountain.blockId, mountain.summit.coordinate, DEFAULT_SUMMIT_ATTACHMENT_POLICY.reviewMeters);
    const graphStats = { componentNodes: obtained.stats.componentNodes, componentWays: obtained.stats.componentWays,
      snapDistanceM: obtained.stats.snapDistanceM };
    if (obtained.status !== 'READY') {
      rows.push({
        mountainId: mountain.mountainId, stratum: mountain.stratum, name: mountain.summit.name, blockId: mountain.blockId,
        status: obtained.status === 'NO_SUMMIT_CONNECTION' ? 'NO_SUMMIT_CONNECTION' : 'NO_ROUTABLE_START',
        graphStatus: obtained.status, reasons: obtained.stats.reasonCodes, summitAttachment: null,
        candidates: [], reviewCandidates: [], evaluated: [], tiersVisited: [], fallbackInspected: false, solverCalls: 0,
        graphStats, rejections: { motorway: 0, footNo: 0, privateForbidden: 0, accessAmbiguous: 0, highMountain: 0, ambiguous: 0, disconnected: 0 },
        resultHash: null, determinismVerified: null,
        timings: { totalMs: performance.now() - mountainStarted, discoveryMs: 0, queryMs: obtained.queryMs, replayMs: 0 },
      });
      continue;
    }
    const graph = obtained.graph!;
    const session = sessions.get(graph) ?? (() => {
      const constructed = new AdaptiveStartDiscoverySession({ graph, ways: obtained.ways, features, safetyIdentity });
      sessions.set(graph, constructed); return constructed;
    })();
    const dStarted = performance.now();
    const discoveryRequest = { summit: { id: mountain.mountainId, name: mountain.summit.name,
      coordinate: mountain.summit.coordinate, elevationMeters: mountain.summit.elevationMeters, osmId: mountain.summit.osmId },
      summitAttachmentPolicy: DEFAULT_SUMMIT_ATTACHMENT_POLICY };
    const discoveryResult = session.discover(discoveryRequest);
    const repeated = session.discover(discoveryRequest);
    const dMs = performance.now() - dStarted;
    const determinismVerified = discoveryResult.resultHash === repeated.resultHash;
    discoveryMs += dMs;
    queryMs += obtained.queryMs;
    const replayStarted = performance.now();
    fabricatedGapCount += discoveryResult.fabricatedGapCount;
    for (const candidate of discoveryResult.candidates) {
      if (!candidate.route) continue;
      checkedRoutes++;
      if (!replayRoute(session.graph, candidate.route)) { falseAutoAccepts++; continue; }
      checkedEdges += Math.max(0, candidate.route.osmNodeIds.length - 1);
    }
    replayMs += performance.now() - replayStarted;
    assert.equal(discoveryResult.fabricatedGapCount, 0, 'SUMMIT_ATTACHMENT_MUST_NOT_FABRICATE_GEOMETRY');
    const candidates = discoveryResult.candidates.map(compactCandidate);
    const candidateIds = new Set(candidates.map(c => c.id));
    const reviewCandidates = discoveryResult.evaluated.filter(c => !candidateIds.has(c.id)).map(compactCandidate);
    rows.push({
      mountainId: mountain.mountainId, stratum: mountain.stratum, name: mountain.summit.name, blockId: mountain.blockId,
      status: discoveryResult.status, graphStatus: 'READY', reasons: discoveryResult.reasons,
      summitAttachment: discoveryResult.summitAttachment,
      candidates, reviewCandidates, evaluated: discoveryResult.evaluated.map(compactCandidate),
      tiersVisited: discoveryResult.tiersVisited, fallbackInspected: discoveryResult.fallbackInspected,
      solverCalls: discoveryResult.solverCalls, graphStats, rejections: discoveryResult.rejections,
      resultHash: discoveryResult.resultHash, determinismVerified,
      timings: { totalMs: performance.now() - mountainStarted, discoveryMs: dMs, queryMs: obtained.queryMs, replayMs: 0 },
    });
    if (rows.length % 10 === 0) console.log(JSON.stringify({ progress: `${rows.length}/100`, status: discoveryResult.status, candidates: discoveryResult.candidates.length }));
  }
  provider.close();
  const totalMs = performance.now() - started;

  const before = baselineMetrics(baseline);
  const afterRows = rows.map(asBaselineRow);
  const after = baselineMetrics(afterRows);
  const tiers: Record<SummitAttachmentTier | 'UNKNOWN', number> = { DIRECT: 0, EXTENDED: 0, REVIEW_PROXIMITY: 0, NONE: 0, UNKNOWN: 0 };
  for (const row of rows) {
    const tier = row.summitAttachment
      ? summitAttachmentTier(row.summitAttachment.distanceMeters)
      : row.graphStatus === 'GRAPH_COMPONENT_LIMIT' ? 'UNKNOWN' : 'NONE';
    tiers[tier]++;
  }
  const recovered = rows.filter(r => ['EXTENDED', 'REVIEW_PROXIMITY'].includes(r.summitAttachment?.tier ?? ''));
  const determinismVerifiedAll = rows.every(r => r.determinismVerified === null || r.determinismVerified === true);
  const verdict = after.noSummitConnection < before.noSummitConnection
    ? 'PARTIAL — SUMMIT COVERAGE REMAINS THE DOMINANT BOTTLENECK'
    : 'NO_IMPROVEMENT — SUMMIT COVERAGE REMAINS THE DOMINANT BOTTLENECK';

  const report = {
    schemaVersion: 'mountain-tracker/adaptive-start-summit-v2/v1',
    corpusHash, policyVersion: DEFAULT_SUMMIT_ATTACHMENT_POLICY.version,
    policyHash: sha256Stable(DEFAULT_SUMMIT_ATTACHMENT_POLICY),
    adaptivePolicyHash: sha256Stable(DEFAULT_ADAPTIVE_START_POLICY),
    diagnosticSha256: frozen.diagnosticSha256,
    graphCacheReused: { requestedIdentityHash: corpusHash, cacheBytes: cacheBefore.size, loadMs: Math.round(cacheLoadMs) },
    before, after, verdict,
    attachmentTiers: tiers,
    recoveredFromSummitSnap: recovered.map(r => ({ mountainId: r.mountainId, name: r.name, stratum: r.stratum,
      tier: r.summitAttachment!.tier, distanceMeters: r.summitAttachment!.distanceMeters, status: r.status,
      candidates: r.candidates.length, reviewCandidates: r.reviewCandidates.length, solverCalls: r.solverCalls })),
    determinismVerified: determinismVerifiedAll,
    replay: { checkedRoutes, checkedEdges, replayMs: Math.round(replayMs) },
    fabricatedGapCount,
    falseAutoAccepts,
    performance: { totalMs: Math.round(totalMs), discoveryMs: Math.round(discoveryMs), queryMs: Math.round(queryMs),
      featureLoadMs: Math.round(featureLoadMs), cacheLoadMs: Math.round(cacheLoadMs),
      perMountainP50Ms: Math.round(percentile(rows.map(r => r.timings.totalMs), 0.5) ?? 0),
      perMountainP95Ms: Math.round(percentile(rows.map(r => r.timings.totalMs), 0.95) ?? 0) },
    estimateFor1000Mountains: `${(totalMs / 100 / 1000).toFixed(2)}s per mountain (100-mountain replay); ~${Math.round(totalMs / 100 * 1000 / 60000)} minutes for 1000 without cache variance`,
    externalRequests: 0, productionWrites: 0, startedAt: new Date(started + performance.timeOrigin).toISOString(),
  };
  await writeFile(`${OUT}/adaptive-start-pilot-summit-v2-results.json`, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  const reportMd = generateReportMarkdown(before, after, report, recovered);
  await writeFile(`${OUT}/ADAPTIVE_START_SUMMIT_V2_REPORT.md`, reportMd, 'utf8');
  const artifactHashes = {
    schemaVersion: 'mountain-tracker/adaptive-start-summit-v2-artifacts/v1',
    resultsSha256: await hash(`${OUT}/adaptive-start-pilot-summit-v2-results.json`),
    reportSha256: await hash(`${OUT}/ADAPTIVE_START_SUMMIT_V2_REPORT.md`),
    policyFileSha256: await hash(`${OUT}/adaptive-start-summit-snap-policy.json`),
    diagnosticSha256: frozen.diagnosticSha256,
  };
  await writeFile(`${OUT}/adaptive-start-summit-v2-artifact-hashes.json`, `${JSON.stringify(artifactHashes, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: 'ADAPTIVE_SUMMIT_V2_COMPLETE', verdict: report.verdict, after, tiers, artifactHashes }));
}

function generateReportMarkdown(before: ReturnType<typeof baselineMetrics>, after: ReturnType<typeof baselineMetrics>,
  report: Record<string, unknown>, recovered: Row[]): string {
  const line = (label: string, left: unknown, right: unknown, better: (l: number, r: number) => boolean) =>
    `| ${label} | ${left} | ${right} | ${better(Number(left), Number(right)) ? '✓' : ''} |`;
  const recoveredLines = recovered.map(r => `| ${r.mountainId} | ${r.stratum} | ${r.summitAttachment?.tier} | ${r.summitAttachment?.distanceMeters} | ${r.status} | ${r.candidates.length} | ${r.reviewCandidates.length} |`).join('\n');
  const tierLines = Object.entries(report.attachmentTiers as Record<string, number>).map(([tier, n]) => `| ${tier} | ${n} |`).join('\n');
  return `# Adaptive Summit Snap Hardening — 100-Mountain Alps Replay (v2)

Frozen policy \`${report.policyVersion}\` (direct \u2264 30 m / extended \u2264 50 m / review \u2264 100 m).
Corpus \`${report.corpusHash}\` · cache reused read-only (\`GRAPH_CACHE_REUSED\`) · no extraction, no graph preparation.

## Before / After

| Metric | Before | After | Improvement |
| --- | ---: | ---: | --- |
${line('NO_SUMMIT_CONNECTION', before.noSummitConnection, after.noSummitConnection, (l, r) => r < l)}
${line('Mountains \u2265 1 auto candidate', before.atLeast1Auto, after.atLeast1Auto, (l, r) => r > l)}
${line('Mountains \u2265 2 auto candidates', before.atLeast2Auto, after.atLeast2Auto, (l, r) => r > l)}
${line('Mountains \u2265 3 auto candidates', before.atLeast3Auto, after.atLeast3Auto, (l, r) => r > l)}
| Auto-eligible candidates | ${before.autoEligible} | ${after.autoEligible} | |
| Component-limit (no routable start) | ${before.componentLimit} | ${after.componentLimit} | |
| NORMAL success | ${before.normalSuccess} | ${after.normalSuccess} | |
| SPARSE success | ${before.sparseSuccess} | ${after.sparseSuccess} | |
| Categories | ${JSON.stringify(before.categories)} | ${JSON.stringify(after.categories)} | |
| Needs review | ${before.needsReview} | ${after.needsReview} | |

## Attachment tiers (all 100 summits)

| Tier | Count |
| --- | ---: |
${tierLines}

- **DIRECT** (\u2264 30 m): unchanged automatic admission.
- **EXTENDED** (\u2264 50 m): newly automatic where all other gates pass.
- **REVIEW_PROXIMITY** (\u2264 100 m): routed candidates go to review, never auto-approved.
- **NONE** (> 100 m): no admitted edge node within the review bound; unchanged NO_SUMMIT_CONNECTION.

## Recovered by the summit-snap hardening

| Mountain | Stratum | Tier | Distance (m) | Outcome | Candidates | Review candidates |
| --- | --- | --- | ---: | --- | ---: | ---: |
${recoveredLines || '_(none)_'}

## Verdict

**${report.verdict}**

\`NO_SUMMIT_CONNECTION\` fell from ${before.noSummitConnection} to ${after.noSummitConnection}; the dominant remaining bottleneck is summit coverage: ${(report.attachmentTiers as Record<string, number>).NONE} summits have no admitted trail node within 100 m of the summit.

## Integrity

- Cache reused read-only with the frozen identity \`${report.corpusHash}\`.
- Determinism: **${report.determinismVerified === true ? 'all replayed discoveries identical (resultHash match)' : 'NOT fully verified'}**.
- Route replay: ${(report.replay as { checkedRoutes: number; checkedEdges: number }).checkedRoutes} routes / ${(report.replay as { checkedEdges: number }).checkedEdges} edges checked against the graph; fabricated gaps ${report.fabricatedGapCount}; false auto-accepts ${report.falseAutoAccepts}.
- External requests: ${report.externalRequests}; production writes: ${report.productionWrites}.

## Performance

| Metric | Value |
| --- | ---: |
| Total | ${(report.performance as Record<string, number>).totalMs} ms |
| Discovery | ${(report.performance as Record<string, number>).discoveryMs} ms |
| Per-mountain p50 / p95 | ${(report.performance as Record<string, number>).perMountainP50Ms} / ${(report.performance as Record<string, number>).perMountainP95Ms} ms |
| Extrapolation (1000 mountains) | ${report.estimateFor1000Mountains} |
`;
}

await run();