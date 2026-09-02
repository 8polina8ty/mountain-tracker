import { writeFile, mkdir } from "node:fs/promises";
import { runOsmium } from "./osmium-runner.ts";
import { parseOplLine } from "./opl-parser.ts";

const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";

export interface EleNode {
  osmid: string;
  coordinate: [number, number];
  ele: number;
  name: string | null;
}

async function main() {
  await mkdir("data/osm/alps/staging/phase11f2-features", { recursive: true });
  const records: EleNode[] = [];
  await runOsmium(
    ["tags-filter", "-f", "opl,add_metadata=false", PBF_PATH, "n/ele"],
    (line) => {
      if (!line.startsWith("n")) return;
      const obj = parseOplLine(line);
      if (obj.type !== "node" || !obj.coordinate) return;
      const ele = obj.tags.ele ? Number.parseFloat(obj.tags.ele) : NaN;
      if (!Number.isFinite(ele)) return;
      records.push({
        osmid: String(obj.id),
        coordinate: obj.coordinate,
        ele,
        name: obj.tags.name ?? null,
      });
    },
  );
  await writeFile(
    "data/osm/alps/staging/phase11f2-features/ele-nodes.json",
    JSON.stringify(records, null, 2),
  );
  console.log("ele nodes extracted:", records.length);
}

await main();
