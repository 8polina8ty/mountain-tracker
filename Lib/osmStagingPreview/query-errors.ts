export function isMissingPreviewQaSchemaError(error: {
  code?: string;
  message?: string;
}): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    /osm_staging_route_visual_qa.*(?:not found|does not exist)/i.test(error.message ?? "")
  );
}
