export const SUPABASE_IN_QUERY_CHUNK_SIZE = 75;

export interface ChunkedQueryErrorLike {
  code?: string;
  message?: string;
}

export interface ChunkedQueryResult<TRow> {
  data: TRow[] | null;
  error: ChunkedQueryErrorLike | null;
}

export interface LoadChunkedInQueryOptions<TValue extends string | number, TRow> {
  values: readonly TValue[];
  queryLabel: string;
  loadChunk: (values: readonly TValue[]) => PromiseLike<ChunkedQueryResult<TRow>>;
  rowIdentity: (row: TRow) => string;
  chunkSize?: number;
}

function safeQueryErrorMessage(error: ChunkedQueryErrorLike): string {
  const message = error.message?.trim() || "Unknown database query error.";
  return message.replace(/https?:\/\/\S+/gi, "[redacted URL]").slice(0, 500);
}

export class ChunkedInQueryError extends Error {
  readonly queryErrorCode?: string;
  readonly queryErrorMessage: string;
  readonly chunkNumber: number;
  readonly chunkCount: number;
  readonly valueCount: number;

  constructor(input: {
    queryLabel: string;
    queryError: ChunkedQueryErrorLike;
    chunkNumber: number;
    chunkCount: number;
    valueCount: number;
  }) {
    const queryErrorMessage = safeQueryErrorMessage(input.queryError);
    super(
      `${input.queryLabel} failed for chunk ${input.chunkNumber}/${input.chunkCount} ` +
        `(${input.valueCount} values): ${queryErrorMessage}`,
    );
    this.name = "ChunkedInQueryError";
    this.queryErrorCode = input.queryError.code || undefined;
    this.queryErrorMessage = queryErrorMessage;
    this.chunkNumber = input.chunkNumber;
    this.chunkCount = input.chunkCount;
    this.valueCount = input.valueCount;
  }
}

export async function loadChunkedInQuery<TValue extends string | number, TRow>(
  options: LoadChunkedInQueryOptions<TValue, TRow>,
): Promise<TRow[]> {
  const chunkSize = options.chunkSize ?? SUPABASE_IN_QUERY_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`${options.queryLabel} has an invalid chunk size.`);
  }
  if (new Set(options.values).size !== options.values.length) {
    throw new Error(`${options.queryLabel} contains duplicate query values.`);
  }
  if (options.values.length === 0) return [];

  const chunkCount = Math.ceil(options.values.length / chunkSize);
  const rows: TRow[] = [];
  const identities = new Set<string>();
  for (let offset = 0; offset < options.values.length; offset += chunkSize) {
    const values = options.values.slice(offset, offset + chunkSize);
    const chunkNumber = Math.floor(offset / chunkSize) + 1;
    const result = await options.loadChunk(values);
    if (result.error) {
      throw new ChunkedInQueryError({
        queryLabel: options.queryLabel,
        queryError: result.error,
        chunkNumber,
        chunkCount,
        valueCount: values.length,
      });
    }
    for (const row of result.data ?? []) {
      const identity = options.rowIdentity(row);
      if (identities.has(identity)) {
        throw new Error(`${options.queryLabel} returned duplicate row identity ${identity}.`);
      }
      identities.add(identity);
      rows.push(row);
    }
  }
  return rows;
}
