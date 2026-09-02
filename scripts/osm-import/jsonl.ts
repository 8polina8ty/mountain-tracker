import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export async function writeJsonLines(
  path: string,
  values: Iterable<unknown>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  const handle = await open(temporaryPath, "w");
  try {
    for (const value of values) {
      await handle.write(serializeJsonLine(value));
    }
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serializeJsonLine(value), "utf8");
}

export async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function* iterateJsonLines<T>(path: string): AsyncGenerator<T> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line) {
      yield JSON.parse(line) as T;
    }
  }
}

export async function combineJsonlChunks(
  chunkPaths: string[],
  destinationPath: string,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.tmp`;
  await rm(temporaryPath, { force: true });
  for (const chunkPath of chunkPaths) {
    await appendFile(temporaryPath, await readFile(chunkPath));
  }
  await rename(temporaryPath, destinationPath);
}
