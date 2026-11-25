import { runOsmium } from "./osmium-runner.ts";

async function testFilter(filter: string) {
  let count = 0;
  await runOsmium([
    'tags-filter',
    '-R',
    '-f', 'opl,add_metadata=false',
    'data/osm/source/alps-latest.osm.pbf',
    filter,
  ], (line) => {
    count++;
  });
  console.log(`${filter}: ${count}`);
}

await testFilter('n/tourism=alpine_hut');
await testFilter('n/tourism=wilderness_hut');
await testFilter('n/mountain_pass=yes');
await testFilter('n/natural=saddle');