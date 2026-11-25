import { runOsmium } from "./osmium-runner.ts";

let count = 0;
await runOsmium([
  'tags-filter',
  '-R',
  '-f', 'opl,add_metadata=false',
  'data/osm/source/alps-latest.osm.pbf',
  'n/tourism=wilderness_hut',
], (line) => {
  count++;
  if (count <= 20) console.log(line);
});
console.log('Total:', count);