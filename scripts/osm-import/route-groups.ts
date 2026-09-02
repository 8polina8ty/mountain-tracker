import type {
  RouteSimilarityClassification,
  RouteSimilarityResult,
} from "./route-similarity.ts";

export interface GroupableRoute {
  sourceId: string;
  name: string;
  qualityScore: number;
  metadataRichness: number;
}

export interface DuplicateGroupMember {
  sourceId: string;
  name: string;
  qualityScore: number;
  metadataRichness: number;
  relationshipToCanonical:
    | "CANONICAL"
    | "EXACT_DUPLICATE"
    | "NEAR_DUPLICATE"
    | "TRANSITIVE_DUPLICATE";
}

export interface DuplicateGroup {
  groupId: string;
  canonicalSourceId: string;
  canonicalName: string;
  memberSourceIds: string[];
  members: DuplicateGroupMember[];
  duplicateRelationships: Array<{
    sourceIdA: string;
    sourceIdB: string;
    classification: "EXACT_DUPLICATE" | "NEAR_DUPLICATE";
  }>;
  canonicalSelectionReasons: string[];
}

function isDuplicateClassification(
  classification: RouteSimilarityClassification,
): classification is "EXACT_DUPLICATE" | "NEAR_DUPLICATE" {
  return (
    classification === "EXACT_DUPLICATE" ||
    classification === "NEAR_DUPLICATE"
  );
}

function stableSourceIdCompare(left: string, right: string): number {
  return left.localeCompare(right, "en", { numeric: true });
}

function selectCanonical(routes: GroupableRoute[]): {
  canonical: GroupableRoute;
  reasons: string[];
} {
  const sorted = [...routes].sort(
    (left, right) =>
      right.qualityScore - left.qualityScore ||
      right.metadataRichness - left.metadataRichness ||
      stableSourceIdCompare(left.sourceId, right.sourceId),
  );
  const canonical = sorted[0];
  const highestQuality = Math.max(...routes.map((route) => route.qualityScore));
  const qualityTies = routes.filter(
    (route) => route.qualityScore === highestQuality,
  );
  const reasons = [`Highest Phase 3 quality score: ${canonical.qualityScore}.`];

  if (qualityTies.length > 1) {
    reasons.push(
      `Quality tie resolved by metadata richness (${canonical.metadataRichness}).`,
    );
    const highestRichness = Math.max(
      ...qualityTies.map((route) => route.metadataRichness),
    );
    if (
      qualityTies.filter(
        (route) => route.metadataRichness === highestRichness,
      ).length > 1
    ) {
      reasons.push(
        `Remaining tie resolved by stable source ID ${canonical.sourceId}.`,
      );
    }
  }

  return { canonical, reasons };
}

function pairKey(sourceIdA: string, sourceIdB: string): string {
  return [sourceIdA, sourceIdB].sort(stableSourceIdCompare).join(":");
}

export function buildDuplicateGroups(
  routes: GroupableRoute[],
  comparisons: RouteSimilarityResult[],
): { groups: DuplicateGroup[]; ungroupedSourceIds: string[] } {
  const routeById = new Map(routes.map((route) => [route.sourceId, route]));
  const adjacency = new Map<string, Set<string>>(
    routes.map((route) => [route.sourceId, new Set<string>()]),
  );
  const duplicateComparisonByPair = new Map<string, RouteSimilarityResult>();

  comparisons.forEach((comparison) => {
    if (!isDuplicateClassification(comparison.classification)) {
      return;
    }

    const sourceIdA = comparison.routeA.sourceId;
    const sourceIdB = comparison.routeB.sourceId;
    adjacency.get(sourceIdA)?.add(sourceIdB);
    adjacency.get(sourceIdB)?.add(sourceIdA);
    duplicateComparisonByPair.set(pairKey(sourceIdA, sourceIdB), comparison);
  });

  const visited = new Set<string>();
  const groups: DuplicateGroup[] = [];

  for (const route of [...routes].sort((left, right) =>
    stableSourceIdCompare(left.sourceId, right.sourceId),
  )) {
    if (visited.has(route.sourceId)) {
      continue;
    }

    const queue = [route.sourceId];
    const componentIds: string[] = [];
    visited.add(route.sourceId);

    while (queue.length > 0) {
      const sourceId = queue.shift();
      if (!sourceId) {
        continue;
      }

      componentIds.push(sourceId);
      for (const neighbor of adjacency.get(sourceId) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (componentIds.length < 2) {
      continue;
    }

    const componentRoutes = componentIds
      .map((sourceId) => routeById.get(sourceId))
      .filter((member): member is GroupableRoute => Boolean(member));
    const { canonical, reasons } = selectCanonical(componentRoutes);
    const relationships = comparisons
      .filter(
        (comparison) =>
          isDuplicateClassification(comparison.classification) &&
          componentIds.includes(comparison.routeA.sourceId) &&
          componentIds.includes(comparison.routeB.sourceId),
      )
      .map((comparison) => ({
        sourceIdA: comparison.routeA.sourceId,
        sourceIdB: comparison.routeB.sourceId,
        classification: comparison.classification as
          | "EXACT_DUPLICATE"
          | "NEAR_DUPLICATE",
      }));

    groups.push({
      groupId: `duplicate-${canonical.sourceId}`,
      canonicalSourceId: canonical.sourceId,
      canonicalName: canonical.name,
      memberSourceIds: componentRoutes
        .map((member) => member.sourceId)
        .sort(stableSourceIdCompare),
      members: componentRoutes
        .sort((left, right) => stableSourceIdCompare(left.sourceId, right.sourceId))
        .map((member) => {
          if (member.sourceId === canonical.sourceId) {
            return { ...member, relationshipToCanonical: "CANONICAL" as const };
          }

          const direct = duplicateComparisonByPair.get(
            pairKey(member.sourceId, canonical.sourceId),
          );
          return {
            ...member,
            relationshipToCanonical: direct
              ? (direct.classification as
                  | "EXACT_DUPLICATE"
                  | "NEAR_DUPLICATE")
              : ("TRANSITIVE_DUPLICATE" as const),
          };
        }),
      duplicateRelationships: relationships,
      canonicalSelectionReasons: reasons,
    });
  }

  groups.sort((left, right) =>
    stableSourceIdCompare(left.canonicalSourceId, right.canonicalSourceId),
  );
  const groupedIds = new Set(groups.flatMap((group) => group.memberSourceIds));

  return {
    groups,
    ungroupedSourceIds: routes
      .map((route) => route.sourceId)
      .filter((sourceId) => !groupedIds.has(sourceId))
      .sort(stableSourceIdCompare),
  };
}
