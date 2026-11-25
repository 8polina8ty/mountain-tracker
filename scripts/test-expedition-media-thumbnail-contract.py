"""Run the SQL contract in a fresh, disposable loopback PostgreSQL cluster."""

import argparse
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import socket
import subprocess
import tempfile
from threading import Thread
from time import monotonic, sleep
from uuid import uuid4


ROOT = Path(__file__).resolve().parents[1]
DATABASE = "mountain_tracker_thumbnail_test"
PRIVATE = "expedition_media_private"
CONTRACT = ROOT / "database/expedition_media_thumbnails.sql"
CATALOG = ROOT / "database/expedition_media_thumbnails_catalog.sql"
ROLLBACK = ROOT / "database/expedition_media_thumbnails_rollback.sql"
WORKER = ROOT / "database/expedition_media_thumbnail_worker.sql"
WORKER_ROLLBACK = ROOT / "database/expedition_media_thumbnail_worker_rollback.sql"
MEDIA = "public.expedition_project_journal_media"


def check(condition, message):
    if not condition:
        raise RuntimeError(message)


class Psql:
    def __init__(self, binary, port):
        self.command = [str(binary), "-XAtqw", "-h", "127.0.0.1", "-p", str(port),
                        "-U", "postgres", "-v", "ON_ERROR_STOP=1"]
        self.env = {key: value for key, value in os.environ.items() if not key.upper().startswith("PG")}
        self.env["PGCONNECT_TIMEOUT"] = "2"

    def run(self, sql=None, *, db=DATABASE, file=None):
        option = ["-f", str(file)] if file else ["-c", sql]
        done = subprocess.run(self.command + ["-d", db] + option, env=self.env,
                              capture_output=True, text=True, timeout=45)
        if done.returncode:
            raise RuntimeError(done.stderr.strip() or "psql failed")
        return done.stdout.strip()


