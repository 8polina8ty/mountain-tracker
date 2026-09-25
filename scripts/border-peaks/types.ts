// Bounded border-peaks pipeline types — offline, deterministic, no production writes
export type MountainRef = {
  id: number; // bigint in DB
  name: string | null;
  name_de: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primaryCountryCode: string | null; // mountains.country_code
};

export type ExistingMembership = {
  mountain_id: number;
  country_code: string;
  is_primary: boolean;
};

export type Classification = "CONFIRMED" | "REVIEW" | "REJECTED";

export type BorderCandidate = {
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  classification: Classification;
  // hardening evidence stages
  evidence_type: "CANDIDATE" | "GEOMETRICALLY_SUPPORTED" | "EXTERNALLY_VERIFIED" | "APPROVED" | null;
  boundary_source: string; // e.g., geoBoundaries gbOpen
  boundary_source_id: string | null; // feature id(s) of international border
  boundary_dataset_version: string | null;
  boundary_license: string | null;
  coordinate_precision_meters: number | null;
  boundary_precision_meters: number | null;
  distance_to_boundary_meters: number | null;
  supporting_external_reference: string | null; // e.g., OSM summit id — must be dual-country evidence, not just summit identity
  reason: string;
  review_notes: string | null;
  // approval gate for SQL export (editing JSONL alone cannot approve)
  approved_by?: string | null;
  approved_at?: string | null;
  reviewed_at?: string | null;
  // provenance for audit
  existing_memberships?: ExistingMembership[];
};

export type DiscoverySummary = {
  total_mountains_examined: number;
  near_border_candidates: number;
  confirmed: number;
  review: number;
  rejected: number;
  existing_memberships_skipped: number;
  source_conflicts: number;
  countries_covered: string[];
  per_country_pair: Record<string, number>; // e.g., "DE-AT": 12 (confirmed only)
  dataset: { provider: string; dataset: string; version: string } | null;
  generated_at: string;
};

export type ReviewDecision = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  decision: "APPROVE" | "REJECT";
  evidence_url: string;
  evidence_type: string; // e.g., "DUAL_COUNTRY_SURVEY", "OFFICIAL_BORDER_SOURCE", must not be summit-only
  evidence_notes?: string | null;
  reviewed_by: string;
  reviewed_at: string; // ISO
};
