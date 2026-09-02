import { runOsmium } from "./osmium-runner.ts";
import { writeFile, mkdir } from "node:fs/promises";

interface FeatureRecord {
  osmid: string;
  name: string | null;
  coordinate: [number, number];
  tags: Record<string, string>;
}

function parseOplLine(line: string): FeatureRecord | null {
  if (!line.startsWith("n")) return null;

  const tIndex = line.indexOf(" T");
  if (tIndex === -1) return null;

  const id = line.slice(1, tIndex);
  const afterT = line.slice(tIndex + 2);
  const xIndex = afterT.indexOf(" x");
  if (xIndex === -1) return null;

  const tagsStr = afterT.slice(0, xIndex);
  const coordStr = afterT.slice(xIndex + 1);

  const coordMatch = coordStr.match(/x([-\d.]+) y([-\d.]+)/);
  if (!coordMatch) return null;
  const lon = parseFloat(coordMatch[1]);
  const lat = parseFloat(coordMatch[2]);

  const tags: Record<string, string> = {};
  const tagPairs = tagsStr.split(",");
  for (const pair of tagPairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex);
      const value = pair.slice(eqIndex + 1);
      try {
        tags[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch {
        tags[key] = value;
      }
    }
  }

  return { osmid: id, name: tags.name ?? null, coordinate: [lon, lat], tags };
}

async function extractWithOsmium(pbfPath: string, filter: string): Promise<FeatureRecord[]> {
  const features: FeatureRecord[] = [];
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
    }
  });
  console.log(`Extracted ${features.length} features with filter: ${filter}`);
  return features;
}

async function main() {
  const PBF_PATH = "data/osm/source/alps-latest.osm.pbf";
  const OUTPUT_DIR = "data/osm/alps/staging/phase11f1-features";

  await mkdir(OUTPUT_DIR, { recursive: true });

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