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
const nextConfigSource = await readFile(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);
const v2ImageSources = await Promise.all([
  readFile(new URL("../components/ui-v2.tsx", import.meta.url), "utf8"),
  readFile(new URL("../components/explore/ExploreClient.tsx", import.meta.url), "utf8"),
]);

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

const staticV2ImageUrls = v2ImageSources.flatMap((componentSource) =>
  [...componentSource.matchAll(/\b(?:image|src)="(https:\/\/[^\"]+)"/g)].map(
    (match) => new URL(match[1]),
  ),
);
const configuredStaticImagePatterns = [
  ...nextConfigSource.matchAll(
    /\{\s*protocol:\s*"([^"]+)",\s*hostname:\s*"([^"]+)",\s*pathname:\s*"([^"]+)",?\s*\}/g,
  ),
].map((match) => ({ protocol: match[1], hostname: match[2], pathname: match[3] }));

for (const imageUrl of staticV2ImageUrls) {
  const matched = configuredStaticImagePatterns.some((pattern) => {
    const pathPrefix = pattern.pathname.endsWith("/**")
      ? pattern.pathname.slice(0, -3)
      : pattern.pathname;
    return imageUrl.protocol === `${pattern.protocol}:`
      && imageUrl.hostname === pattern.hostname
      && (pattern.pathname.endsWith("/**")
        ? imageUrl.pathname.startsWith(`${pathPrefix}/`)
        : imageUrl.pathname === pathPrefix);
  });
  assert.ok(
    matched,
    `Static V2 next/image URL is not covered by images.remotePatterns: ${imageUrl.href}`,
  );
}

console.log("Runtime and dependency baseline contracts passed.");
