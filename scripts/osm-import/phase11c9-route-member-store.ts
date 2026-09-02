import { DatabaseSync } from "node:sqlite";

import type { OplRelation, OplWay } from "./opl-parser.ts";
import type { RoadSafetyWay } from "./phase11c9-road-safety.ts";

function payload<T>(row: Record<string, unknown> | undefined): T | null {
  return row && typeof row.payload === "string"
    ? JSON.parse(row.payload) as T
    : null;
}

export class FrozenRouteMemberStore {
  private readonly database: DatabaseSync;
  private readonly getRelationStatement;
  private readonly getWayStatement;

  constructor(path: string) {
    const ReadOnlyDatabase = DatabaseSync as unknown as new (
      databasePath: string,
      options: { readOnly: boolean },
    ) => DatabaseSync;
    this.database = new ReadOnlyDatabase(path, { readOnly: true });
    this.getRelationStatement = this.database.prepare(
      "SELECT payload FROM relations WHERE id = ?",
    );
    this.getWayStatement = this.database.prepare(
      "SELECT payload FROM ways WHERE id = ?",
    );
  }

  getRelation(id: number): OplRelation | null {
    return payload<OplRelation>(this.getRelationStatement.get(id));
  }

  getWay(id: number): OplWay | null {
    return payload<OplWay>(this.getWayStatement.get(id));
  }

  routeWays(relationIds: string[]): RoadSafetyWay[] {
    const ways = new Map<number, RoadSafetyWay>();
    const expandedRelations = new Set<number>();

    const expand = (relationId: number, stack: Set<number>): void => {
      if (stack.has(relationId)) {
        throw new Error(`PHASE11C9_CYCLIC_RELATION:${relationId}`);
      }
      if (expandedRelations.has(relationId)) return;
      const relation = this.getRelation(relationId);
      if (!relation) throw new Error(`PHASE11C9_RELATION_MISSING:${relationId}`);
      const nextStack = new Set(stack).add(relationId);
      for (const member of relation.members) {
        if (member.type === "relation") {
          expand(member.ref, nextStack);
          continue;
        }
        if (member.type !== "way") continue;
        const way = this.getWay(member.ref);
        if (!way) throw new Error(`PHASE11C9_WAY_MISSING:${member.ref}`);
        const nodes = way.nodes.map((node) => {
          if (!node.coordinate) {
            throw new Error(
              `PHASE11C9_WAY_NODE_LOCATION_MISSING:${way.id}:${node.nodeId}`,
            );
          }
          return { nodeId: node.nodeId, coordinate: node.coordinate };
        });
        ways.set(way.id, { id: way.id, tags: way.tags, nodes });
      }
      expandedRelations.add(relationId);
    };

    for (const relationId of [...new Set(relationIds)].sort(
      (left, right) => Number(left) - Number(right),
    )) {
      expand(Number(relationId), new Set());
    }
    return [...ways.values()].sort((left, right) => left.id - right.id);
  }

  close(): void {
    this.database.close();
  }
}
