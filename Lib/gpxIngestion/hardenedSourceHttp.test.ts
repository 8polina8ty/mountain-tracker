import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchBoundedHttps,
  isPublicIpAddress,
  SourceHttpError,
  type SourceFetch,
  type SourceHttpPolicy,
} from "./hardenedSourceHttp.ts";

const signal = new AbortController().signal;
const basePolicy: SourceHttpPolicy = {
  allowedHosts: [
    "api.openstreetmap.org",
    "openstreetmap-gps-traces.s3.dualstack.eu-west-1.amazonaws.com",
  ],
  timeoutMs: 100,
  maximumResponseBytes: 1024,
  maximumRedirects: 2,
  userAgent: "MountainTracker/test",
  accept: "application/xml",
};
const publicResolver = async () => ["8.8.8.8"];

function queueFetch(responses: Response[]): {
  fetchImplementation: SourceFetch;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async fetchImplementation(input) {
      calls.push(input.toString());
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected mock fetch.");
      return response;
    },
  };
}

async function expectHttpCode(
  operation: () => Promise<unknown>,
  code: SourceHttpError["code"],
): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof SourceHttpError);
    assert.equal(error.code, code);
    return true;
  });
}

test("follows only bounded redirects whose targets pass the full policy", async () => {
  const mock = queueFetch([
    new Response(null, {
      status: 302,
      headers: { location: "/api/0.6/gpx/2" },
    }),
    new Response("ok", { status: 200 }),
  ]);
  const result = await fetchBoundedHttps(
    "https://api.openstreetmap.org/api/0.6/gpx/1",
    signal,
    basePolicy,
    { ...mock, resolveHost: publicResolver },
  );
  assert.equal(new TextDecoder().decode(result.bytes), "ok");
  assert.deepEqual(mock.calls, [
    "https://api.openstreetmap.org/api/0.6/gpx/1",
    "https://api.openstreetmap.org/api/0.6/gpx/2",
  ]);
});

test("allows the dedicated OSM GPX bucket only after redirect revalidation", async () => {
  const storageUrl =
    "https://openstreetmap-gps-traces.s3.dualstack.eu-west-1.amazonaws.com/opaque-key";
  const mock = queueFetch([
    new Response(null, { status: 302, headers: { location: storageUrl } }),
    new Response("gpx", { status: 200 }),
  ]);
  const result = await fetchBoundedHttps(
    "https://api.openstreetmap.org/api/0.6/gpx/1/data.gpx",
    signal,
    basePolicy,
    { ...mock, resolveHost: publicResolver },
  );
  assert.equal(result.url, storageUrl);
  assert.equal(mock.calls.length, 2);
});

test("rejects arbitrary-domain and HTTP downgrade redirects before a second request", async () => {
  for (const location of [
    "https://evil.example/steal",
    "http://api.openstreetmap.org/api/0.6/gpx/2",
  ]) {
    const mock = queueFetch([
      new Response(null, { status: 302, headers: { location } }),
    ]);
    await expectHttpCode(
      () => fetchBoundedHttps(
        "https://api.openstreetmap.org/api/0.6/gpx/1",
        signal,
        basePolicy,
        { ...mock, resolveHost: publicResolver },
      ),
      location.startsWith("http:") ? "DISALLOWED_SCHEME" : "DISALLOWED_HOST",
    );
    assert.equal(mock.calls.length, 1);
  }
});

test("classifies loopback, RFC1918, link-local, and IPv6 loopback as non-public", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.1.1",
    "::1",
  ]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("rejects private-address and localhost redirects without contacting them", async () => {
  for (const target of [
    "https://127.0.0.1/private",
    "https://10.0.0.1/private",
    "https://172.16.0.1/private",
    "https://192.168.0.1/private",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/private",
    "https://[::1]/private",
  ]) {
    const hostname = new URL(target).hostname;
    const mock = queueFetch([
      new Response(null, { status: 302, headers: { location: target } }),
    ]);
    await expectHttpCode(
      () => fetchBoundedHttps(
        "https://api.openstreetmap.org/api/0.6/gpx/1",
        signal,
        { ...basePolicy, allowedHosts: ["api.openstreetmap.org", hostname] },
        {
          ...mock,
          resolveHost: async (host) =>
            host === "localhost" ? ["127.0.0.1"] : publicResolver(),
        },
      ),
      "DISALLOWED_ADDRESS",
    );
    assert.equal(mock.calls.length, 1);
  }
});

test("rejects a public allowlisted hostname if DNS resolves it privately", async () => {
  const mock = queueFetch([]);
  await expectHttpCode(
    () => fetchBoundedHttps(
      "https://api.openstreetmap.org/api/0.6/gpx/1",
      signal,
      basePolicy,
      { ...mock, resolveHost: async () => ["127.0.0.1"] },
    ),
    "DISALLOWED_ADDRESS",
  );
  assert.equal(mock.calls.length, 0);
});

test("enforces Content-Length and streamed byte ceilings", async () => {
  const declared = queueFetch([
    new Response("tiny", {
      status: 200,
      headers: { "content-length": "100" },
    }),
  ]);
  await expectHttpCode(
    () => fetchBoundedHttps(
      "https://api.openstreetmap.org/api/0.6/gpx/1",
      signal,
      { ...basePolicy, maximumResponseBytes: 10 },
      { ...declared, resolveHost: publicResolver },
    ),
    "RESPONSE_TOO_LARGE",
  );

  const streamed = queueFetch([new Response("12345678901", { status: 200 })]);
  await expectHttpCode(
    () => fetchBoundedHttps(
      "https://api.openstreetmap.org/api/0.6/gpx/1",
      signal,
      { ...basePolicy, maximumResponseBytes: 10 },
      { ...streamed, resolveHost: publicResolver },
    ),
    "RESPONSE_TOO_LARGE",
  );
});

test("turns a bounded request timeout into a retryable stable error", async () => {
  const hangingFetch: SourceFetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
  await assert.rejects(
    () => fetchBoundedHttps(
      "https://api.openstreetmap.org/api/0.6/gpx/1",
      signal,
      { ...basePolicy, timeoutMs: 5 },
      { fetchImplementation: hangingFetch, resolveHost: publicResolver },
    ),
    (error) =>
      error instanceof SourceHttpError &&
      error.code === "REQUEST_TIMEOUT" &&
      error.retryable,
  );
});

test("rejects redirect loops at the configured boundary", async () => {
  const mock = queueFetch([
    new Response(null, { status: 302, headers: { location: "/two" } }),
  ]);
  await expectHttpCode(
    () => fetchBoundedHttps(
      "https://api.openstreetmap.org/one",
      signal,
      { ...basePolicy, maximumRedirects: 0 },
      { ...mock, resolveHost: publicResolver },
    ),
    "REDIRECT_LIMIT_EXCEEDED",
  );
});
