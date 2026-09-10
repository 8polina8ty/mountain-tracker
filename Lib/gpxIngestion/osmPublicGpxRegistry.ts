import type { SourceRightsPolicy } from "./types.ts";

export const OSM_PUBLIC_GPX_SOURCE_KEY = "openstreetmap-public-gpx";
export const OSM_PUBLIC_GPX_ADAPTER_VERSION = "phase12c-v1";
export const OSM_PUBLIC_GPX_MINIMUM_UPLOAD_AT = "2012-09-12T00:00:00.000Z";
export const OSM_PUBLIC_GPX_ATTRIBUTION = "© OpenStreetMap contributors";
export const OSM_PUBLIC_GPX_ATTRIBUTION_URL =
  "https://www.openstreetmap.org/copyright";
export const OSM_PUBLIC_GPX_API_HOST = "api.openstreetmap.org";
export const OSM_PUBLIC_GPX_STORAGE_HOST =
  "openstreetmap-gps-traces.s3.dualstack.eu-west-1.amazonaws.com";
export const OSM_PUBLIC_GPX_ALLOWED_HOSTS = [
  OSM_PUBLIC_GPX_API_HOST,
  OSM_PUBLIC_GPX_STORAGE_HOST,
] as const;

export const OSM_PUBLIC_GPX_RIGHTS_POLICY: Readonly<SourceRightsPolicy> = {
  licenseStatus: "ALLOWED",
  accessPermissionStatus: "ALLOWED",
  redistributionPermissionStatus: "ALLOWED",
  rawGpxRetentionPermission: "BLOCKED",
  normalizedGeometryPublicationPermission: "ALLOWED",
  attributionRequired: true,
  attributionText: OSM_PUBLIC_GPX_ATTRIBUTION,
  lastVerifiedAt: "2026-09-04T00:00:00.000Z",
};

export const OSM_PUBLIC_GPX_SOURCE_REGISTRY = {
  schemaVersion: "mountain-tracker/gpx-source-registry/v1",
  policyVersion: "openstreetmap-public-gpx-policy/v1",
  sourceKey: OSM_PUBLIC_GPX_SOURCE_KEY,
  sourceName: "OpenStreetMap Public GPS Traces",
  provider: "OpenStreetMap Foundation",
  homepageUrl: "https://www.openstreetmap.org/traces",
  geographicScope: "global",
  accessMethod: "API",
  apiBaseUrl: "https://api.openstreetmap.org/api/0.6",
  authentication: "NONE_FOR_PHASE12C_PUBLIC_ACCESS",
  discovery: "BOUNDED_SEED_MANIFEST",
  licensePolicy: "ALLOWED_WITH_DATE_GATE",
  licenseIdentifier: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  minimumAcceptedUploadAt: OSM_PUBLIC_GPX_MINIMUM_UPLOAD_AT,
  legacyTracePolicy: "BLOCKED_LEGACY_LICENSE",
  missingTimestampPolicy: "REVIEW_REQUIRED_LICENSE",
  acceptedVisibility: ["public", "identifiable"],
  rawRetention: "TEMPORARY_ONLY",
  normalizedPublication: "ALLOWED_WITH_ATTRIBUTION_AND_ODBL_OBLIGATIONS",
  attribution: {
    text: OSM_PUBLIC_GPX_ATTRIBUTION,
    url: OSM_PUBLIC_GPX_ATTRIBUTION_URL,
  },
  rightsPolicy: OSM_PUBLIC_GPX_RIGHTS_POLICY,
  allowedHosts: OSM_PUBLIC_GPX_ALLOWED_HOSTS,
  redirectPolicy:
    "Raw GPX may follow a revalidated redirect only to the dedicated OSM GPS trace bucket host.",
  largeScaleUse:
    "NOT_APPROVED; Phase 12M must select a sanctioned bulk acquisition mechanism.",
  liveAccessValidation: {
    checkedAt: "2026-09-04T19:26:36.098Z",
    status: "SOURCE_ACCESS_BLOCKED",
    evidenceArtifact:
      "data/gpx/phase12c/osm-public-gpx-smoke-result.json",
    note:
      "Anonymous metadata returned access denied; raw download remains prohibited until metadata and licence gates pass.",
  },
  policyEvidence: [
    "https://wiki.openstreetmap.org/wiki/API_v0.6#GPS_traces",
    "https://wiki.openstreetmap.org/wiki/Visibility_of_GPS_traces",
    "https://osmfoundation.org/wiki/Licensing_Working_Group/Minutes/2024-10-07#On_GPX_traces_and_the_OSM_data_licence_change",
    "https://osmfoundation.org/wiki/Licence/About_The_License_Change",
    "https://osmfoundation.org/wiki/Privacy_Policy#GPS_Trace_Data",
    OSM_PUBLIC_GPX_ATTRIBUTION_URL,
    "https://operations.osmfoundation.org/policies/api/",
  ],
} as const;
