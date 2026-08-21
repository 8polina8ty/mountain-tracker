export type ProjectMediaFailureStage =
  | "auth"
  | "ownership-query"
  | "file-validation"
  | "storage-upload"
  | "metadata-insert"
  | "compensation-delete"
  | "media-delete-storage"
  | "media-delete-metadata"
  | "journal-media-cleanup";

export type ProjectMediaDiagnostic = {
  stage: ProjectMediaFailureStage;
  safeCode: string | null;
  status: string | number | null;
  cleanupSucceeded: boolean | null;
  retryable: boolean;
};

type ProjectMediaDisplayDiagnostic = Record<string, number | boolean>;

type SafeErrorLike = { code?: unknown; status?: unknown; statusCode?: unknown };

function safeScalar(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[a-z0-9_-]{1,32}$/i.test(value)) return value;
  return null;
}

export function createProjectMediaDiagnostic(
  stage: ProjectMediaFailureStage,
  error: unknown,
  retryable: boolean,
  cleanupSucceeded: boolean | null = null,
): ProjectMediaDiagnostic | undefined {
  if (process.env.NODE_ENV !== "development") return undefined;
  const safeError = error as SafeErrorLike | null;
  const diagnostic: ProjectMediaDiagnostic = {
    stage,
    safeCode: String(safeScalar(safeError?.code) ?? safeScalar(safeError?.statusCode) ?? safeScalar(safeError?.status) ?? "") || null,
    status: safeScalar(safeError?.status) ?? safeScalar(safeError?.statusCode),
    cleanupSucceeded,
    retryable,
  };
  console.info("[ProjectMedia DEV]", diagnostic);
  return diagnostic;
}

export function logProjectMediaDisplayDiagnostic(
  boundary: "query" | "normalized" | "delivery" | "journal",
  diagnostic: ProjectMediaDisplayDiagnostic,
): void {
  if (process.env.NODE_ENV !== "development") return;
  console.info(`[ProjectMediaDisplay DEV][${boundary}]`, diagnostic);
}