class Session:
    def __init__(self, psql):
        self.process = subprocess.Popen(psql.command + ["-d", DATABASE], env=psql.env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.output = Queue()
        self.reader = Thread(target=self.read_output, daemon=True)
        self.reader.start()
        self.marker = None
        self.pid = None
        self.pid = int(self.run("select pg_backend_pid();"))
        self.run("set lock_timeout = '8s'; set statement_timeout = '15s';")

    def read_output(self):
        for line in self.process.stdout:
            self.output.put(line.rstrip())
        self.output.put(None)

    def send(self, sql):
        check(self.marker is None, "Session already has a query in flight")
        self.marker = f"marker_{uuid4().hex}"
        self.process.stdin.write(f"{sql}\n\\echo {self.marker}\n")
        self.process.stdin.flush()

    def receive(self):
        lines = []
        deadline = monotonic() + 15
        while monotonic() < deadline:
            try:
                line = self.output.get(timeout=max(0, deadline - monotonic()))
            except Empty as exc:
                raise TimeoutError(f"Session {self.pid} did not finish") from exc
            if line is None:
                raise RuntimeError("Session closed: " + "\n".join(lines))
            if line == self.marker:
                self.marker = None
                return "\n".join(lines).strip()
            lines.append(line)
        raise TimeoutError("Expected psql marker did not arrive")

    def run(self, sql):
        self.send(sql)
        return self.receive()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.reader.join(timeout=5)
        self.process.stdin.close()
        self.process.stdout.close()


def wait_for_lock(psql, blocker, waiter):
    deadline = monotonic() + 5
    while monotonic() < deadline:
        if psql.run(f"select {blocker.pid} = any(pg_blocking_pids({waiter.pid}))") == "t":
            return
        sleep(0.05)
    raise RuntimeError(f"Session {waiter.pid} did not wait for {blocker.pid}")


def fixture(psql, *, legacy=False):
    owner, project, journal, media, source = (str(uuid4()) for _ in range(5))
    path = f"{owner}/{project}/{journal}/{media}/original.png"
    psql.run(f"""
        insert into auth.users(id) values ('{owner}');
        insert into public.expedition_projects(id,user_id,name) values ('{project}','{owner}','Concurrency fixture');
        insert into public.expedition_project_journal_entries(id,project_id,user_id,body)
          values ('{journal}','{project}','{owner}','Synthetic');
        insert into {MEDIA} (id,journal_entry_id,project_id,user_id,media_type,storage_path,original_filename,
          mime_type,size_bytes,width,height,sort_order)
          values ('{media}','{journal}','{project}','{owner}','photo','{path}','original.png','image/png',68,1,1,0);
        insert into storage.objects(id,bucket_id,name,version,metadata)
          values ('{source}','expedition-media','{path}','source-v1','{{"size":68,"mimetype":"image/png"}}');
    """)
    if legacy:
        psql.run(f"delete from {PRIVATE}.thumbnails where media_id='{media}'")
    return project, media, source


def prepared_attempt(psql):
    project, media, source = fixture(psql)
    claim_sql = f"select attempt_id,derivative_key from public.expedition_thumbnail_claim(1,120,1,'{project}')"
    attempt, key = psql.run(claim_sql).split("|")
    derivative = uuid4()
    psql.run(f"""
        insert into storage.objects(id,bucket_id,name,version,metadata)
          values ('{derivative}','expedition-media-thumbnails','{key}','out-v1','{{"size":32,"mimetype":"image/webp"}}')
    """)
    complete = (f"select public.expedition_thumbnail_complete('{media}','{attempt}','{source}',"
                f"'source-v1','{derivative}','out-v1',1,1,32);")
    return project, media, attempt, derivative, complete


def check_deleted(psql, media, attempt=None):
    check(psql.run(f"select count(*) from {PRIVATE}.thumbnails where media_id='{media}'") == "0",
          "Deleted canonical media retained a manifest")
    if attempt:
        check(psql.run(f"select state from {PRIVATE}.thumbnail_cleanup where attempt_id='{attempt}'") == "pending",
              "Media deletion lost or held the cleanup reservation")


def race(psql, first, second, expected_first, expected_second):
    with Session(psql) as a, Session(psql) as b:
        check(a.run(first) == expected_first, "Unexpected first transaction outcome")
        b.send(second)
        wait_for_lock(psql, a, b)
        a.run("commit;")
        check(b.receive() == expected_second, "Unexpected result after competing transaction committed")
        b.run("commit;")


def concurrency(psql):
    project_a, media_a, _ = fixture(psql)
    project_b, media_b, _ = fixture(psql)
    with Session(psql) as a, Session(psql) as b:
        claim_sql = "select media_id from public.expedition_thumbnail_claim(1,120);"
        got_a = a.run("begin; set local role service_role; " + claim_sql)
        got_b = b.run("begin; set local role service_role; " + claim_sql)
        check({got_a, got_b} == {media_a, media_b}, "Concurrent generation claims did not lease distinct photos")
        a.run("commit;")
        b.run("commit;")
    psql.run(f"delete from public.expedition_projects where id in ('{project_a}','{project_b}')")
    print("PASS concurrent generation claims")

    cleanup_a, cleanup_b = uuid4(), uuid4()
    psql.run(f"""
        insert into {PRIVATE}.thumbnail_cleanup(attempt_id,media_id,processing_version,available_at)
        values ('{cleanup_a}','{media_a}',1,now()-interval '1 day'), ('{cleanup_b}','{media_b}',1,now()-interval '1 day')
    """)
    with Session(psql) as a, Session(psql) as b:
        claim_sql = "select attempt_id from public.expedition_thumbnail_claim_cleanup(1,120);"
        got_a = a.run("begin; set local role service_role; " + claim_sql)
        got_b = b.run("begin; set local role service_role; " + claim_sql)
        check({got_a, got_b} == {str(cleanup_a), str(cleanup_b)}, "Concurrent cleanup claims leased the same key")
        a.run("commit;")
        b.run("commit;")
    print("PASS concurrent cleanup claims")

    worker = "begin; set local role service_role; "
    for delete_first in (False, True):
        _, media, attempt, _, complete = prepared_attempt(psql)
        delete = f"begin; delete from {MEDIA} where id='{media}';"
        if delete_first:
            race(psql, delete, worker + complete, "", "f")
        else:
            race(psql, worker + complete, delete, "t", "")
        check_deleted(psql, media, attempt)
        print(f"PASS completion vs deletion, {'deletion' if delete_first else 'completion'} first")

    project, media, _, _, complete = prepared_attempt(psql)
    repair = f"select public.expedition_thumbnail_enqueue('{project}','{media}',true);"
    race(psql, worker + complete, worker + repair, "t", "f")
    check(psql.run(f"select count(*) from public.expedition_thumbnail_lookup('{project}','{media}')") == "1",
          "Repair overwrote a newly healthy ready manifest")
    print("PASS repair vs completion, healthy winner retained")

    project, media, attempt, derivative, complete = prepared_attempt(psql)
    check(psql.run(complete) == "t", "Repair race fixture did not become ready")
    psql.run(f"delete from storage.objects where id='{derivative}'")
    repair = f"select public.expedition_thumbnail_enqueue('{project}','{media}',true);"
    race(psql, worker + repair, worker + complete, "t", "f")
    check(psql.run(f"select state from {PRIVATE}.thumbnail_cleanup where attempt_id='{attempt}'") == "pending",
          "Repair lost old-key cleanup")
    print("PASS repair vs completion, stale completion fenced")

    for delete_first in (False, True):
        project, media, _ = fixture(psql, legacy=True)
        enqueue = f"select public.expedition_thumbnail_enqueue('{project}','{media}');"
        delete = f"begin; delete from {MEDIA} where id='{media}';"
        if delete_first:
            race(psql, delete, worker + enqueue, "", "f")
        else:
            race(psql, worker + enqueue, delete, "t", "")
        check_deleted(psql, media)
        print(f"PASS legacy enqueue vs deletion, {'deletion' if delete_first else 'enqueue'} first")


def project_lease_cap(psql):
    project, sample, _ = fixture(psql)

    def add_photo():
        media = uuid4()
        psql.run(f"""
          insert into {MEDIA}(id,journal_entry_id,project_id,user_id,media_type,storage_path,
            original_filename,mime_type,size_bytes,width,height,sort_order)
          select '{media}',journal_entry_id,project_id,user_id,media_type,replace(storage_path,id::text,'{media}'),
            original_filename,mime_type,size_bytes,width,height,
            (select max(sort_order)+1 from {MEDIA} where project_id='{project}')
          from {MEDIA} where id='{sample}';
          insert into storage.objects(bucket_id,name,version,metadata)
          select 'expedition-media',storage_path,'new-source','{{"size":68,"mimetype":"image/png"}}'
          from {MEDIA} where id='{media}';
        """)

    add_photo()
    check(psql.run("select public.expedition_thumbnail_set_version(1,2)") == "t", "Could not prepare v2")
    add_photo()
    add_photo()

    def claim(version):
        return f"select processing_version from public.expedition_thumbnail_claim(1,120,{version},'{project}');"

    with Session(psql) as v1, Session(psql) as v2, Session(psql) as third:
        for worker in (v1, v2, third):
            check(worker.run("begin; set local role service_role; show transaction_isolation;") == "read committed",
                  "Worker default transaction isolation changed")
        check(v1.run(claim(1)) == "1", "v1 could not claim its lease")
        check(v2.run(claim(2)) == "", "v2 bypassed the v1 advisory lock")
        v1.run("commit;")
        check(v2.run(claim(2)) == "2", "v2 could not claim the second slot")
        check(third.run(claim(1)) == "", "v1 bypassed the v2 advisory lock")
        v2.run("commit;")
        check(third.run(claim(1)) == "" and third.run(claim(2)) == "", "A third live lease crossed the version cap")
        third.run("commit;")
    versions = psql.run(f"""
      select t.state,array_agg(t.processing_version order by t.processing_version)
      from {PRIVATE}.thumbnails t join {MEDIA} m on m.id=t.media_id
      where m.project_id='{project}' and (t.state='pending' or t.lease_until > clock_timestamp())
      group by t.state order by t.state
    """)
    check(versions == "pending|{1,2}\nprocessing|{1,2}", "Expected both versions live and both versions still due")
    print("PASS READ COMMITTED cross-version lease cap")


def preflight_failures(psql):
    contract = CONTRACT.read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory() as scratch:
        path = Path(scratch) / "install-invalid.sql"
        for mutation, expected in (
            ("alter table storage.objects drop column is_delete_marker;",
             "Unexpected Storage object or bucket versioning columns"),
            ("drop index storage.idx_objects_current_version;",
             "Storage is missing the reviewed unique current-object index"),
            ("drop index storage.idx_objects_current_version; create unique index wrong_current on "
             "storage.objects(bucket_id,name collate \"C\") where archived_at is null and not is_delete_marker;",
             "Storage is missing the reviewed unique current-object index"),
            ("drop index storage.objects_bucket_id_name_version_key;",
             "Storage is missing the reviewed unique object ID or path/version constraint"),
            ("insert into storage.objects(bucket_id,name,version,archived_at,is_versioned) "
             "values ('expedition-media-thumbnails','historical.webp','old',now(),true);",
             "Existing thumbnail bucket contains unsupported Storage history"),
            *[(f"update storage.buckets set versioning_status='{mode}' where id='expedition-media-thumbnails';",
               "with a 65536-byte limit and versioning DISABLED") for mode in ("ENABLED", "SUSPENDED")],
        ):
            path.write_text("begin;\n" + mutation + "\n" + contract, encoding="utf-8")
            try:
                psql.run(file=path)
            except RuntimeError as exc:
                check(expected in str(exc), f"Wrong install rejection: {exc}")
            else:
                raise RuntimeError("Unsupported Storage configuration installed")
    print("PASS installation rejects missing identity columns, incompatible indexes and versioned derivative buckets")


def rollback_state(psql):
    return psql.run(f"""
      select jsonb_build_array(
        (select count(*) from auth.users),
        (select count(*) from public.expedition_projects),
        (select count(*) from public.expedition_project_days),
        (select count(*) from public.expedition_project_journal_entries),
        (select count(*) from {MEDIA}),
        (select count(*) from storage.objects),
        (select count(*) from {PRIVATE}.thumbnails),
        (select count(*) from {PRIVATE}.thumbnail_cleanup),
        (select count(*) from pg_policy where polname in ('thumbnail_test_permissive','thumbnail_test_bucket_permissive')),
        (select array_agg(versioning_status order by id) from storage.buckets),
        (select target_version from {PRIVATE}.thumbnail_settings),
        to_regclass('storage.idx_objects_current_version') is not null
      )
    """)


def worker_contract(psql):
    psql.run(file=WORKER)
    project_a, media_a, _ = fixture(psql)
    project_b, media_b, _ = fixture(psql)
    psql.run(f"""
      insert into public.expedition_project_shares values ('{project_a}',true);
      delete from {PRIVATE}.thumbnails where media_id='{media_a}';
    """)
    backfill = "set role service_role; select public.expedition_thumbnail_backfill_page(null,true,{apply})"
    dry = json.loads(psql.run(backfill.format(apply="false")))
    check(dry["photos"] == dry["unqueued"] == 1 and dry["enqueued"] == 0,
          "Dry-run did not report the published legacy photo")
    check(psql.run(f"select count(*) from {PRIVATE}.thumbnails where media_id='{media_a}'") == "0",
          "Dry-run changed the queue")
    check(json.loads(psql.run(backfill.format(apply="true")))["enqueued"] == 1, "Backfill did not enqueue")
    check(json.loads(psql.run(backfill.format(apply="true")))["enqueued"] == 0, "Backfill replay created work")

    prefix = "set local role service_role; "
    acquire = "select public.expedition_thumbnail_worker_acquire();"
    with Session(psql) as first, Session(psql) as second:
        token = first.run("begin; " + prefix + acquire)
        check(re.fullmatch(r"[0-9a-f-]{36}", token) is not None, "Worker did not receive a lease")
        second.send("begin; " + prefix + acquire)
        wait_for_lock(psql, first, second)
        first.run("commit;")
        check(second.receive() == "", "Two worker invocations received the global slot")
        second.run("commit;")

    claim = f"set role service_role; select media_id from public.expedition_thumbnail_worker_claim('{token}',2)"
    check({psql.run(claim), psql.run(claim)} == {media_a, media_b}, "Scoped fair dispatch did not advance")
    cursor = psql.run(f"select project_after from {PRIVATE}.thumbnail_worker_state")
    check(cursor == max(project_a, project_b), "Project cursor moved backwards")
    check(psql.run(f"select last_sweep_at is not null from {PRIVATE}.thumbnail_worker_state") == "t",
          "Worker did not persist its sweep")
    psql.run(f"update {PRIVATE}.thumbnail_worker_state set lease_until=now()-interval '1 second'")
    new_token = psql.run("set role service_role; " + acquire)
    check(new_token and new_token != token, "Interrupted invocation was not recovered")
    check(psql.run(f"select public.expedition_thumbnail_worker_release('{token}')") == "f", "Stale worker released a newer lease")
    check(psql.run(f"select public.expedition_thumbnail_worker_release('{new_token}')") == "t", "Current worker could not release")
    metrics = json.loads(psql.run("set role service_role; select public.expedition_thumbnail_worker_metrics()"))
    check(metrics["bucket_supported"] and metrics["last_sweep_at"], "Worker metrics omitted sweep state")
    check(psql.run("select has_function_privilege('anon','public.expedition_thumbnail_worker_acquire()','EXECUTE')") == "f",
          "Anonymous role can call the worker coordinator")
    psql.run(file=WORKER_ROLLBACK)
    print("PASS worker single lease, recovery, fenced release, fair dispatch, durable cursors, metrics and idempotent dry-run/backfill")


def plan_data(plan):
    def visit(node):
        yield node
        for child in node.get("Plans", []):
            yield from visit(child)
    return {"indexes": sorted({node["Index Name"] for node in visit(plan["Plan"]) if "Index Name" in node}),
            "buffers": plan["Plan"].get("Shared Hit Blocks", 0) + plan["Plan"].get("Shared Read Blocks", 0),
            "ms": round(plan["Execution Time"], 3)}


def cleanup_plans(psql):
    sql = CONTRACT.read_text(encoding="utf-8")
    hot = sql.split("create function public.expedition_thumbnail_claim_cleanup", 1)[1]
    hot = hot.split("for candidate in", 1)[1].split("\n  loop", 1)[0]
    hot = re.sub(r"\bcutoff\b", "statement_timestamp()", hot)
    hot = re.sub(r"\bp_limit\b", "8", hot)
    sweep = sql.split("create function public.expedition_thumbnail_reconcile_cleanup", 1)[1]
    sweep = sweep.split("for candidate in", 1)[1].split("\n  loop", 1)[0]
    sweep = re.sub(r"\bp_after\b", "'80000000-0000-0000-0000-000000000000'::uuid", sweep)
    sweep = re.sub(r"\bp_limit\b", "64", sweep)
    start = 1
    for rows in (10_000, 100_000):
        psql.run(f"""
          insert into {PRIVATE}.thumbnail_cleanup (attempt_id,media_id,processing_version,state,available_at,completed_at)
          select md5('history-' || n)::uuid, gen_random_uuid(), 1, 'done', now(), now()
          from generate_series({start},{rows}) n;
          analyze {PRIVATE}.thumbnail_cleanup;
        """)
        if start == 1:
            psql.run(f"""
              insert into {PRIVATE}.thumbnail_cleanup (attempt_id,media_id,processing_version,available_at)
              select gen_random_uuid(),gen_random_uuid(),1,now()-interval '1 hour' from generate_series(1,32);
              insert into {PRIVATE}.thumbnail_cleanup (attempt_id,media_id,processing_version,state,available_at,lease_token,lease_until)
              select gen_random_uuid(),gen_random_uuid(),1,'processing',now(),gen_random_uuid(),now()-interval '1 hour'
              from generate_series(1,32);
              analyze {PRIVATE}.thumbnail_cleanup;
            """)
        hot_plan = plan_data(json.loads(psql.run("explain (analyze,buffers,format json) " + hot))[0])
        sweep_plan = plan_data(json.loads(psql.run("explain (analyze,buffers,format json) " + sweep))[0])
        check("expedition_thumbnail_cleanup_done_idx" not in hot_plan["indexes"], "Hot cleanup used tombstone index")
        check("expedition_thumbnail_cleanup_done_idx" in sweep_plan["indexes"], "Tombstone sweep missed keyset index")
        check({"expedition_thumbnail_cleanup_pending_idx", "expedition_thumbnail_cleanup_processing_idx"}
              .issubset(hot_plan["indexes"]), "Hot cleanup missed a due-work index")
        print(json.dumps({"done_rows": rows, "hot_claim_plan": hot_plan, "bounded_done_sweep_plan": sweep_plan}))
        start = rows + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, required=True)
    parser.add_argument("--psql", type=Path, help="Compatible psql client when absent from bin-dir")
    parser.add_argument("--cluster", type=Path, required=True, help="fresh disposable initdb data directory")
    args = parser.parse_args()
    cluster = args.cluster.resolve(strict=True)
    binary = args.bin_dir.resolve(strict=True)
    suffix = ".exe" if os.name == "nt" else ""
    check((cluster / "PG_VERSION").is_file() and not (cluster / "postmaster.pid").exists(),
          "Expected an initialized, stopped disposable cluster")
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    with tempfile.TemporaryFile() as log:
        backend = subprocess.Popen([str(binary / f"postgres{suffix}"), "-D", str(cluster), "-h", "127.0.0.1",
                                    "-p", str(port), "-c", "max_connections=12", "-c", "ssl=off"], stdout=log, stderr=log)
        psql = Psql(args.psql.resolve(strict=True) if args.psql else binary / f"psql{suffix}", port)
        try:
            deadline = monotonic() + 8
            while monotonic() < deadline and backend.poll() is None:
                try:
                    observed = Path(psql.run("select current_setting('data_directory')", db="postgres"))
                    check(observed.resolve() == cluster, "Connected to a different cluster")
                    break
                except RuntimeError as exc:
                    if "different cluster" in str(exc):
                        raise
                    sleep(0.15)
            else:
                log.seek(0)
                raise RuntimeError(log.read(4000).decode(errors="replace"))
            check(psql.run("select count(*) from pg_database where datname not in ('postgres','template0','template1')", db="postgres") == "0",
                  "Refusing a cluster that already has a user database")
            print(psql.run("select version()", db="postgres"))
            check(psql.run("show default_transaction_isolation", db="postgres") == "read committed",
                  "Default transaction isolation must be READ COMMITTED")
            psql.run(f"create database {DATABASE}", db="postgres")
            for name in ("expedition_media_thumbnails_test_setup.sql", "expedition_projects.sql",
                         "expedition_project_media.sql"):
                psql.run(file=ROOT / "database" / name)
            # The standalone project fixture has no GPS/sharing deployment.
            psql.run("create table public.expedition_project_shares(project_id uuid primary key,is_enabled boolean not null)")
            preflight_failures(psql)
            psql.run("delete from storage.buckets where id='expedition-media-thumbnails'")
            catalog_before = json.loads(psql.run(file=CATALOG))
            psql.run(file=CONTRACT)
            installed = json.loads(psql.run(file=CATALOG))
            check(installed["baseline"] == catalog_before["baseline"], "Install changed the existing catalog")
            check(installed["thumbnails"]["bucket"] is None, "SQL created the bucket")
            psql.run("""
              insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
              values ('expedition-media-thumbnails','expedition-media-thumbnails',false,65536,array['image/webp']);
            """)
            before = rollback_state(psql)
            check(json.loads(before)[:9] == [0] * 9, "Disposable fixture baseline is not empty")
            result = psql.run(file=ROOT / "database/expedition_media_thumbnails_regression.sql")
            check(result == "thumbnail_contract_regression_passed|true", f"Unexpected regression result: {result}")
            check(rollback_state(psql) == before, "Rollback fixtures or catalog changes persisted")
            print(result)
            print("PASS zero persisted rollback fixtures")
            concurrency(psql)
            project_lease_cap(psql)
            worker_contract(psql)
            cleanup_plans(psql)
            psql.run("delete from storage.objects where bucket_id='expedition-media-thumbnails'; "
                     "delete from storage.buckets where id='expedition-media-thumbnails'")
            psql.run(file=ROLLBACK)
            check(json.loads(psql.run(file=CATALOG)) == catalog_before, "Manual rollback did not restore the catalog")
            print("PASS installed and rolled back the manual artifacts with exact catalog restoration")
        finally:
            if backend.poll() is None:
                try:
                    subprocess.run([str(binary / f"pg_ctl{suffix}"), "stop", "-D", str(cluster), "-m", "fast",
                                    "-w", "-t", "8"], capture_output=True, timeout=10)
                finally:
                    if backend.poll() is None:
                        try:
                            backend.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            backend.kill()
                            backend.wait(timeout=5)
            check(not (cluster / "postmaster.pid").exists(), "Disposable PostgreSQL backend did not shut down cleanly")


if __name__ == "__main__":
    main()
