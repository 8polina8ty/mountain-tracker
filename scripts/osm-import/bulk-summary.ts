import type {
  FinalAssociationResult,
  FinalSummitAssociation,
  RouteAnalysisResult,
} from "./route-analysis.ts";
import type { RouteSemanticType } from "./route-classifier.ts";
import type {
  RouteSimilarityClassification,
  RouteSimilarityResult,
} from "./route-similarity.ts";

export const BULK_DIAGNOSTIC_SAMPLE_LIMIT = 25;

const ASSOCIATION_CLASSIFICATIONS: FinalSummitAssociation[] = [
  "CONFIRMED",
  "REVIEW",
  "REJECTED",
];
const SEMANTIC_TYPES: RouteSemanticType[] = [
  "summit_route",
  "long_distance_trail",
  "via_ferrata",
  "local_hike",
  "approach",
  "unknown",
];
const SIMILARITY_CLASSIFICATIONS: RouteSimilarityClassification[] = [
  "EXACT_DUPLICATE",
  "NEAR_DUPLICATE",
  "SAME_VARIANT",
  "DIFFERENT_VARIANT",
  "UNRELATED",
];

type AssociationCounts = Record<FinalSummitAssociation, number>;
type SimilarityCounts = Record<RouteSimilarityClassification, number>;

export interface AssociationDiagnosticSample {
  routeSourceId: string;
  routeName: string;
  semanticType: RouteSemanticType;
  routeQualityScore: number;
  peakSourceId: string;
  peakName: string | null;
  peakElevationMeters: number | null;
  minimumGeometryDistanceMeters: number;
  endpointDistanceMeters: number;
  finalConfidence: number;
  reasons: string[];
}

export interface SimilarityDiagnosticSample {
  routeA: { sourceId: string; name: string };
  routeB: { sourceId: string; name: string };
  classification: RouteSimilarityClassification;
  confidence: number;
  approximateShapeSimilarity: number;
  symmetricCoverage: number;
  coverageAByB: number;
  coverageBByA: number;
  lengthRatio: number;
  endpointScore: number;
  sharedConfirmedSummitIds: string[];
  sharedAssociatedSummitIds: string[];
  reasons: string[];
}

export interface BulkSummaryObservability {
  summitAssociations: AssociationCounts;
  routesBySummitAssociation: {
    withConfirmedSummit: number;
    withExactlyOneConfirmedSummit: number;
    withMultipleConfirmedSummits: number;
    withReviewButNoConfirmed: number;
    withNoConfirmedOrReview: number;
    averageConfirmedAssociationsPerRouteWithConfirmed: number;
    maximumConfirmedSummitsOnOneRoute: number;
  };
  semanticAssociationCrossTab: Record<RouteSemanticType, AssociationCounts>;
  similarityClassifications: SimilarityCounts;
  diagnosticSamples: {
    limitPerCategory: number;
    confirmedAssociations: AssociationDiagnosticSample[];
    reviewAssociations: AssociationDiagnosticSample[];
    highestSimilarityNonDuplicatePairs: SimilarityDiagnosticSample[];
  };
}

