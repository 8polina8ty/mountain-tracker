import { runOsmium } from "./osmium-runner.ts";
import { writeFile } from "node:fs/promises";

interface FeatureRecord {
  osmid: string;
  name: string | null;
  coordinate: [number, number];
  tags: Record<string, string>;
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

async function extractWithOsmium(pbfPath: string, filter: string): Promise<FeatureRecord[]> {
  const features: FeatureRecord[] = [];
  let count = 0;
  await runOsmium([
    'tags-filter',
    '-R',
    '-f', 'opl,add_metadata=false',
    pbfPath,
    filter,
  ], (line) => {
    const record = parseOplLine(line);
    if (record) {
      features.push(record);
      count++;
    }
  });
  console.log(`Extracted ${count} features with filter: ${filter}`);
  return features;
}

async function main() {
  const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
  const OUTPUT_DIR = "data/osm/alps/staging/phase11f1-features";

  console.log("Building feature index using osmium tags-filter...");

  const alpineHuts = await extractWithOsmium(PBF_PATH, 'n/tourism=alpine_hut');
  await writeFile(`${OUTPUT_DIR}/alpine-huts.json`, JSON.stringify(alpineHuts, null, 2));

  const wildernessHuts = await extractWithOsmium(PBF_PATH, 'n/tourism=wilderness_hut');
  await writeFile(`${OUTPUT_DIR}/wilderness-huts.json`, JSON.stringify(wildernessHuts, null, 2));

  const mountainPasses = await extractWithOsmium(PBF_PATH, 'n/mountain_pass=yes');
  await writeFile(`${OUTPUT_DIR}/mountain-passes.json`, JSON.stringify(mountainPasses, null, 2));

  const saddles = await extractWithOsmium(PBF_PATH, 'n/natural=saddle');
  await writeFile(`${OUTPUT_DIR}/saddles.json`, JSON.stringify(saddles, null, 2));

  const ridges = await extractWithOsmium(PBF_PATH, 'n/natural=ridge');
  await writeFile(`${OUTPUT_DIR}/ridges.json`, JSON.stringify(ridges, null, 2));

  const peaks = await extractWithOsmium(PBF_PATH, 'n/natural=peak');
  await writeFile(`${OUTPUT_DIR}/peaks.json`, JSON.stringify(peaks, null, 2));

  console.log("\nFeature Index Summary:");
  console.log(`  Alpine huts: ${alpineHuts.length}`);
  console.log(`  Wilderness huts: ${wildernessHuts.length}`);
  console.log(`  Mountain passes: ${mountainPasses.length}`);
  console.log(`  Saddles: ${saddles.length}`);
  console.log(`  Ridges: ${ridges.length}`);
  console.log(`  Peaks: ${peaks.length}`);

  console.log(`\nFeature files written to ${OUTPUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});