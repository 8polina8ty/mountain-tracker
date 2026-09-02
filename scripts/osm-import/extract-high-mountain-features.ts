import { mkdir, writeFile } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine } from "./opl-parser.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const OUTPUT_DIR = "data/osm/alps/staging/phase11f2-features";
const WORK_DIR = "data/osm/alps/staging/phase11f2-work";

export interface FetchRecord {
  objectType: "node" | "way" | "relation";
  osmid: string;
  name: string | null;
  tags: Record<string, string>;
  coordinate: [number, number] | null;
  wayNodeCount: number | null;
}

function polygonCentroid(ring: [number, number][]): [number, number] | null {
  if (ring.length < 3) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const f = xi * yj - xj * yi;
    area += f;
    cx += (xi + xj) * f;
    cy += (yi + yj) * f;
  }
  if (area === 0) return null;
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

async function extractCategory(tag: string, prefix: string): Promise<FetchRecord[]> {
  await mkdir(WORK_DIR, { recursive: true });
  const rawPbf = `${WORK_DIR}/${prefix}.pbf`;
  const locatedPbf = `${WORK_DIR}/${prefix}-located.pbf`;

  await runOsmium([
    "tags-filter", "--overwrite", "-o", rawPbf, PBF_PATH,
    `n/${tag}`, `w/${tag}`, `r/${tag}`,
  ]);
  await runOsmium([
    "add-locations-to-ways",
    "-f", "pbf,locations_on_ways=true,add_metadata=false",
    "-o", locatedPbf, rawPbf,
  ]);

  const nodes = new Map<number, { id: number; coordinate: [number, number]; tags: Record<string, string> }>();
  const ways: Array<{ id: number; nodes: Array<{ nodeId: number; coordinate: [number, number] | null }>; tags: Record<string, string> }> = [];
  await runOsmium(
    ["cat", "-f", "opl,add_metadata=false,locations_on_ways=true", locatedPbf],
    (line) => {
      const obj = parseOplLine(line);
      if (obj.type === "node" && obj.coordinate) {
        nodes.set(obj.id, { id: obj.id, coordinate: obj.coordinate, tags: obj.tags });
      } else if (obj.type === "way") {
        ways.push({
          id: obj.id,
          nodes: obj.nodes.map((n) => ({ nodeId: n.nodeId, coordinate: n.coordinate ?? null })),
          tags: obj.tags,
        });
      }
    },
  );

  const records: FetchRecord[] = [];
  for (const way of ways) {
    const ring: [number, number][] = [];
    let ok = true;
    for (const n of way.nodes) {
      const c = n.coordinate ?? nodes.get(n.nodeId)?.coordinate ?? null;
      if (!c) { ok = false; break; }
      ring.push(c);
    }
    if (!ok) continue;
    const centroid = polygonCentroid(ring);
    if (!centroid) continue;
    records.push({
      objectType: "way",
      osmid: String(way.id),
      name: way.tags.name ?? null,
      tags: way.tags,
      coordinate: centroid,
      wayNodeCount: ring.length,
    });
  }
  for (const node of nodes.values()) {
    records.push({
      objectType: "node",
      osmid: String(node.id),
      name: node.tags.name ?? null,
      tags: node.tags,
      coordinate: node.coordinate,
      wayNodeCount: null,
    });
  }
  return records;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const categories: Array<{ tag: string; prefix: string; file: string }> = [
    { tag: "natural=saddle", prefix: "saddles", file: "saddles.json" },
    { tag: "mountain_pass=yes", prefix: "mountain-passes", file: "mountain-passes.json" },
    { tag: "natural=ridge", prefix: "ridges", file: "ridges.json" },
    { tag: "natural=peak", prefix: "peaks", file: "peaks.json" },
  ];
  const counts: Record<string, Record<string, number>> = {};
  for (const c of categories) {
    const records = await extractCategory(c.tag, c.prefix);
    const byType: Record<string, number> = { node: 0, way: 0, relation: 0 };
    for (const r of records) byType[r.objectType]++;
    counts[c.tag] = byType;
    console.log(`${c.tag.padEnd(24)} node: ${String(byType.node).padStart(7)} way: ${String(byType.way).padStart(7)} total: ${records.length}`);
    await writeFile(`${OUTPUT_DIR}/${c.file}`, JSON.stringify(records, null, 2));
  }
  await writeFile(
    `${OUTPUT_DIR}/high-mountain-summary.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), counts }, null, 2),
  );
  console.log("done");
}

await main();