function associationCounts(): AssociationCounts {
  return Object.fromEntries(
    ASSOCIATION_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as AssociationCounts;
}

function similarityCounts(): SimilarityCounts {
  return Object.fromEntries(
    SIMILARITY_CLASSIFICATIONS.map((classification) => [classification, 0]),
  ) as SimilarityCounts;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAssociationSamples(
  left: AssociationDiagnosticSample,
  right: AssociationDiagnosticSample,
): number {
  return (
    right.finalConfidence - left.finalConfidence ||
    left.minimumGeometryDistanceMeters - right.minimumGeometryDistanceMeters ||
    left.endpointDistanceMeters - right.endpointDistanceMeters ||
    compareText(left.routeSourceId, right.routeSourceId) ||
    compareText(left.peakSourceId, right.peakSourceId)
  );
}

function compareSimilaritySamples(
  left: SimilarityDiagnosticSample,
  right: SimilarityDiagnosticSample,
): number {
  return (
    right.approximateShapeSimilarity - left.approximateShapeSimilarity ||
    right.symmetricCoverage - left.symmetricCoverage ||
    right.confidence - left.confidence ||
    compareText(left.routeA.sourceId, right.routeA.sourceId) ||
    compareText(left.routeB.sourceId, right.routeB.sourceId)
  );
}

function retainTop<T>(
  samples: T[],
  sample: T,
  compare: (left: T, right: T) => number,
): void {
  samples.push(sample);
  samples.sort(compare);
  if (samples.length > BULK_DIAGNOSTIC_SAMPLE_LIMIT) {
    samples.length = BULK_DIAGNOSTIC_SAMPLE_LIMIT;
  }
}

function associationSample(
  analysis: RouteAnalysisResult,
  association: FinalAssociationResult,
): AssociationDiagnosticSample {
  return {
    routeSourceId: analysis.routeSourceId,
    routeName: analysis.routeName,
    semanticType: analysis.semanticType,
    routeQualityScore: analysis.qualityScore,
    peakSourceId: association.peakSourceId,
    peakName: association.peakName,
    peakElevationMeters: association.peakElevation,
    minimumGeometryDistanceMeters: association.minDistanceMeters,
    endpointDistanceMeters: association.endpointDistanceMeters,
    finalConfidence: association.finalConfidence,
    reasons: [...association.reasons],
  };
}

function similaritySample(
  comparison: RouteSimilarityResult,
): SimilarityDiagnosticSample {
  return {
    routeA: { ...comparison.routeA },
    routeB: { ...comparison.routeB },
    classification: comparison.classification,
    confidence: comparison.confidence,
    approximateShapeSimilarity:
      comparison.metrics.approximateShapeSimilarity,
    symmetricCoverage: comparison.metrics.symmetricCoverage,
    coverageAByB: comparison.metrics.coverageAByB,
    coverageBByA: comparison.metrics.coverageBByA,
    lengthRatio: comparison.metrics.lengthRatio,
    endpointScore: comparison.metrics.endpointScore,
    sharedConfirmedSummitIds: [
      ...comparison.metrics.sharedConfirmedSummitIds,
    ],
    sharedAssociatedSummitIds: [
      ...comparison.metrics.sharedAssociatedSummitIds,
    ],
    reasons: [...comparison.reasons],
  };
}

export class BulkSummaryCollector {
  private readonly summitAssociations = associationCounts();
  private readonly semanticAssociationCrossTab = Object.fromEntries(
    SEMANTIC_TYPES.map((semanticType) => [semanticType, associationCounts()]),
  ) as Record<RouteSemanticType, AssociationCounts>;
  private readonly similarityClassifications = similarityCounts();
  private readonly confirmedAssociations: AssociationDiagnosticSample[] = [];
  private readonly reviewAssociations: AssociationDiagnosticSample[] = [];
  private readonly highestSimilarityNonDuplicatePairs: SimilarityDiagnosticSample[] =
    [];
  private routesWithConfirmedSummit = 0;
  private routesWithExactlyOneConfirmedSummit = 0;
  private routesWithMultipleConfirmedSummits = 0;
  private routesWithReviewButNoConfirmed = 0;
  private routesWithNoConfirmedOrReview = 0;
  private maximumConfirmedSummitsOnOneRoute = 0;

  addRouteAnalysis(analysis: RouteAnalysisResult): void {
    let confirmed = 0;
    let review = 0;
    for (const association of analysis.summitAssociations) {
      this.summitAssociations[association.finalAssociation] += 1;
      this.semanticAssociationCrossTab[analysis.semanticType][
        association.finalAssociation
      ] += 1;
      if (association.finalAssociation === "CONFIRMED") {
        confirmed += 1;
        retainTop(
          this.confirmedAssociations,
          associationSample(analysis, association),
          compareAssociationSamples,
        );
      } else if (association.finalAssociation === "REVIEW") {
        review += 1;
        retainTop(
          this.reviewAssociations,
          associationSample(analysis, association),
          compareAssociationSamples,
        );
      }
    }

    if (confirmed > 0) {
      this.routesWithConfirmedSummit += 1;
      if (confirmed === 1) {
        this.routesWithExactlyOneConfirmedSummit += 1;
      } else {
        this.routesWithMultipleConfirmedSummits += 1;
      }
      this.maximumConfirmedSummitsOnOneRoute = Math.max(
        this.maximumConfirmedSummitsOnOneRoute,
        confirmed,
      );
    } else if (review > 0) {
      this.routesWithReviewButNoConfirmed += 1;
    } else {
      this.routesWithNoConfirmedOrReview += 1;
    }
  }

  addSimilarity(comparison: RouteSimilarityResult): void {
    this.similarityClassifications[comparison.classification] += 1;
    if (
      comparison.classification !== "EXACT_DUPLICATE" &&
      comparison.classification !== "NEAR_DUPLICATE"
    ) {
      retainTop(
        this.highestSimilarityNonDuplicatePairs,
        similaritySample(comparison),
        compareSimilaritySamples,
      );
    }
  }

  build(): BulkSummaryObservability {
    return {
      summitAssociations: { ...this.summitAssociations },
      routesBySummitAssociation: {
        withConfirmedSummit: this.routesWithConfirmedSummit,
        withExactlyOneConfirmedSummit:
          this.routesWithExactlyOneConfirmedSummit,
        withMultipleConfirmedSummits: this.routesWithMultipleConfirmedSummits,
        withReviewButNoConfirmed: this.routesWithReviewButNoConfirmed,
        withNoConfirmedOrReview: this.routesWithNoConfirmedOrReview,
        averageConfirmedAssociationsPerRouteWithConfirmed:
          this.routesWithConfirmedSummit === 0
            ? 0
            : Number(
                (
                  this.summitAssociations.CONFIRMED /
                  this.routesWithConfirmedSummit
                ).toFixed(2),
              ),
        maximumConfirmedSummitsOnOneRoute:
          this.maximumConfirmedSummitsOnOneRoute,
      },
      semanticAssociationCrossTab: Object.fromEntries(
        SEMANTIC_TYPES.map((semanticType) => [
          semanticType,
          { ...this.semanticAssociationCrossTab[semanticType] },
        ]),
      ) as Record<RouteSemanticType, AssociationCounts>,
      similarityClassifications: { ...this.similarityClassifications },
      diagnosticSamples: {
        limitPerCategory: BULK_DIAGNOSTIC_SAMPLE_LIMIT,
        confirmedAssociations: this.confirmedAssociations.map((sample) => ({
          ...sample,
          reasons: [...sample.reasons],
        })),
        reviewAssociations: this.reviewAssociations.map((sample) => ({
          ...sample,
          reasons: [...sample.reasons],
        })),
        highestSimilarityNonDuplicatePairs:
          this.highestSimilarityNonDuplicatePairs.map((sample) => ({
            ...sample,
            routeA: { ...sample.routeA },
            routeB: { ...sample.routeB },
            sharedConfirmedSummitIds: [...sample.sharedConfirmedSummitIds],
            sharedAssociatedSummitIds: [...sample.sharedAssociatedSummitIds],
            reasons: [...sample.reasons],
          })),
      },
    };
  }
}
