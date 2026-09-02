import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { writeJsonAtomically } from "./jsonl.ts";

export interface InputFingerprint {
  absolutePath: string;
  sizeBytes: number;
  modifiedMilliseconds: number;
}

export interface BulkCheckpointManifest {
  version: 1;
  input: InputFingerprint;
  options: {
    limitRoutes: number | null;
    includeFootCount: boolean;
  };
  completedStages: string[];
  updatedAt: string;
}

export type CheckpointArtifactResult = "reused" | "recovered" | "generated";

interface EnsureArtifactOptions {
  stage: string;
  artifactPath: string;
  sourcePath: string;
  validate: (artifactPath: string) => Promise<boolean>;
  generate: () => Promise<void>;
}

export async function fingerprintInput(
  absolutePath: string,
): Promise<InputFingerprint> {
  const details = await stat(absolutePath);
  return {
    absolutePath,
    sizeBytes: details.size,
    modifiedMilliseconds: details.mtimeMs,
  };
}

function sameManifestIdentity(
  left: BulkCheckpointManifest,
  right: BulkCheckpointManifest,
): boolean {
  return (
    left.version === right.version &&
    left.input.absolutePath === right.input.absolutePath &&
    left.input.sizeBytes === right.input.sizeBytes &&
    left.input.modifiedMilliseconds === right.input.modifiedMilliseconds &&
    left.options.limitRoutes === right.options.limitRoutes &&
    left.options.includeFootCount === right.options.includeFootCount
  );
}

export class BulkCheckpoint {
  readonly path: string;
  manifest: BulkCheckpointManifest;
  private readonly loadedWithMatchingIdentity: boolean;

  private constructor(
    path: string,
    manifest: BulkCheckpointManifest,
    loadedWithMatchingIdentity: boolean,
  ) {
    this.path = path;
    this.manifest = manifest;
    this.loadedWithMatchingIdentity = loadedWithMatchingIdentity;
  }

  static async open(
    path: string,
    expected: Omit<BulkCheckpointManifest, "completedStages" | "updatedAt">,
  ): Promise<BulkCheckpoint> {
    const fresh: BulkCheckpointManifest = {
      ...expected,
      completedStages: [],
      updatedAt: new Date(0).toISOString(),
    };
    try {
      const existing = JSON.parse(
        await readFile(path, "utf8"),
      ) as BulkCheckpointManifest;
      if (sameManifestIdentity(existing, fresh)) {
        return new BulkCheckpoint(path, existing, true);
      }
    } catch {
      // A missing or invalid checkpoint is safely replaced by a fresh manifest.
    }
    const checkpoint = new BulkCheckpoint(path, fresh, false);
    await checkpoint.save();
    return checkpoint;
  }

  isComplete(stage: string): boolean {
    return this.manifest.completedStages.includes(stage);
  }

  async complete(stage: string): Promise<void> {
    if (!this.isComplete(stage)) {
      this.manifest.completedStages.push(stage);
      this.manifest.completedStages.sort();
    }
    await this.save();
  }

  async ensureArtifact(
    options: EnsureArtifactOptions,
  ): Promise<CheckpointArtifactResult> {
    const artifactIsValid = await this.validateNonEmptyArtifact(options);
    if (this.isComplete(options.stage) && artifactIsValid) {
      return "reused";
    }
    if (
      !this.isComplete(options.stage) &&
      this.loadedWithMatchingIdentity &&
      artifactIsValid
    ) {
      await this.complete(options.stage);
      return "recovered";
    }

    await this.removeGeneratedArtifact(options.artifactPath, options.sourcePath);
    await options.generate();
    if (!(await this.validateNonEmptyArtifact(options))) {
      await this.removeGeneratedArtifact(
        options.artifactPath,
        options.sourcePath,
      );
      throw new Error(
        `Generated checkpoint artifact failed validation: ${options.artifactPath}`,
      );
    }
    await this.complete(options.stage);
    return "generated";
  }

  private async validateNonEmptyArtifact(
    options: EnsureArtifactOptions,
  ): Promise<boolean> {
    try {
      const details = await stat(options.artifactPath);
      return details.isFile() && details.size > 0
        ? await options.validate(options.artifactPath)
        : false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return false;
      }
      throw error;
    }
  }

  private async removeGeneratedArtifact(
    artifactPath: string,
    sourcePath: string,
  ): Promise<void> {
    const canonicalArtifact = resolve(artifactPath);
    const canonicalSource = resolve(sourcePath);
    const samePath =
      process.platform === "win32"
        ? canonicalArtifact.toLowerCase() === canonicalSource.toLowerCase()
        : canonicalArtifact === canonicalSource;
    if (samePath) {
      throw new Error(
        `Refusing to remove source PBF as a checkpoint artifact: ${canonicalSource}`,
      );
    }
    await rm(canonicalArtifact, { force: true });
  }

  private async save(): Promise<void> {
    this.manifest.updatedAt = new Date().toISOString();
    await writeJsonAtomically(this.path, this.manifest);
  }
}
