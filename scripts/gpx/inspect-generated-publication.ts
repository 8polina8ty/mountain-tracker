import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { inspectDeployment } from './generated-publication-live.ts';
import { stableJson } from '../../Lib/gpxIngestion/hashing.ts';

if (process.argv.length !== 2) throw new Error('READ_ONLY_INSPECTION_ACCEPTS_NO_FLAGS');
const corpus = JSON.parse(await readFile('data/gpx/adaptive-start-pilot/adaptive-start-pilot-corpus.json', 'utf8'));
const snapshot = await inspectDeployment(corpus.mountains.map((m: { summit: { osmId: number } }) => m.summit.osmId));
const out = 'data/gpx/generated-route-publication';
await mkdir(out, { recursive: true });
await writeFile(`${out}/deployment-read-only.json`, stableJson(snapshot) + '\n');
console.log(JSON.stringify({ mountains: snapshot.mountains.length, existingRoutes: snapshot.routes.length, bucket: snapshot.bucket,
  generatedTableAvailable: snapshot.generatedTableAvailable, generatedRpcAvailable: snapshot.generatedRpcAvailable,
  DB_WRITES: 0, STORAGE_WRITES: 0, PUBLICATION_WRITES: 0 }));
