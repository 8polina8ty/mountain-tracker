import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  OsmiumExecutionError,
  runOsmium,
  runOsmiumGetId,
} from "./osmium-runner.ts";

test("runner preserves Windows paths with spaces as individual argv values", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osmium runner test "));
  try {
    const scriptPath = resolve(directory, "echo argv.mjs");
    const windowsInput =
      "E:\\Projekt mounts\\mountain-tracker\\data\\osm\\source\\alps-latest.osm.pbf";
    const windowsOutput =
      "E:\\Projekt mounts\\mountain-tracker\\data\\osm\\alps\\selected-routes.osm.pbf";
    await writeFile(
      scriptPath,
      "process.stdout.write(`${JSON.stringify(process.argv.slice(2))}\\n`);\n",
      "utf8",
    );
    let output = "";

    await runOsmium(
      [scriptPath, "getid", "-i", windowsInput, "-o", windowsOutput],
      (line) => {
        output += line;
      },
      { executable: process.execPath },
    );

    assert.deepEqual(JSON.parse(output), [
      "getid",
      "-i",
      windowsInput,
      "-o",
      windowsOutput,
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runner preserves stdout and Osmium stderr tails on non-zero exit", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osmium-runner-error-"));
  try {
    const scriptPath = resolve(directory, "fail.mjs");
    await writeFile(
      scriptPath,
      'process.stdout.write("stdout marker\\n");\n' +
        'process.stderr.write(`${"x".repeat(20_000)}stderr marker\\n`);\n' +
        "process.exitCode = 7;\n",
      "utf8",
    );
    const argv = [scriptPath, "getid", "path with spaces"];

    await assert.rejects(
      runOsmium(argv, undefined, { executable: process.execPath }),
      (error: unknown) => {
        assert.ok(error instanceof OsmiumExecutionError);
        assert.equal(error.executable, process.execPath);
        assert.deepEqual(error.argv, argv);
        assert.equal(error.exitCode, 7);
        assert.equal(error.signal, null);
        assert.match(error.stdoutTail, /stdout marker/);
        assert.match(error.stderrTail, /stderr marker/);
        assert.match(error.message, /Executable:/);
        assert.match(error.message, /Argv:/);
        assert.match(error.message, /Exit code: 7/);
        assert.match(error.message, /Signal: null/);
        assert.match(error.message, /Stdout tail:/);
        assert.match(error.message, /Stderr tail:/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("getid accepts only its documented missing-reference completion", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osmium-getid-missing-"));
  const originalWarn = console.warn;
  try {
    const scriptPath = resolve(directory, "missing references.mjs");
    await writeFile(
      scriptPath,
      'process.stderr.write("Did not find 12 object(s).\\nDone.\\n");\n' +
        "process.exitCode = 1;\n",
      "utf8",
    );
    let warning = "";
    console.warn = (message?: unknown) => {
      warning += String(message);
    };

    await runOsmiumGetId([scriptPath], { executable: process.execPath });

    assert.match(warning, /Exit code: 1/);
    assert.match(warning, /Did not find 12 object\(s\)/);
  } finally {
    console.warn = originalWarn;
    await rm(directory, { recursive: true, force: true });
  }
});

test("getid keeps unrelated exit-one failures fatal", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "osmium-getid-fatal-"));
  try {
    const scriptPath = resolve(directory, "processing error.mjs");
    await writeFile(
      scriptPath,
      'process.stderr.write("I/O processing failure\\n");\n' +
        "process.exitCode = 1;\n",
      "utf8",
    );

    await assert.rejects(
      runOsmiumGetId([scriptPath], { executable: process.execPath }),
      (error: unknown) =>
        error instanceof OsmiumExecutionError && error.exitCode === 1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
