import { readFile } from 'node:fs/promises';
import { buildOsmTrailGraph, ADMITTED_CONNECTOR_HIGHWAYS, type OsmTrailWayInput } from '../../../Lib/gpxIngestion/osmTrailGraph.ts';
import { BaseAccessNetwork, primaryBaseAccess } from '../../../Lib/gpxIngestion/baseAccessStartPolicy.ts';

const PBF_SHA = '15ff62ed82c01b2153ec22d1b4cd53d1e94b87ecf38ab176eee60360972a6fc5';
const block = '43_189';
const ways = JSON.parse(await readFile(`data/routes/tmp-blocks/block_${block}.json`, 'utf8')) as OsmTrailWayInput[];
const evidenceFile = JSON.parse(await readFile('identity-repair/provenance-integrity/real-evidence/2.json', 'utf8'));
const candidate = evidenceFile.startCandidate;
const dataset = { datasetKey: 'local-osm-pbf', region: 'local', snapshotTimestamp: new Date(1787606468000).toISOString(), pbfSha256: PBF_SHA };

function test(connectorHighways: string[]) {
  const graph = buildOsmTrailGraph(dataset, ways, { connectorHighways, maximumWays: 500000, maximumNodes: 2000000 });
  const network = new BaseAccessNetwork(ways);
  const ev = network.evaluate({ kind: candidate.kind, tags: candidate.tags ?? {}, nodeId: candidate.osmId, graph });
  console.log(`connectors ${connectorHighways.length}: publicRoadConnected=${ev.publicRoadConnected} reason=${ev.reasonCodes.join(',')} distance=${ev.accessNetworkDistance} approachNodes=${ev.approachNodeIds.length} outwardNodes=${ev.outwardRoadNodeIds.length} primary=${primaryBaseAccess(ev)}`);
  console.log(`graph nodes ${graph.nodes.size} edges ${graph.edges.length} exclusions sample`, graph.exclusions.slice(0,3));
}

console.log('candidate', candidate);
test([]);
test([...ADMITTED_CONNECTOR_HIGHWAYS]);
