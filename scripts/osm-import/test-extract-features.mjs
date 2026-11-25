import { runOsmium } from "./osmium-runner.ts";

let count = 0;
await runOsmium([
  'tags-filter',
  '-R',
  '-f', 'opl,add_metadata=false',
  'data/osm/source/alps-latest.osm.pbf',
  'n/tourism=alpine_hut',
  'n/tourism=wilderness_hut',
  'n/natural=saddle',
  'n/mountain_pass=yes',
  'n/natural=ridge',
], (line) => {
  count++;
  if (count <= 10) console.log(line);
});
console.log('Total:', count);