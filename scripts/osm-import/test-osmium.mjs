import { assertOsmiumAvailable } from "./osmium-runner.ts";

await assertOsmiumAvailable();
console.log('osmium available');