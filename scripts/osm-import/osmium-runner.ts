import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const OUTPUT_TAIL_CHARACTERS = 16_000;

export interface RunOsmiumOptions {
  executable?: string;
}

interface OsmiumFailureDetails {
  executable: string;
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  startError?: Error;
}

function appendTail(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-OUTPUT_TAIL_CHARACTERS);
}

function formatTail(value: string): string {
  return value.trim() || "(empty)";
}

export class OsmiumExecutionError extends Error {
  readonly executable: string;
  readonly argv: string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;

  constructor(details: OsmiumFailureDetails) {
    const heading = details.startError
      ? "Could not start Osmium command"
      : "Osmium command failed";
    const cause = details.startError
      ? `\nStart error: ${details.startError.message}`
      : "";
    super(
      `${heading}\n` +
        `Executable: ${JSON.stringify(details.executable)}\n` +
        `Argv: ${JSON.stringify(details.argv)}\n` +
        `Exit code: ${String(details.exitCode)}\n` +
        `Signal: ${String(details.signal)}\n` +
        `Stdout tail:\n${formatTail(details.stdoutTail)}\n` +
        `Stderr tail:\n${formatTail(details.stderrTail)}` +
        cause,
      details.startError ? { cause: details.startError } : undefined,
    );
    this.name = "OsmiumExecutionError";
    this.executable = details.executable;
    this.argv = [...details.argv];
    this.exitCode = details.exitCode;
    this.signal = details.signal;
    this.stdoutTail = details.stdoutTail;
    this.stderrTail = details.stderrTail;
  }
}

export async function assertOsmiumAvailable(): Promise<string> {
  let output = "";
  await runOsmium(["--version"], (line) => {
    output += `${line}\n`;
  });
  return output.trim().split(/\r?\n/)[0] ?? "osmium";
}

export async function runOsmium(
  arguments_: string[],
  onLine?: (line: string) => void | Promise<void>,
  options: RunOsmiumOptions = {},
): Promise<void> {
  const executable = options.executable ?? "osmium";
  const argv = [...arguments_];
  const child = spawn(executable, argv, {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdoutTail = "";
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = appendTail(stderrTail, chunk);
  });
  const completion = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      rejectPromise(
        new OsmiumExecutionError({
          executable,
          argv,
          exitCode: null,
          signal: null,
          stdoutTail,
          stderrTail,
          startError: error,
        }),
      );
    });
    child.once("close", (exitCode, signal) => {
      resolvePromise({ exitCode, signal });
    });
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      stdoutTail = appendTail(stdoutTail, `${line}\n`);
      await onLine?.(line);
    }
  } catch (error) {
    child.kill();
    await completion.catch(() => null);
    throw error;
  }

  const result = await completion;
  if (result.exitCode !== 0) {
    throw new OsmiumExecutionError({
      executable,
      argv,
      exitCode: result.exitCode,
      signal: result.signal,
      stdoutTail,
      stderrTail,
    });
  }
}

function completedWithMissingReferences(error: OsmiumExecutionError): boolean {
  return (
    error.exitCode === 1 &&
    error.signal === null &&
    /Did not find [1-9][0-9]* object\(s\)\./.test(error.stderrTail) &&
    /Done\.\s*$/.test(error.stderrTail)
  );
}

export async function runOsmiumGetId(
  arguments_: string[],
  options: RunOsmiumOptions = {},
): Promise<void> {
  try {
    await runOsmium(arguments_, undefined, options);
  } catch (error) {
    if (
      error instanceof OsmiumExecutionError &&
      completedWithMissingReferences(error)
    ) {
      console.warn(error.message);
      return;
    }
    throw error;
  }
}

export async function validateOsmiumFile(path: string): Promise<boolean> {
  try {
    await runOsmium(["fileinfo", path]);
    return true;
  } catch (error) {
    if (
      error instanceof OsmiumExecutionError &&
      error.exitCode !== null &&
      error.signal === null
    ) {
      return false;
    }
    throw error;
  }
}
