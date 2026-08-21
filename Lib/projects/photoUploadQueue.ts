export const PROJECT_PHOTO_UPLOAD_CONCURRENCY = 3;
export const PROJECT_MEDIA_UPLOAD_CONCURRENCY = PROJECT_PHOTO_UPLOAD_CONCURRENCY;

export async function runBoundedPhotoUploads<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = PROJECT_PHOTO_UPLOAD_CONCURRENCY,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) {
    throw new Error("Photo upload concurrency must be between 1 and 3.");
  }
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function consume() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  return results;
}

export const runBoundedMediaUploads = runBoundedPhotoUploads;
