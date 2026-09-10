import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SourceHttpErrorCode =
  | "DISALLOWED_SCHEME"
  | "DISALLOWED_HOST"
  | "DISALLOWED_ADDRESS"
  | "INVALID_REDIRECT"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "RESPONSE_TOO_LARGE"
  | "REQUEST_TIMEOUT"
  | "REQUEST_ABORTED"
  | "NETWORK_ERROR";

export class SourceHttpError extends Error {
  readonly code: SourceHttpErrorCode;
  readonly retryable: boolean;

  constructor(code: SourceHttpErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "SourceHttpError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type SourceFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SourceHostResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export interface SourceHttpPolicy {
  allowedHosts: readonly string[];
  timeoutMs: number;
  maximumResponseBytes: number;
  maximumRedirects: number;
  userAgent: string;
  accept: string;
}

export interface SourceHttpDependencies {
  fetchImplementation?: SourceFetch;
  resolveHost?: SourceHostResolver;
}

export interface BoundedHttpResponse {
  url: string;
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function fetchBoundedHttps(
  input: string | URL,
  signal: AbortSignal,
  policy: SourceHttpPolicy,
  dependencies: SourceHttpDependencies = {},
): Promise<BoundedHttpResponse> {
  validatePolicy(policy);
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const resolveHost = dependencies.resolveHost ?? resolvePublicHost;
  let currentUrl = new URL(input);
  let redirectCount = 0;

  while (true) {
    validateSourceUrl(currentUrl, policy.allowedHosts);
    await assertPublicResolution(normalizeHostname(currentUrl.hostname), resolveHost);
    const response = await fetchOne(
      currentUrl,
      signal,
      policy,
      fetchImplementation,
    );

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirectCount >= policy.maximumRedirects) {
        throw new SourceHttpError(
          "REDIRECT_LIMIT_EXCEEDED",
          "Source response exceeded the redirect limit.",
        );
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new SourceHttpError(
          "INVALID_REDIRECT",
          "Source redirect omitted its target.",
        );
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new SourceHttpError(
          "INVALID_REDIRECT",
          "Source redirect target is invalid.",
        );
      }
      redirectCount += 1;
      continue;
    }

    return {
      url: currentUrl.toString(),
      status: response.status,
      headers: response.headers,
      bytes: await readBoundedBody(response, policy.maximumResponseBytes),
    };
  }
}

export function validateSourceUrl(
  url: URL,
  allowedHosts: readonly string[],
): void {
  if (url.protocol !== "https:") {
    throw new SourceHttpError(
      "DISALLOWED_SCHEME",
      "Source requests require HTTPS.",
    );
  }
  if (url.username !== "" || url.password !== "" || url.port !== "") {
    throw new SourceHttpError(
      "DISALLOWED_HOST",
      "Source URLs cannot contain credentials or custom ports.",
    );
  }
  const hostname = normalizeHostname(url.hostname);
  const allowlist = new Set(allowedHosts.map(normalizeHostname));
  if (!allowlist.has(hostname)) {
    throw new SourceHttpError(
      "DISALLOWED_HOST",
      "Source URL host is not allowlisted.",
    );
  }
  if (isIP(hostname) !== 0 && !isPublicIpAddress(hostname)) {
    throw new SourceHttpError(
      "DISALLOWED_ADDRESS",
      "Source URL resolves to a non-public address.",
    );
  }
}

export function isPublicIpAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;

  const normalized = address.toLowerCase().split("%")[0];
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }
  const mappedIpv4 = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mappedIpv4 === undefined || isPublicIpv4(mappedIpv4);
}

async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

async function assertPublicResolution(
  hostname: string,
  resolveHost: SourceHostResolver,
): Promise<void> {
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new SourceHttpError(
      "NETWORK_ERROR",
      "Source hostname resolution failed.",
      true,
    );
  }
  if (addresses.length === 0) {
    throw new SourceHttpError(
      "NETWORK_ERROR",
      "Source hostname resolved to no addresses.",
      true,
    );
  }
  if (addresses.some((address) => !isPublicIpAddress(address))) {
    throw new SourceHttpError(
      "DISALLOWED_ADDRESS",
      "Source hostname resolved to a non-public address.",
    );
  }
}

async function fetchOne(
  url: URL,
  parentSignal: AbortSignal,
  policy: SourceHttpPolicy,
  fetchImplementation: SourceFetch,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Source request timed out."));
  }, policy.timeoutMs);

  try {
    return await fetchImplementation(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: policy.accept,
        "User-Agent": policy.userAgent,
      },
    });
  } catch {
    if (timedOut) {
      throw new SourceHttpError(
        "REQUEST_TIMEOUT",
        "Source request timed out.",
        true,
      );
    }
    if (parentSignal.aborted) {
      throw new SourceHttpError(
        "REQUEST_ABORTED",
        "Source request was aborted.",
      );
    }
    throw new SourceHttpError(
      "NETWORK_ERROR",
      "Source request failed.",
      true,
    );
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

async function readBoundedBody(
  response: Response,
  maximumResponseBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maximumResponseBytes) {
      await response.body?.cancel();
      throw new SourceHttpError(
        "RESPONSE_TOO_LARGE",
        "Source response exceeds its byte limit.",
      );
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumResponseBytes) {
      await reader.cancel();
      throw new SourceHttpError(
        "RESPONSE_TOO_LARGE",
        "Source response exceeds its byte limit.",
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => part < 0 || part > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function normalizeHostname(hostname: string): string {
  const normalized = hostname.toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function validatePolicy(policy: SourceHttpPolicy): void {
  if (
    policy.allowedHosts.length === 0 ||
    !Number.isSafeInteger(policy.timeoutMs) ||
    policy.timeoutMs < 1 ||
    !Number.isSafeInteger(policy.maximumResponseBytes) ||
    policy.maximumResponseBytes < 1 ||
    !Number.isSafeInteger(policy.maximumRedirects) ||
    policy.maximumRedirects < 0 ||
    policy.maximumRedirects > 10 ||
    policy.userAgent.trim() === "" ||
    policy.accept.trim() === ""
  ) {
    throw new Error("Invalid bounded source HTTP policy.");
  }
}
