import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";

const devLockPath = ".next/dev/lock";
const generatedTypePaths = [".next/dev/types", ".next/types"];

assert.equal(
  existsSync(devLockPath),
  false,
  [
    "Release gate cannot run while Next.js dev/Turbopack is active.",
    "Stop `npm run dev` first, then rerun `npm run test:release`.",
    `Detected dev lock: ${devLockPath}`,
  ].join(" "),
);

for (const generatedTypePath of generatedTypePaths) {
  try {
    rmSync(generatedTypePath, { recursive: true, force: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Release gate could not clean generated Next.js types at ${generatedTypePath}. ` +
        "Ensure no Next.js dev process is using the repository, then rerun. " +
        detail,
    );
  }
}

console.log("Release environment preflight passed.");
