import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageLock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const nvmrc = (
  await readFile(new URL("../.nvmrc", import.meta.url), "utf8")
).trim();

const nodeMajor = Number(process.versions.node.split(".")[0]);
const lockRoot = packageLock.packages?.[""];

assert.equal(nvmrc, "24", ".nvmrc must keep Node 24 as the runtime baseline");
assert.equal(nodeMajor, 24, `Runtime validation requires Node 24, received ${process.versions.node}`);
assert.equal(packageJson.private, true, "The application package must remain private");
assert.equal(packageLock.lockfileVersion, 3, "package-lock.json must remain lockfileVersion 3");
assert.ok(lockRoot, "package-lock.json root package metadata is missing");
assert.deepEqual(
  lockRoot.dependencies ?? {},
  packageJson.dependencies ?? {},
  "package.json runtime dependencies and package-lock.json are out of sync",
);
assert.deepEqual(
  lockRoot.devDependencies ?? {},
  packageJson.devDependencies ?? {},
  "package.json devDependencies and package-lock.json are out of sync",
);
assert.equal(
  packageJson.dependencies?.["mapbox-gl"],
  undefined,
  "Legacy mapbox-gl dependency must not be reintroduced",
);
assert.equal(
  packageLock.packages?.["node_modules/mapbox-gl"],
  undefined,
  "Legacy mapbox-gl package must not remain in package-lock.json",
);
assert.equal(
  typeof packageJson.dependencies?.["maplibre-gl"],
  "string",
  "MapLibre must remain the active map dependency",
);

console.log("Runtime and dependency baseline contracts passed.");
