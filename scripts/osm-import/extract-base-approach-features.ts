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

  console.log("Building base approach feature index using osmium tags-filter...");

  // Trailheads - designated trailhead points
  const trailheads = await extractWithOsmium(PBF_PATH, 'n/highway=trailhead');
  await writeFile(`${OUTPUT_DIR}/trailheads.json`, JSON.stringify(trailheads, null, 2));

  // Information points at trailheads (guideposts, maps, boards)
  const infoPoints = await extractWithOsmium(PBF_PATH, 'n/tourism=information');
  const trailheadInfo = infoPoints.filter(f =>
    f.tags.information === "guidepost" ||
    f.tags.information === "map" ||
    f.tags.information === "board"
  );
  await writeFile(`${OUTPUT_DIR}/trailhead-info.json`, JSON.stringify(trailheadInfo, null, 2));

  // Parking areas (could be trailhead parking)
  const parking = await extractWithOsmium(PBF_PATH, 'n/amenity=parking');
  await writeFile(`${OUTPUT_DIR}/parking.json`, JSON.stringify(parking, null, 2));

  // Valley settlements
  const villages = await extractWithOsmium(PBF_PATH, 'n/place=village');
  await writeFile(`${OUTPUT_DIR}/villages.json`, JSON.stringify(villages, null, 2));

  const hamlets = await extractWithOsmium(PBF_PATH, 'n/place=hamlet');
  await writeFile(`${OUTPUT_DIR}/hamlets.json`, JSON.stringify(hamlets, null, 2));

  const isolatedDwellings = await extractWithOsmium(PBF_PATH, 'n/place=isolated_dwelling');
  await writeFile(`${OUTPUT_DIR}/isolated-dwellings.json`, JSON.stringify(isolatedDwellings, null, 2));

  const farms = await extractWithOsmium(PBF_PATH, 'n/place=farm');
  await writeFile(`${OUTPUT_DIR}/farms.json`, JSON.stringify(farms, null, 2));

  // Public transport access
  const busStops = await extractWithOsmium(PBF_PATH, 'n/highway=bus_stop');
  await writeFile(`${OUTPUT_DIR}/bus-stops.json`, JSON.stringify(busStops, null, 2));

  const trainStations = await extractWithOsmium(PBF_PATH, 'n/railway=station');
  await writeFile(`${OUTPUT_DIR}/train-stations.json`, JSON.stringify(trainStations, null, 2));

  const halts = await extractWithOsmium(PBF_PATH, 'n/railway=halt');
  await writeFile(`${OUTPUT_DIR}/halts.json`, JSON.stringify(halts, null, 2));

  console.log("\nBase Approach Feature Index Summary:");
  console.log(`  Trailheads: ${trailheads.length}`);
  console.log(`  Trailhead info points: ${trailheadInfo.length}`);
  console.log(`  Parking areas: ${parking.length}`);
  console.log(`  Villages: ${villages.length}`);
  console.log(`  Hamlets: ${hamlets.length}`);
  console.log(`  Isolated dwellings: ${isolatedDwellings.length}`);
  console.log(`  Farms: ${farms.length}`);
  console.log(`  Bus stops: ${busStops.length}`);
  console.log(`  Train stations: ${trainStations.length}`);
  console.log(`  Halts: ${halts.length}`);

  console.log(`\nFeature files written to ${OUTPUT_DIR}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});