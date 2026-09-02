# Phase 8B first-write procedure

Phase 8B reviewed the deterministic 50-route QA sample without writing to
Supabase. The review approved 46 routes and blocked four unresolved mountain
matches. The exact approved set is locked by:

`data/osm/alps/staging/first-write-manifest.json`

The manifest records the contract version, dataset fingerprint, idempotency
keys, payload hashes, source identities, exact Mountain Tracker resolutions,
and expected summit-row counts. `--manifest` and `--limit` are mutually
exclusive. A manifest run fails before database access if any reviewed value no
longer matches the current plan.

## SQL safety

`database/osm_route_import_staging.sql` creates only the two isolated Phase 8
staging tables and the service-only `stage_osm_route_import(jsonb, jsonb)`
function. It does not promote data into an application route table or modify a
mountain row. Both tables have RLS enabled, no public policies, privileges
revoked from `public`, `anon`, and `authenticated`, and explicit service-role
access. Foreign keys to `public.mountains` use `on delete restrict`.

The function upserts a route and replaces its complete summit association set
inside one PostgreSQL transaction. A constraint or insert failure rolls back
the route change and summit replacement together. An unchanged payload hash is
skipped by the importer, so a second identical command performs no mutation.

`database/osm_route_import_staging_rollback.sql` removes only the function and
the two Phase 8 staging tables. It is a manual-review artifact and has not been
executed.

## Future manually authorized first write

Apply the reviewed SQL manually first. Then, and only with explicit write
authorization, run:

```powershell
node --experimental-strip-types scripts/osm-import/stage-alps-routes.ts --apply-staging --admin-boundaries data/osm/boundaries/alps-admin.geojson --manifest data/osm/alps/staging/first-write-manifest.json
```

Verify the exact reviewed keys, payload hashes, Mountain Tracker resolutions,
and counts with the read-only verifier:

```powershell
node --experimental-strip-types scripts/osm-import/verify-first-write.ts --manifest data/osm/alps/staging/first-write-manifest.json
```

Expected verification is 46 route rows and 46 confirmed/exact summit rows. The
same apply command can then be repeated as the idempotency check; all 46 rows
should report unchanged and `databaseWrites` should be zero. Run the verifier a
second time and expect the same hashes and row counts.

Useful database-side checks after an authorized write are:

```sql
select count(*) as route_rows,
       count(distinct idempotency_key) as unique_idempotency_keys
from public.osm_route_import_staging
where contract_version = 'mountain-tracker-osm-route/v1';

select count(*) as summit_rows
from public.osm_route_import_summit_staging s
join public.osm_route_import_staging r on r.id = s.staging_route_id
where r.contract_version = 'mountain-tracker-osm-route/v1'
  and s.final_association = 'CONFIRMED'
  and s.mountain_match_classification = 'EXACT_MOUNTAIN_MATCH';

select idempotency_key, count(*)
from public.osm_route_import_staging
group by idempotency_key
having count(*) <> 1;

select r.idempotency_key, count(s.id) as summit_rows
from public.osm_route_import_staging r
left join public.osm_route_import_summit_staging s on s.staging_route_id = r.id
where r.contract_version = 'mountain-tracker-osm-route/v1'
group by r.idempotency_key
having count(s.id) = 0;
```
