import { runOsmium } from "./osmium-runner.ts";
import { writeFile } from "node:fs/promises";

interface FeatureRecord {
  osmid: string;
  name: string | null;
  coordinate: [number, number];
  tags: Record<string, string>;
}

interface FeatureIndex {
  alpineHuts: Map<string, FeatureRecord>;
  wildernessHuts: Map<string, FeatureRecord>;
  mountainPasses: Map<string, FeatureRecord>;
  saddles: Map<string, FeatureRecord>;
  ridges: Map<string, FeatureRecord>;
  peaks: Map<string, FeatureRecord>;
}

function parseOplLine(line: string): FeatureRecord | null {
  if (!line.startsWith("n")) return null;
  const parts = line.split(" ");
  if (parts.length < 3) return null;
  const id = parts[0].slice(1);
  const coordPart = parts[1];
  const match = coordPart.match(/x([-\d.]+) y([-\d.]+)/);
  if (!match) return null;
  const lon = parseFloat(match[1]);
  const lat = parseFloat(match[2]);
  const tags: Record<string, string> = {};
  for (let i = 2; i < parts.length; i++) {
    const eqIndex = parts[i].indexOf("=");
    if (eqIndex > 0) {
      const key = decodeURIComponent(parts[i].slice(0, eqIndex));
      const value = decodeURIComponent(parts[i].slice(eqIndex + 1));
      tags[key] = value;
    }
  }
  return { osmid: id, name: tags.name ?? null, coordinate: [lon, lat], tags };
}

async function extractWithOsmium(pbfPath: string, filters: string[]): Promise<Map<string, FeatureRecord>> {
  const features = new Map<string, FeatureRecord>();
  let count = 0;
  await runOsmium([
    'tags-filter',
    '-R',
    '-f', 'opl,add_metadata=false',
    pbfPath,
    ...filters,
  ], (line) => {
    const record = parseOplLine(line);
    if (record) {
      features.set(record.osmid, record);
      count++;
    }
  });
  console.log(`Extracted ${count} features with filters: ${filters.join(", ")}`);
  return features;
}

async function main() {
  const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
  const OUTPUT_PATH = "data/osm/alps/staging/phase11f1-feature-index.json";

  console.log("Building feature index using osmium tags-filter...");

  const index: FeatureIndex = {
    alpineHuts: await extractWithOsmium(PBF_PATH, ['n/tourism=alpine_hut']),
    wildernessHuts: await extractWithOsmium(PBF_PATH, ['n/tourism=wilderness_hut']),
    mountainPasses: await extractWithOsmium(PBF_PATH, ['n/mountain_pass=yes']),
    saddles: await extractWithOsmium(PBF_PATH, ['n/natural=saddle']),
    ridges: await extractWithOsmium(PBF_PATH, ['n/natural=ridge']),
    peaks: await extractWithOsmium(PBF_PATH, ['n/natural=peak']),
  };

  console.log("\nFeature Index Summary:");
  console.log(`  Alpine huts: ${index.alpineHuts.size}`);
  console.log(`  Wilderness huts: ${index.wildernessHuts.size}`);
  console.log(`  Mountain passes: ${index.mountainPasses.size}`);
  console.log(`  Saddles: ${index.saddles.size}`);
  console.log(`  Ridges: ${index.ridges.size}`);
  console.log(`  Peaks: ${index.peaks.size}`);

  const serializable = {
    alpineHuts: [...index.alpineHuts.values()],
    wildernessHuts: [...index.wildernessHuts.values()],
    mountainPasses: [...index.mountainPasses.values()],
    saddles: [...index.saddles.values()],
    ridges: [...index.ridges.values()],
    peaks: [...index.peaks.values()],
  };

  await writeFile(OUTPUT_PATH, JSON.stringify(serializable, null, 2));
  console.log(`\nFeature index written to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});