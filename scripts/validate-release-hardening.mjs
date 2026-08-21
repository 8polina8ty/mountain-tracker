import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootProxy = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
const supabaseProxy = await readFile(
  new URL("../Lib/supabase/proxy.ts", import.meta.url),
  "utf8",
);
const supabaseServer = await readFile(
  new URL("../Lib/supabase/server.ts", import.meta.url),
  "utf8",
);
const databaseTestLayout = await readFile(
  new URL("../app/[locale]/database-test/layout.tsx", import.meta.url),
  "utf8",
);
const robots = await readFile(new URL("../app/robots.ts", import.meta.url), "utf8");
const sitemap = await readFile(new URL("../app/sitemap.ts", import.meta.url), "utf8");
const projectsLayout = await readFile(
  new URL("../app/[locale]/projects/layout.tsx", import.meta.url),
  "utf8",
);
const nextConfig = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
const gitignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

assert.ok(
  supabaseProxy.includes("supabase.auth.getClaims()"),
  "Supabase SSR proxy must validate and refresh auth claims",
);
assert.equal(
  supabaseProxy.includes("supabase.auth.getSession()"),
  false,
  "Server proxy must not trust getSession for authorization",
);
assert.ok(
  supabaseProxy.includes("request.cookies.getAll()") &&
    supabaseProxy.includes("request.cookies.set(name, value)"),
  "Refreshed auth cookies must be forwarded to downstream Server Components",
);
assert.ok(
  supabaseProxy.includes("response.cookies.set(name, value, options)"),
  "Refreshed auth cookies must be persisted to the browser response",
);
assert.ok(
  rootProxy.includes("refreshSupabaseSession") &&
    rootProxy.includes('"/api/projects/:path*"'),
  "Root proxy must refresh both localized pages and private project API routes",
);
assert.ok(
  supabaseServer.includes("getAll()") && supabaseServer.includes("setAll(cookiesToSet)"),
  "Server Supabase client must use the current bulk cookie contract",
);
assert.equal(
  /\bget\(name\)|\bremove\(\)\s*\{\}/.test(supabaseServer),
  false,
  "Legacy per-cookie Supabase SSR contract must not return",
);
assert.ok(
  databaseTestLayout.includes('process.env.NODE_ENV === "production"') &&
    databaseTestLayout.includes("notFound()"),
  "Database diagnostic route must be inaccessible in production",
);
assert.ok(
  robots.includes('"database-test"'),
  "Database diagnostic route must remain excluded from crawlers in development previews",
);
assert.ok(
  projectsLayout.includes("robots: { index: false, follow: false }"),
  "Private project routes must remain noindex/nofollow",
);
assert.ok(
  sitemap.includes('pathname: "/map"') &&
    sitemap.includes('pathname: "/ranking"') &&
    sitemap.includes('pathname: "/explore"'),
  "Public sitemap baseline changed unexpectedly",
);
for (const header of [
  "X-Content-Type-Options",
  "Referrer-Policy",
  "X-Frame-Options",
  "Permissions-Policy",
]) {
  assert.ok(nextConfig.includes(header), `Missing baseline security header: ${header}`);
}
assert.ok(
  gitignore.includes("!.env.example"),
  "The safe environment template must remain trackable",
);
for (const variableName of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SECRET_KEY",
  "PUBLIC_EXPEDITION_MEDIA_SECRET",
  "SITE_URL",
]) {
  assert.ok(
    envExample.includes(`${variableName}=`),
    `Environment template is missing ${variableName}`,
  );
}
assert.ok(
  packageJson.scripts?.["test:release"]?.includes("npm run build"),
  "Final release gate must include a production build",
);
assert.equal(
  packageJson.scripts?.typecheck,
  "tsc --noEmit --incremental false",
  "Release typecheck command changed unexpectedly",
);

console.log("Release hardening contracts passed.");
