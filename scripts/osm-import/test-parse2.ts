import { runOsmium } from "./osmium-runner.ts";

function parseOplLine(line: string) {
  if (!line.startsWith("n")) return null;
  
  // Format: n<id> T<tags> x<lon> y<lat>
  // Tags are comma-separated key=value pairs
  const tIndex = line.indexOf(" T");
  if (tIndex === -1) return null;
  
  const idPart = line.slice(1, tIndex);
  const id = idPart;
  
  const afterT = line.slice(tIndex + 2); // Skip " T"
  const xIndex = afterT.indexOf(" x");
  if (xIndex === -1) return null;
  
  const tagsStr = afterT.slice(0, xIndex);
  const coordStr = afterT.slice(xIndex + 1); // " x<lon> y<lat>"
  
  const coordMatch = coordStr.match(/x([-\d.]+) y([-\d.]+)/);
  if (!coordMatch) return null;
  const lon = parseFloat(coordMatch[1]);
  const lat = parseFloat(coordMatch[2]);
  
  const tags: Record<string, string> = {};
  // Tags are comma-separated
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

let count = 0;
let parsed = 0;
await runOsmium([
  'tags-filter',
  '-R',
  '-f', 'opl,add_metadata=false',
  'data/osm/source/alps-latest.osm.pbf',
  'n/tourism=alpine_hut',
], (line) => {
  count++;
  const record = parseOplLine(line);
  if (record) {
    parsed++;
    if (parsed <= 3) console.log("Parsed:", record);
  } else {
    if (count <= 5) console.log("Failed to parse:", line.slice(0, 200));
  }
});
console.log('Total lines:', count, 'Parsed:', parsed);