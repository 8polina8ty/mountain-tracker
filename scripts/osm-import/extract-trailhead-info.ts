import { mkdir, writeFile } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine, type OplNode, type OplWay } from "./opl-parser.ts";
import type { Coordinate } from "./peak-matcher.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const OUTPUT_DIR = "data/osm/alps/staging/phase11f2-features";
const WORK_DIR = "data/osm/alps/staging/phase11f2-work";

const tag = "information=guidepost";
const prefix = "trailhead-info";

function centroid(ring: Coordinate[]): Coordinate | null {
  if (ring.length < 3) return null;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const f = xi * yj - xj * yi;
    area += f; cx += (xi + xj) * f; cy += (yi + yj) * f;
  }
  if (area === 0) return null;
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

await mkdir(WORK_DIR, { recursive: true });
const rawPbf = `${WORK_DIR}/${prefix}.pbf`;
const locatedPbf = `${WORK_DIR}/${prefix}-located.pbf`;
await runOsmium(["tags-filter", "--overwrite", "-o", rawPbf, PBF_PATH, `n/${tag}`, `w/${tag}`, `r/${tag}`]);
await runOsmium(["add-locations-to-ways", "--overwrite", "-f", "pbf,locations_on_ways=true,add_metadata=false", "-o", locatedPbf, rawPbf]);

const nodes = new Map<number, OplNode>();
const ways: OplWay[] = [];
await runOsmium(["cat", "-f", "opl,add_metadata=false,locations_on_ways=true", locatedPbf], (line) => {
  const obj = parseOplLine(line);
  if (obj.type === "node" && obj.coordinate) nodes.set(obj.id, obj);
  else if (obj.type === "way") ways.push(obj);
});

const records = [];
for (const way of ways) {
  const ring: Coordinate[] = [];
  let ok = true;
  for (const n of way.nodes) {
    const c = n.coordinate ?? nodes.get(n.nodeId)?.coordinate ?? null;
    if (!c) { ok = false; break; }
    ring.push(c);
  }
  if (!ok) continue;
  const c = centroid(ring);
  if (!c) continue;
  records.push({ objectType: "way", osmid: String(way.id), name: way.tags.name ?? null, tags: way.tags, coordinate: c, wayNodeCount: ring.length });
}
for (const node of nodes.values()) records.push({ objectType: "node", osmid: String(node.id), name: node.tags.name ?? null, tags: node.tags, coordinate: node.coordinate, wayNodeCount: null });

await writeFile(`${OUTPUT_DIR}/${prefix}.json`, JSON.stringify(records, null, 2));
const byType: Record<string, number> = { node: 0, way: 0 };
for (const r of records) byType[r.objectType]++;
console.log("trailhead-info:", JSON.stringify(byType), "total", records.length);
