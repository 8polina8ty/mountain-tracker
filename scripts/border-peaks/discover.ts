#!/usr/bin/env ts-node
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import type { MountainRef, BorderCandidate, ExistingMembership, DiscoverySummary } from "./types.ts";
import { bboxForPoint, GridIndex, pointToSegmentMeters, segmentToSegmentMeters } from "./spatial.ts";
import { classifyCandidate, reasonFor } from "./classify.ts";
import { parseAdminBoundaryDataset, type AdminBoundaryDataset } from "../osm-import/admin-boundary.ts";
type Args = { input: string; output: string; limit: number; country?: string; dryRun: boolean; resume: boolean; };
function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return { input: get("--input") ?? "data/border-peaks/fixtures.jsonl", output: get("--output") ?? "data/border-peaks", limit: Number(get("--limit") ?? "1000"), country: get("--country") ?? undefined, dryRun: a.includes("--dry-run"), resume: a.includes("--resume") };
}
type BoundaryStub = { countryPair: string; line: [number, number][] };
// Test-only synthetic stubs (production discover fails closed if real dataset missing)
const ALPS_BORDER_STUBS: BoundaryStub[] = [
  { countryPair: "AT-DE", line: [[10.3, 47.35], [10.9, 47.45]] },
  { countryPair: "AT-CH", line: [[10.0, 46.9], [10.5, 47.1]] },
  { countryPair: "CH-IT", line: [[9.5, 46.2], [10.5, 46.6]] },
];
void ALPS_BORDER_STUBS;
type IntlSegment = { pair: string; a: [number, number]; b: [number, number]; bbox: [number, number, number, number]; featureIds: string[]; countryA: string; countryB: string };
async function loadRealBoundaries(): Promise<{ dataset: AdminBoundaryDataset | null; segments: IntlSegment[]; countries: string[] }> {
  const path = "data/osm/boundaries/alps-admin.geojson";
  if (!existsSync(path)) return { dataset: null, segments: [], countries: [] };
  const raw = readFileSync(path, "utf8");
  const ds = parseAdminBoundaryDataset(JSON.parse(raw));
  const segments: IntlSegment[] = [];
  for (const f of ds.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i] as [number, number], b = ring[i+1] as [number, number];
      if (!a || !b || a.length < 2 || b.length < 2) continue;
      segments.push({ pair: "", a, b, bbox: [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])], featureIds: [f.id], countryA: f.properties.countryCode, countryB: "" });
    }
  }
  const countries = [...new Set(ds.features.map(f => f.properties.countryCode))].sort();
  return { dataset: ds, segments, countries };
}
async function* mountainsFromJsonl(path: string): AsyncGenerator<MountainRef> {
  if (!existsSync(path)) return;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) { if (!line.trim()) continue; const o = JSON.parse(line); yield { id: Number(o.id), name: o.name ?? null, name_de: o.name_de ?? null, latitude: Number(o.latitude), longitude: Number(o.longitude), height: o.height ?? null, primaryCountryCode: o.primaryCountryCode ?? o.country_code ?? null }; }
}
async function main() {
  const args = parseArgs();
  mkdirSync(args.output, { recursive: true });
  const outCandidates = `${args.output}/candidates.jsonl`;
  const outConfirmed = `${args.output}/confirmed.jsonl`;
  const outReview = `${args.output}/review.jsonl`;
  const outRejected = `${args.output}/rejected.jsonl`;
  const outSummary = `${args.output}/summary.json`;
  const resumeOffset = args.resume && existsSync(outCandidates) ? readFileSync(outCandidates, "utf8").trim().split("\n").filter(Boolean).length : 0;
  const real = await loadRealBoundaries();
  const useReal = real.dataset != null && real.segments.length > 0;
  if (!useReal) throw new Error("Missing required real boundary dataset: data/osm/boundaries/alps-admin.geojson is unavailable or contains no segments. ADM1 internal boundaries cannot be used as international. Obtain reviewed ADM0/international dataset (see scripts/osm-import/BOUNDARY_DATA.md). Synthetic geometry is test-only.");
  const realIndex = new GridIndex<IntlSegment>(0.5);
  for (const seg of real.segments) realIndex.insert(seg.bbox, seg);
  let examined = 0, near = 0, confirmed = 0, review = 0, rejected = 0, skippedExisting = 0;
  const perPair: Record<string, number> = {};
  const existing: Map<number, Set<string>> = new Map();
  try { const rows: ExistingMembership[] = JSON.parse(readFileSync(`${args.output}/existing_memberships.json`, "utf8")); for (const r of rows) { const s = existing.get(r.mountain_id) ?? new Set(); s.add(r.country_code); existing.set(r.mountain_id, s); } } catch {}
  if (args.resume && resumeOffset > 0) console.log(`resume: skipping ${resumeOffset} already written candidates`);
  let _written = 0;
  for await (const m of mountainsFromJsonl(args.input)) {
    if (args.country && m.primaryCountryCode !== args.country) continue;
    if (examined < resumeOffset) { examined++; continue; }
    if (examined >= args.limit) break;
    examined++;
    if (m.latitude == null || m.longitude == null || !Number.isFinite(m.latitude) || !Number.isFinite(m.longitude)) {
      const c: BorderCandidate = { mountain_id: m.id, mountain_name: m.name_de ?? m.name, latitude: m.latitude, longitude: m.longitude, height: m.height, primary_country_code: m.primaryCountryCode, candidate_country_code: m.primaryCountryCode ?? "??", classification: "REVIEW", evidence_type: "CANDIDATE", boundary_source: "unknown", boundary_source_id: null, boundary_dataset_version: null, boundary_license: null, coordinate_precision_meters: null, boundary_precision_meters: null, distance_to_boundary_meters: null, supporting_external_reference: null, reason: "Missing or invalid coordinate; REVIEW.", review_notes: "synthetic fixture for test" };
      review++; if (!args.dryRun) { appendFileSync(outCandidates, JSON.stringify(c)+"\n"); appendFileSync(outReview, JSON.stringify(c)+"\n"); } continue;
    }
    const pt: [number, number] = [m.longitude, m.latitude];
    const searchBbox = bboxForPoint(pt, 5000);
    const segs = realIndex.query(searchBbox);
    const perCountry = new Map<string, { dist: number; seg: IntlSegment }>();
    for (const seg of segs) { const d = pointToSegmentMeters(pt, seg.a, seg.b); const cur = perCountry.get(seg.countryA); if (cur == null || d < cur.dist) perCountry.set(seg.countryA, { dist: d, seg }); }
    const primaryEntry = m.primaryCountryCode ? perCountry.get(m.primaryCountryCode) : null;
    const primaryDist = primaryEntry?.dist ?? null;
    let foreignBest: { code: string; dist: number; seg: IntlSegment } | null = null;
    for (const [code, { dist, seg }] of perCountry) { if (code === m.primaryCountryCode) continue; if (dist > 5000) continue; if (primaryDist != null && primaryDist > 5000) continue; if (foreignBest == null || dist < foreignBest.dist) foreignBest = { code, dist, seg }; }
    let bestDist: number | null = null, bestPair: string | null = null, bestSegId: string | null = null;
    if (foreignBest && primaryEntry) {
      const inter = segmentToSegmentMeters(primaryEntry.seg.a, primaryEntry.seg.b, foreignBest.seg.a, foreignBest.seg.b);
      if (inter > 50) { bestPair = null; bestDist = null; bestSegId = null; } else { bestDist = Math.min(primaryDist ?? foreignBest.dist, foreignBest.dist); bestPair = [m.primaryCountryCode, foreignBest.code].sort().join("-"); bestSegId = `${primaryEntry.seg.featureIds[0]},${foreignBest.seg.featureIds[0]}`; }
    } else if (primaryDist != null && primaryDist <= 5000) { bestDist = primaryDist; bestPair = null; }
    const hasInternationalGeometry = bestPair != null;
    if (bestDist == null || bestDist > 5000 || !hasInternationalGeometry) {
      rejected++; const c: BorderCandidate = { mountain_id: m.id, mountain_name: m.name_de ?? m.name, latitude: m.latitude, longitude: m.longitude, height: m.height, primary_country_code: m.primaryCountryCode, candidate_country_code: m.primaryCountryCode ?? "", classification: "REJECTED", evidence_type: null, boundary_source: real.dataset?.metadata.provider ?? "geoBoundaries gbOpen", boundary_source_id: bestSegId, boundary_dataset_version: real.dataset?.metadata.version ?? "9469f09", boundary_license: real.dataset?.metadata.license ?? "mixed", coordinate_precision_meters: 30, boundary_precision_meters: 50, distance_to_boundary_meters: bestDist, supporting_external_reference: null, reason: reasonFor("REJECTED", bestDist), review_notes: hasInternationalGeometry ? "Near primary edge but not international; REJECTED." : "Outside 5km border buffer or internal ADM1 only; REJECTED." };
      if (!args.dryRun) { appendFileSync(outCandidates, JSON.stringify(c)+"\n"); appendFileSync(outRejected, JSON.stringify(c)+"\n"); } continue;
    }
    near++;
    const pairCountries = bestPair!.split("-");
    const candidateCountry = pairCountries.find(c => c !== m.primaryCountryCode) ?? pairCountries[0];
    if (existing.get(m.id)?.has(candidateCountry)) { skippedExisting++; continue; }
    const supportingRef = `OSM:summit:${m.id}`; // summit identity alone — dual membership requires separate reviewed evidence, not auto-generated
    const cls = classifyCandidate({ distanceMeters: bestDist, boundarySource: real.dataset?.metadata.source ?? "geoBoundaries", supportingReference: supportingRef, coordinateAccuracyMeters: 30, boundaryPrecisionMeters: 50, conflictingSources: false, disputed: false, hasInternationalGeometry });
    const hasVerified = /dual.*border/i.test(supportingRef);
    const evidence: BorderCandidate["evidence_type"] = cls === "CONFIRMED" && hasVerified ? "EXTERNALLY_VERIFIED" : cls === "CONFIRMED" ? "GEOMETRICALLY_SUPPORTED" : cls === "REVIEW" ? "CANDIDATE" : null;
    if (cls === "CONFIRMED") confirmed++; else if (cls === "REVIEW") review++; else rejected++;
    if (cls === "CONFIRMED") perPair[bestPair!] = (perPair[bestPair!] ?? 0) + 1;
    const out: BorderCandidate = { mountain_id: m.id, mountain_name: m.name_de ?? m.name, latitude: m.latitude, longitude: m.longitude, height: m.height, primary_country_code: m.primaryCountryCode, candidate_country_code: candidateCountry, classification: cls, evidence_type: evidence, boundary_source: real.dataset?.metadata.provider ?? "geoBoundaries gbOpen", boundary_source_id: bestSegId ?? bestPair, boundary_dataset_version: real.dataset?.metadata.version ?? "9469f09 2023-12-12", boundary_license: real.dataset?.metadata.license ?? "mixed", coordinate_precision_meters: 30, boundary_precision_meters: 50, distance_to_boundary_meters: Math.round(bestDist), supporting_external_reference: supportingRef, reason: reasonFor(cls, Math.round(bestDist)), review_notes: "real ADM1 polygon point-to-segment; international via coincident outer segments (<50m)", existing_memberships: existing.has(m.id) ? Array.from(existing.get(m.id)!).map(cc => ({ mountain_id: m.id, country_code: cc, is_primary: cc === m.primaryCountryCode })) : [] };
    if (!args.dryRun) { appendFileSync(outCandidates, JSON.stringify(out)+"\n"); if (cls === "CONFIRMED") appendFileSync(outConfirmed, JSON.stringify(out)+"\n"); else if (cls === "REVIEW") appendFileSync(outReview, JSON.stringify(out)+"\n"); else appendFileSync(outRejected, JSON.stringify(out)+"\n"); }
    _written++;
  }
  void _written;
  const summary: DiscoverySummary = { total_mountains_examined: examined, near_border_candidates: near, confirmed, review, rejected, existing_memberships_skipped: skippedExisting, source_conflicts: 0, countries_covered: real.countries, per_country_pair: perPair, dataset: { provider: real.dataset!.metadata.provider, dataset: real.dataset!.metadata.dataset, version: real.dataset!.metadata.version }, generated_at: new Date().toISOString() };
  if (!args.dryRun) writeFileSync(outSummary, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
