import { writeFile, mkdir } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine } from "./opl-parser.ts";
import { normalizeEle } from "./ele-normalizer.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
const OUT_DIR = "data/osm/alps/staging/phase11f3-features";

export interface Phase11f3EleNode {
  osmid: string;
  coordinate: [number, number];
  rawEle: string;
  parseStatus: string;
  normalizedMeters: number | null;
  feet: number | null;
  name: string | null;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const records: Phase11f3EleNode[] = [];
  await runOsmium(
    ["tags-filter", "-f", "opl,add_metadata=false", PBF_PATH, "n/ele"],
    (line) => {
      if (!line.startsWith("n")) return;
      const obj = parseOplLine(line);
      if (obj.type !== "node" || !obj.coordinate) return;
      const raw = obj.tags.ele ?? "";
      if (raw.trim() === "") return;
      const parsed = normalizeEle(raw);
      records.push({
        osmid: String(obj.id),
        coordinate: obj.coordinate,
        rawEle: raw,
        parseStatus: parsed.status,
        normalizedMeters: parsed.normalizedMeters,
        feet: parsed.feet,
        name: obj.tags.name ?? null,
      });
    },
  );
  await writeFile(
    `${OUT_DIR}/ele-nodes-raw.json`,
    JSON.stringify(records, null, 2),
  );
  const byStatus: Record<string, number> = {};
  for (const r of records) byStatus[r.parseStatus] = (byStatus[r.parseStatus] ?? 0) + 1;
  console.log("ele nodes extracted (raw):", records.length);
  console.log("parse status distribution:", JSON.stringify(byStatus));
}

await main();
