// Source-specific code must fit this bounded, resumable adapter contract. The
// orchestrator owns retries, checkpoint persistence, policy gates, and writes.

import { evaluateSourcePolicy } from "./license.ts";
import { normalizeSourceKey, normalizeSourceNativeId } from "./sourceIdentity.ts";
import type {
  FetchedSourceTrack,
  SourceDiscoveryRecord,
  SourceRightsPolicy,
  SourceTrackMetadata,
} from "./types.ts";

export interface SourceAdapterDescriptor {
  sourceKey: string;
  sourceName: string;
  adapterVersion: string;
  accessMethod: "API" | "BULK_DOWNLOAD" | "MANUAL_SNAPSHOT";
  allowedDownloadHosts: string[];
  requestsPerSecond: number;
  maximumConcurrency: number;
  retryLimit: number;
  retryBaseDelayMs: number;
}

export interface SourceRequestContext {
  signal: AbortSignal;
  attempt: number;
}

export interface DiscoveryRequest extends SourceRequestContext {
  cursor: string | null;
  pageSize: number;
}

export interface DiscoveryPage {
  records: SourceDiscoveryRecord[];
  nextCursor: string | null;
}

export interface GpxSourceAdapter {
  readonly descriptor: SourceAdapterDescriptor;
  normalizeSourceIdentity(record: SourceDiscoveryRecord): string;
  discover(request: DiscoveryRequest): Promise<DiscoveryPage>;
  fetchMetadata(
    record: SourceDiscoveryRecord,
    context: SourceRequestContext,
  ): Promise<SourceTrackMetadata>;
  fetchTrack(
    metadata: SourceTrackMetadata,
    context: SourceRequestContext,
  ): Promise<FetchedSourceTrack>;
}

export function normalizeDescriptor(
  partial: Partial<SourceAdapterDescriptor> &
    Pick<SourceAdapterDescriptor, "sourceKey" | "sourceName" | "accessMethod">,
): SourceAdapterDescriptor {
  return validateSourceAdapterDescriptor({
    sourceKey: normalizeSourceKey(partial.sourceKey),
    sourceName: partial.sourceName.normalize("NFKC").trim(),
    accessMethod: partial.accessMethod,
    adapterVersion: partial.adapterVersion ?? "1",
    allowedDownloadHosts: partial.allowedDownloadHosts ?? [],
    requestsPerSecond: partial.requestsPerSecond ?? 1,
    maximumConcurrency: partial.maximumConcurrency ?? 2,
    retryLimit: partial.retryLimit ?? 3,
    retryBaseDelayMs: partial.retryBaseDelayMs ?? 1_000,
  });
}

export function validateSourceAdapterDescriptor(
  descriptor: SourceAdapterDescriptor,
): SourceAdapterDescriptor {
  const sourceName = descriptor.sourceName.normalize("NFKC").trim();
  if (sourceName.length === 0 || sourceName.length > 200) {
    throw new Error("sourceName must contain 1-200 characters.");
  }
  if (descriptor.adapterVersion.trim().length === 0) {
    throw new Error("adapterVersion is required.");
  }
  if (
    !Number.isFinite(descriptor.requestsPerSecond) ||
    descriptor.requestsPerSecond <= 0 ||
    descriptor.requestsPerSecond > 20
  ) {
    throw new Error("requestsPerSecond must be bounded between 0 and 20.");
  }
  if (
    !Number.isSafeInteger(descriptor.maximumConcurrency) ||
    descriptor.maximumConcurrency < 1 ||
    descriptor.maximumConcurrency > 16
  ) {
    throw new Error("maximumConcurrency must be an integer from 1 to 16.");
  }
  if (
    !Number.isSafeInteger(descriptor.retryLimit) ||
    descriptor.retryLimit < 0 ||
    descriptor.retryLimit > 10
  ) {
    throw new Error("retryLimit must be an integer from 0 to 10.");
  }
  if (
    !Number.isSafeInteger(descriptor.retryBaseDelayMs) ||
    descriptor.retryBaseDelayMs < 100 ||
    descriptor.retryBaseDelayMs > 60_000
  ) {
    throw new Error("retryBaseDelayMs must be an integer from 100 to 60000.");
  }
  const allowedDownloadHosts = descriptor.allowedDownloadHosts.map((host) => {
    const normalized = host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.includes("..")) {
      throw new Error("allowedDownloadHosts contains an invalid host.");
    }
    return normalized;
  });
  if (
    descriptor.accessMethod !== "MANUAL_SNAPSHOT" &&
    allowedDownloadHosts.length === 0
  ) {
    throw new Error("Network source adapters require an exact download-host allowlist.");
  }
  return {
    ...descriptor,
    sourceKey: normalizeSourceKey(descriptor.sourceKey),
    sourceName,
    adapterVersion: descriptor.adapterVersion.trim(),
    allowedDownloadHosts: [...new Set(allowedDownloadHosts)].sort(),
  };
}

export function assertAdapterMayRun(policy: SourceRightsPolicy): void {
  const result = evaluateSourcePolicy(policy);
  if (!result.mayDiscover) {
    throw new Error(`Source adapter is blocked by policy: ${result.reasons.join(" ")}`);
  }
}

export function defaultNormalizeSourceIdentity(record: SourceDiscoveryRecord): string {
  return normalizeSourceNativeId(record.sourceNativeId);
}
