<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Mountain Tracker

## Sources Of Truth

- This is one npm package (`package-lock.json`), not a workspace. Use npm; `@/*` resolves from the repository root.
- `README.md` is still the create-next-app template and is stale: there is no `app/page.tsx`. Trust scripts and source over it.
- Framework versions are Next.js 16.2 and React 19; do not rely on older Next.js conventions.
- Shared application code is in capitalized `Lib/`; preserve that casing for Linux deployments.

## Commands

- Install reproducibly: `npm ci`
- Development: `npm run dev`
- Lint all or one path: `npm run lint`; `npx eslint <path>`
- Typecheck: `npx tsc --noEmit --incremental false` (there is no `typecheck` script).
- Domain checks: `npm run test:achievements`; `npm run test:social`. They require a Node version supporting `--experimental-strip-types`.
- Production verification: `npm run build`
- There is no Jest/Vitest/Playwright suite and no checked-in CI workflow. Run lint, typecheck, the relevant domain validator(s), then build for broad verification.

## Runtime Shape

- The App Router starts at `app/[locale]/layout.tsx`; `app/[locale]/page.tsx` redirects to the main map. Route params such as `params` are async in this Next.js version.
- `proxy.ts` owns next-intl routing. All normal routes are locale-prefixed; supported locales are `de`, `en`, and `ru`, with `de` as default. Unprefixed `/map`, `/mountain`, `/ranking`, and `/users` paths (including descendants) intentionally redirect to `/ru/...`.
- Locale messages are domain JSON files under `messages/<locale>/`. Adding a domain requires the same file/key shape in all three locales and an entry in `i18n/request.ts`'s `messageFiles`.
- Use locale-aware navigation exports from `i18n/navigation.ts` when applicable.
- Browser and server Supabase factories are separate: `Lib/supabase/client.ts` and `Lib/supabase/server.ts`. The server cookie adapter cannot write cookies, and `proxy.ts` does not refresh auth sessions.
- App runtime requires `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. SEO origin optionally comes from `SITE_URL`, `NEXT_PUBLIC_SITE_URL`, or Vercel URL variables. Never print or commit `.env*` values.

## Sensitive Coupling

- Supabase tables, RLS, storage, RPCs, auth, and Realtime are deployed contracts. Do not rename or rewrite them as part of UI work. The base schema and `get_mountains_in_bounds` RPC definition are not in this repository, so local SQL does not describe the full backend.
- `database/*.sql` contains manually applied, reviewed artifacts, not migrations or proof of deployed state. Never apply them unless explicitly requested.
- Achievement SQL order is snapshot -> reconciliation -> notifications -> backfill (`get_achievement_snapshot.sql`, `reconcile_user_achievements.sql`, `achievement_notifications.sql`, `backfill_user_achievements.sql`); the public summary is a separate manual Phase H artifact.
- Social SQL order is profile contract -> friend requests -> friendships -> blocks -> verify Phase B -> conversations -> messages -> unread/Realtime.
- The contract validators intentionally inspect SQL literals, translation shapes, source patterns, and even achievement trigger call counts. After touching achievements or social/messaging, run the matching validator; do not dismiss failures as brittle tests.
- Python peak importers are operational ETL, not setup scripts. They load `.env.local`, use `SUPABASE_SERVICE_ROLE_KEY`, and directly upsert production-shaped mountain data; do not run them without an explicit import task.

## Map And Tracks

- MapLibre is the active map engine; do not replace it. `mapbox-gl` is installed but has no application imports.
- Main map wiring is `MountainMap` -> `useMountainMap`/`initializeMap` -> `get_mountains_in_bounds` -> GeoJSON source `peaks` -> layers `clusters`, `cluster-count`, and `individual-peaks`. Search, filtering, clustering, visible count, selection, and climbed state share these IDs and `originalGeoJsonRef`.
- Search only covers the buffered viewport data already loaded, not the global mountain database. Filtering replaces source data so MapLibre recalculates clusters.
- LOD result thresholds are duplicated in `initializeMap.ts` and `useMountainMap.ts`; keep initial and subsequent loads aligned. `loadAllMountains.ts` is currently unused.
- Track import is a client-side, compensating (not transactional) sequence across `gps_activities` and private bucket `activity-tracks`. The file chooser lists several formats, but processing currently rejects everything except GPX.
- Preserve map cleanup, abort/debounce behavior, source/layer IDs, clustering, altitude colors, navigation, ascent state, GPX/GeoJSON behavior, and Supabase loading. Do not animate the MapLibre container.

## UI Work

- The product is being incrementally modernized into a premium alpine exploration UI; preserve working behavior and avoid large visual rewrites of data/business logic.
- Reuse the Tailwind v4 semantic tokens and UI primitives in `app/globals.css` before adding page-specific values or dependencies.
- Motion uses `motion/react`; the root `MotionProvider` already sets `reducedMotion="user"`. Prefer short opacity/transform transitions and keep map interaction and mobile usability primary.
- For large redesign requests, first analyze without editing, report architecture/risks/design direction/phases, and wait for approval. Then proceed one phase at a time: tokens -> shell/navigation -> map UI -> mountain surfaces -> search/filter -> motion -> mobile -> accessibility/performance -> final checks.
- Work remains on the dedicated `redesign` branch. Do not switch branches, merge, push, or create commits unless explicitly requested.

## Project Working Rules

1. Work step by step.
2. Do not rewrite entire files unless explicitly requested.
3. Prefer small, targeted changes.
4. Before changing code, inspect the relevant files and understand the existing implementation.
5. Preserve existing functionality unless the task explicitly requires changing it.
6. Do not perform unrelated refactoring.
7. Do not rename, move, or delete files unless explicitly requested.
8. Do not modify Supabase production data.
9. Do not run database migrations automatically.
10. SQL migrations must be prepared for manual review and manual deployment.
11. Never expose or commit secrets, API keys, service-role keys, or environment variables.
12. After code changes, run the relevant TypeScript/lint/build checks when appropriate.
13. If a requested change affects several systems, explain the intended changes before implementation.
14. Maintain the existing Next.js App Router, TypeScript, Supabase, next-intl, MapLibre, Tailwind and Motion architecture.
15. Preserve localization support for de, en and ru.
16. Prefer fixing the root cause of an issue rather than adding temporary workarounds.
17. Do not modify unrelated code just to make formatting or style consistent.
18. When unsure about an architectural decision, ask before making a large or destructive change.
