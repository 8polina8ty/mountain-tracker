# Phase 11 — Expedition / Journal Integration & Hardening

Status: IN PROGRESS
Last updated: 2026-08-21

## Goal

Bring the Expedition / Journal domain from feature-complete integration into a release-ready state: reconcile database contracts, verify authorization and RLS behavior, harden Journal and GPS evidence flows, improve project-detail scaling, secure public expedition reports, remove legacy/dependency debt, and complete the final release gate.

## Checklist

- [x] 11.1 Database contract reconciliation
  - Tables, columns, constraints, indexes, RLS policies, RPC/functions, triggers, and Storage contracts reviewed.
  - No automatic database migration or production data change performed.
- [x] 11.2 Authorization matrix audit
  - Owner/editor/viewer/outsider/anonymous access expectations reconciled with UI and backend contracts.
- [x] 11.3 Real RLS integration tests
  - Security intent passed for the tested owner/editor/viewer/outsider/anonymous cases.
  - Remaining Storage/GPS/share lifecycle scenarios stay part of manual acceptance coverage.
- [x] 11.4 Journal hardening
  - Media upload/retry/cancel/private delivery/deletion contracts hardened.
  - Manual browser E2E remains required before launch.
- [x] 11.5 GPS evidence hardening
  - GPX size/type/coordinate/point-count validation and compensation behavior hardened.
  - Manual browser/GPS E2E remains required before launch.
- [x] 11.6 Project detail decomposition/performance
  - Server loading parallelized and detail presentation extracted into `ProjectDetailView`.
- [x] 11.7 Query scaling and Journal pagination
  - Bounded initial Journal loading, keyset pagination, exact/lightweight statistics, and private load-more endpoint implemented.
- [x] 11.8 Public report hardening
  - Opaque AES-256-GCM media handles, exact media lookup, private Storage delivery, and response hardening implemented.
- [x] 11.9 Legacy/dependency audit
  - Legacy Mapbox dependency removed, MapLibre lifecycle cleaned up, validator compatibility debt reduced, Node 24 runtime baseline added.
- [ ] 11.10 Final release gate / pre-production acceptance
  - [x] Static release-hardening contracts added.
  - [x] Supabase SSR session refresh and bulk cookie contract hardened.
  - [x] Production diagnostic route disabled.
  - [x] Baseline security headers and private-route crawler exclusions added.
  - [x] Production environment variable template added.
  - [x] Canonical finite `npm run test:release` command added.
  - [x] Release preflight rejects an active Next.js dev/Turbopack process and cleans stale generated type artifacts.
  - [ ] `npm run test:release` passes end to end on a clean local checkout with no active dev server.
  - [ ] Manual runtime/browser acceptance completed.
  - [ ] Production environment, backups, monitoring, and launch configuration confirmed.

## Current release-gate status

The most recent local run on 2026-08-21 passed runtime validation, release-hardening validation, and ESLint, then failed TypeScript parsing inside `.next/dev/types/validator.ts` while `.next/dev/cache/turbopack/*` files were locked by an active Next.js/Turbopack process. This is currently treated as a generated-artifact/runtime-process conflict, not as a confirmed source-code regression.

A release preflight now runs before the gate. It refuses to continue when `.next/dev/lock` is present and cleans `.next/dev/types` plus `.next/types` before TypeScript validation once the dev server is stopped.

## Completion criteria

Phase 11 is complete only when all of the following are true:

1. `npm run test:release` passes completely, including the production `next build`.
2. Auth/session behavior is manually verified in a browser, including login, logout, refresh/expiry behavior, and protected routes.
3. Map/GPS import and evidence flows are manually exercised with positive and negative cases.
4. Journal create/edit/delete, photo/video upload, retry, pagination, and private delivery are manually exercised.
5. Collaboration behavior is verified for owner, editor, viewer, outsider, and anonymous access where applicable.
6. Private reports and public expedition sharing/media are manually verified.
7. Production environment variables are configured without committing secrets.
8. Production Supabase state is reconciled with reviewed SQL contracts; required backups/monitoring are confirmed.
9. No unresolved release blocker remains.

## Final status

Not completed yet. When the criteria above are satisfied, update this section to `COMPLETED`, record the completion date, and summarize any accepted follow-up technical debt.
