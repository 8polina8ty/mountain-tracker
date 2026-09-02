import { DatabaseSync, type StatementSync } from "node:sqlite";

import type {
  BulkObjectStore,
  BulkRouteRecord,
} from "./bulk-route-reconstruction.ts";
import type { MatchablePeak } from "./peak-matcher.ts";
import type { OplRelation, OplWay } from "./opl-parser.ts";
import type { RouteAnalysisResult } from "./route-analysis.ts";

function parsePayload<T>(row: Record<string, unknown> | undefined): T | null {
  return row && typeof row.payload === "string"
    ? (JSON.parse(row.payload) as T)
    : null;
}

export class BulkSqliteStore implements BulkObjectStore {
  readonly database: DatabaseSync;
  private readonly putWayStatement: StatementSync;
  private readonly putRelationStatement: StatementSync;
  private readonly putPeakStatement: StatementSync;
  private readonly putRouteStatement: StatementSync;
  private readonly putAnalysisStatement: StatementSync;
  private readonly getWayStatement: StatementSync;
  private readonly getRelationStatement: StatementSync;
  private readonly getRouteStatement: StatementSync;
  private readonly getAnalysisStatement: StatementSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS ways (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS relations (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peaks (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
    this.putWayStatement = this.database.prepare(
      "INSERT OR REPLACE INTO ways (id, payload) VALUES (?, ?)",
    );
    this.putRelationStatement = this.database.prepare(
      "INSERT OR REPLACE INTO relations (id, payload) VALUES (?, ?)",
    );
    this.putPeakStatement = this.database.prepare(
      "INSERT OR REPLACE INTO peaks (id, payload) VALUES (?, ?)",
    );
    this.putRouteStatement = this.database.prepare(
      "INSERT OR REPLACE INTO routes (id, payload) VALUES (?, ?)",
    );
    this.putAnalysisStatement = this.database.prepare(
      "INSERT OR REPLACE INTO analyses (id, payload) VALUES (?, ?)",
    );
    this.getWayStatement = this.database.prepare(
      "SELECT payload FROM ways WHERE id = ?",
    );
    this.getRelationStatement = this.database.prepare(
      "SELECT payload FROM relations WHERE id = ?",
    );
    this.getRouteStatement = this.database.prepare(
      "SELECT payload FROM routes WHERE id = ?",
    );
    this.getAnalysisStatement = this.database.prepare(
      "SELECT payload FROM analyses WHERE id = ?",
    );
  }

  begin(): void {
    this.database.exec("BEGIN");
  }

  commit(): void {
    this.database.exec("COMMIT");
  }

  rollback(): void {
    this.database.exec("ROLLBACK");
  }

  putWay(way: OplWay): void {
    this.putWayStatement.run(way.id, JSON.stringify(way));
  }

  putRelation(relation: OplRelation): void {
    this.putRelationStatement.run(relation.id, JSON.stringify(relation));
  }

  putPeak(peak: MatchablePeak): void {
    this.putPeakStatement.run(Number(peak.sourceId), JSON.stringify(peak));
  }

  putRoute(route: BulkRouteRecord): void {
    this.putRouteStatement.run(route.sourceId, JSON.stringify(route));
  }

  putAnalysis(analysis: RouteAnalysisResult): void {
    this.putAnalysisStatement.run(
      analysis.routeSourceId,
      JSON.stringify(analysis),
    );
  }

  getWay(id: number): OplWay | null {
    return parsePayload<OplWay>(this.getWayStatement.get(id));
  }

  getRelation(id: number): OplRelation | null {
    return parsePayload<OplRelation>(this.getRelationStatement.get(id));
  }

  getRoute(id: string): BulkRouteRecord | null {
    return parsePayload<BulkRouteRecord>(this.getRouteStatement.get(id));
  }

  getAnalysis(id: string): RouteAnalysisResult | null {
    return parsePayload<RouteAnalysisResult>(this.getAnalysisStatement.get(id));
  }

  close(): void {
    this.database.close();
  }
}
