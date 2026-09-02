# Phase 9 staging visual QA

Phase 9B is an internal preview and persistent QA workflow for the 46 routes locked by
`data/osm/alps/staging/first-write-manifest.json`. It never queries or writes
`mountain_routes` and has no publication path.

## Access model

The repository has Supabase authentication but no trusted administrator-role
contract. The preview therefore fails closed:

- `NODE_ENV=production` always returns not-found, regardless of configuration.
- Non-production access requires `OSM_STAGING_PREVIEW_ENABLED=true`.
- The requester must have an authenticated Supabase session.
- The authenticated user UUID must be present in the server-only comma-separated
  `OSM_STAGING_PREVIEW_USER_IDS` allowlist.
- Missing configuration, an empty allowlist, an anonymous session, or an
  unlisted user all return not-found before service-role access.

Neither setting is prefixed with `NEXT_PUBLIC_`. Service-role credentials and
the server data layer are never imported by client components.

After setting the two local values in `.env.local` and signing in as an allowed
user, use:

- `/{locale}/internal/osm-staging`
- `/{locale}/internal/osm-staging/{stagingRouteId}`

The routes have no header navigation entry, carry no-index metadata, and the
entire `internal` segment is disallowed in `robots.txt`.

## Manifest and database checks

Every list request queries only the 46 manifest idempotency keys and verifies:

- exact route and association counts;
- contract version and payload hash;
- source/canonical identity and staging eligibility;
- one-for-one manifest mountain IDs and OSM peak IDs;
- `CONFIRMED` final association;
- `EXACT_MOUNTAIN_MATCH` classification.

Any discrepancy aborts the complete response. The list sends only lightweight
metadata to the browser. Geometry and immutable payload evidence are selected
only for one manifest-approved detail route.

## QA decisions

`database/osm_staging_visual_qa.sql` remains an unapplied, manually reviewed
artifact. Absence from the current-decision table means `PENDING`; stored rows
can only be `VISUALLY_APPROVED`, `NEEDS_REVIEW`, or `REJECTED`. Every transition,
including a reset to `PENDING`, is appended to an immutable history table with
reviewer UUID, normalized plain-text note, time, and decision version.

The authenticated server action repeats the exact 46-route manifest validation
before calling one atomic, service-only RPC. The RPC locks the staging parent,
rechecks contract, hash, source/canonical identity, eligibility, `CONFIRMED`
association, and `EXACT_MOUNTAIN_MATCH`, then changes only the QA current/history
tables. Expected-version comparison prevents stale-tab overwrites. Direct browser
table access and direct service-role writes are revoked.

Visual approval is not publication eligibility and no Phase 9B module contains a
publication operation. The QA status is evidence for a later, separately reviewed
phase only.

## Controlled first write (manual; not executed by this implementation)

1. Review and manually apply `database/osm_staging_visual_qa.sql` in the intended
   non-production environment. Do not apply any staging-import SQL.
2. Verify both QA tables are empty, the reviewed manifest still contains exactly
   46 records, and the live staging validation still passes.
3. Sign in with the single allowlisted reviewer UUID and open warning relation
   `11192622` (staging UUID `6d86c0c8-8e1b-45ee-8ec5-7053078d4824`).
4. Record `NEEDS_REVIEW` with note
   `Phase 9B controlled write verification — long six-component route.`
5. Verify one current row at version 1 and one history transition from `PENDING`
   to `NEEDS_REVIEW`, with the authenticated reviewer and matching timestamp.
6. Re-open the route and verify the persisted status/note. In a stale second tab,
   attempt an update with the old version and verify `QA_DECISION_CONFLICT`.
7. Reset the route to `PENDING`; verify the current row is absent and the second
   immutable history event records the reset. Confirm the two staging evidence
   tables and all application route/mountain tables have unchanged row counts.

The procedure exercises one reversible QA route only. It does not authorize a
publication run or any write outside the Phase 9B QA tables.
