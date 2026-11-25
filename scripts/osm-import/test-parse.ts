import { runOsmium } from "./osmium-runner.ts";

function parseOplLine(line: string) {
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

let count = 0;
await runOsmium([
  'tags-filter',
  '-R',
  '-f', 'opl,add_metadata=false',
  'data/osm/source/alps-latest.osm.pbf',
  'n/tourism=alpine_hut',
], (line) => {
  const record = parseOplLine(line);
  if (record) {
    count++;
    if (count <= 3) console.log("Parsed:", record);
  } else {
    if (count === 0) console.log("Failed to parse:", line.slice(0, 100));
  }
});
console.log('Total parsed:', count);