import { readFile, mkdir } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const OUTPUT_PATH = "data/osm/alps/staging/phase11f2-extraction-audit.json";

interface TypeCounts {
  node: number;
  way: number;
  relation: number;
}

const TAGS: Array<[string, string]> = [
  ["tourism=alpine_hut", "HUT"],
  ["tourism=wilderness_hut", "HUT"],
  ["amenity=parking", "BASE"],
  ["railway=station", "BASE"],
  ["public_transport=station", "BASE"],
  ["highway=bus_stop", "BASE"],
  ["highway=trailhead", "BASE"],
  ["tourism=information", "BASE"],
  ["natural=saddle", "HIGH"],
  ["mountain_pass=yes", "HIGH"],
  ["natural=peak", "HIGH"],
  ["natural=ridge", "HIGH"],
];

async function countObjects(
  filter: string,
  objectType: "n" | "w" | "r",
): Promise<number> {
  let count = 0;
  await runOsmium(
    [
      "tags-filter",
      "-R",
      "-f",
      "opl,add_metadata=false",
      PBF_PATH,
      `${objectType}/${filter}`,
    ],
    () => {
      count++;
    },
  );
  return count;
}

async function main() {
  await mkdir("data/osm/alps/staging", { recursive: true });
  const results: Record<string, TypeCounts> = {};
  for (const [tag] of TAGS) {
    const [node, way, relation] = await Promise.all([
      countObjects(tag, "n"),
      countObjects(tag, "w"),
      countObjects(tag, "r"),
    ]);
    results[tag] = { node, way, relation };
    console.log(
      `${tag.padEnd(28)} node: ${String(node).padStart(7)} way: ${String(way).padStart(7)} rel: ${String(relation).padStart(5)}`,
    );
  }
  const artifact = {
    schemaVersion: 1,
    artifactType: "PHASE11F2_EXTRACTION_AUDIT",
    pbfPath: PBF_PATH,
    generatedAt: new Date().toISOString(),
    counts: results,
    note: "Node-only extraction (Phase 11F.1) only captured the node counts; ways/areas and relations were ignored for huts, parking, transit, settlements, and trailheads.",
  };
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(OUTPUT_PATH, JSON.stringify(artifact, null, 2)),
  );
  console.log(`\nAudit written to ${OUTPUT_PATH}`);
}

await main();
