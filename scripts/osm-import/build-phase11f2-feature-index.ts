import { readFile, mkdir, writeFile } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine, type OplWay, type OplNode } from "./opl-parser.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const OUTPUT_DIR = "data/osm/alps/staging/phase11f2-features";
const WORK_DIR = "data/osm/alps/staging/phase11f2-work";

export interface FeatureRecord {
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

async function extractFeatureCategory(
  tag: string,
  prefix: string,
): Promise<FeatureRecord[]> {
  await mkdir(WORK_DIR, { recursive: true });
  const rawPbf = `${WORK_DIR}/${prefix}.pbf`;
  const locatedPbf = `${WORK_DIR}/${prefix}-located.pbf`;

  await runOsmium([
    "tags-filter",
    "--overwrite",
    "-o",
    rawPbf,
    PBF_PATH,
    `n/${tag}`,
    `w/${tag}`,
    `r/${tag}`,
  ]);
  await runOsmium([
    "add-locations-to-ways",
    "--overwrite",
    "-f",
    "pbf,locations_on_ways=true,add_metadata=false",
    "-o",
    locatedPbf,
    rawPbf,
  ]);

  const nodes = new Map<number, OplNode>();
  const ways: OplWay[] = [];
  await runOsmium(
    ["cat", "-f", "opl,add_metadata=false,locations_on_ways=true", locatedPbf],
    (line) => {
      const obj = parseOplLine(line);
      if (obj.type === "node" && obj.coordinate) nodes.set(obj.id, obj);
      else if (obj.type === "way") ways.push(obj);
    },
  );

  const records: FeatureRecord[] = [];
  for (const way of ways) {
    const ring: [number, number][] = [];
    let ok = true;
    for (const n of way.nodes) {
      if (n.coordinate) ring.push(n.coordinate);
      else {
        const resolved = nodes.get(n.nodeId);
        if (resolved?.coordinate) ring.push(resolved.coordinate);
        else {
          ok = false;
          break;
        }
      }
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
    { tag: "tourism=alpine_hut", prefix: "alpine-huts", file: "alpine-huts.json" },
    { tag: "tourism=wilderness_hut", prefix: "wilderness-huts", file: "wilderness-huts.json" },
    { tag: "amenity=parking", prefix: "parking", file: "parking.json" },
    { tag: "railway=station", prefix: "stations", file: "stations.json" },
    { tag: "railway=halt", prefix: "halts", file: "halts.json" },
    { tag: "public_transport=station", prefix: "pt-stations", file: "pt-stations.json" },
    { tag: "highway=bus_stop", prefix: "bus-stops", file: "bus-stops.json" },
    { tag: "highway=trailhead", prefix: "trailheads", file: "trailheads.json" },
    { tag: "place=village", prefix: "villages", file: "villages.json" },
    { tag: "place=hamlet", prefix: "hamlets", file: "hamlets.json" },
    { tag: "place=isolated_dwelling", prefix: "isolated-dwellings", file: "isolated-dwellings.json" },
    { tag: "place=farm", prefix: "farms", file: "farms.json" },
    { tag: "information=guidepost", prefix: "trailhead-info", file: "trailhead-info.json" },
  ];

  const summary: Record<string, Record<string, number>> = {};
  for (const category of categories) {
    const records = await extractFeatureCategory(
      category.tag,
      category.prefix,
    );
    const byType: Record<string, number> = { node: 0, way: 0, relation: 0 };
    for (const r of records) byType[r.objectType]++;
    summary[category.tag] = byType;
    console.log(
      `${category.tag.padEnd(28)} node: ${String(byType.node).padStart(7)} way: ${String(byType.way).padStart(7)} total: ${records.length}`,
    );
    await writeFile(
      `${OUTPUT_DIR}/${category.file}`,
      JSON.stringify(records, null, 2),
    );
  }

  await writeFile(
    `${OUTPUT_DIR}/summary.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), counts: summary }, null, 2),
  );
  console.log(`\nFeatures written to ${OUTPUT_DIR}/`);
}

await main();
