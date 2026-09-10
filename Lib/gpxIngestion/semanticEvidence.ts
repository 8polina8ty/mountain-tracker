import { createRouteDiscoverySignal, type RouteDiscoverySignal } from './routeDiscovery.ts';
import { normalizeSemanticName, elevationQualifierMeters, semanticNameParts, type SemanticNameQualifier } from './nameNormalization.ts';
import { sha256Stable } from './hashing.ts';
import { extractSignal, type Facts } from '../../scripts/gpx/phase12d-calibration.ts';

export const SEMANTIC_EVIDENCE_VERSION = 'mountain-tracker/semantic-evidence/v2';
export type EvidenceKind = 'START_NAME' | 'VIA_NAME' | 'SUMMIT_NAME' | 'TERMINAL_NAME' | 'ROUTE_VARIANT_NAME' | 'REGION_NAME' | 'FEATURE_TYPE_HINT' | 'ELEVATION_QUALIFIER' | 'ROUTE_SHAPE_HINT';
export interface SemanticEvidence {
  kind: EvidenceKind; sourceField: string; originalValue: string; normalizedValue: string;
  provenance: { source: 'openstreetmap'; relationId: string }; confidence: number; semanticOnly: true;
  identityName?: string; qualifiers?: SemanticNameQualifier[];
}
export function extractSemanticEvidence(relationId: string, facts: Facts): {
  version: string; evidence: SemanticEvidence[]; signal: RouteDiscoverySignal | null; reason: string | null; hash: string;
} {
  const evidence: SemanticEvidence[] = [];
  const add = (kind: EvidenceKind, sourceField: string, value: string | null | undefined) => {
    if (!value) return;
    if (value.length > 160 || /[<>\u0000-\u001f]/.test(value)) throw new Error('UNSAFE_OR_OVERSIZE_SEMANTIC_EVIDENCE');
    const parts = semanticNameParts(value);
    evidence.push({ kind, sourceField, originalValue: value, normalizedValue: normalizeSemanticName(value),
      identityName: parts.identityName, qualifiers: parts.qualifiers,
      provenance: { source: 'openstreetmap', relationId }, confidence: .8, semanticOnly: true });
    const elevation = elevationQualifierMeters(value);
    if (elevation !== null) evidence.push({ kind: 'ELEVATION_QUALIFIER', sourceField, originalValue: value,
      normalizedValue: String(elevation), provenance: { source: 'openstreetmap', relationId }, confidence: .9, semanticOnly: true });
  };
  let signal: RouteDiscoverySignal | null = null, reason: string | null = null;
  try {
    const tags = facts.relationTags;
    let titleField = 'name';
    let baseline = extractSignal(relationId, facts);
    if (!baseline.signal) for (const key of ['official_name', 'local_name', 'alt_name', 'ref']) {
      if (!tags[key]) continue;
      const attempt = extractSignal(relationId, { ...facts, relationTags: { ...tags, name: tags[key] } });
      if (attempt.signal) { baseline = attempt; titleField = key; break; }
    }
    signal = baseline.signal; reason = baseline.reason;
    if (signal) {
      const viaNames = (tags.via ?? '').split(';').map(s => s.trim()).filter(Boolean);
      if (viaNames.length > 8) throw new Error('VIA_EVIDENCE_LIMIT');
      const { schemaVersion: _schema, discoveryProvenance: _provenance, ...raw } = signal;
      void _schema; void _provenance;
      signal = createRouteDiscoverySignal({ ...raw, viaHints: viaNames.map(name => ({ name, expectedTypes: [], regionName: null })) });
      const startField = ['from', 'to'].find(k => tags[k] && normalizeSemanticName(tags[k]!) === normalizeSemanticName(signal!.startHint.name)) ?? titleField;
      add('START_NAME', `relation.${startField}`, tags[startField]);
      for (const name of viaNames) add('VIA_NAME', 'relation.via', name);
      add('SUMMIT_NAME', 'confirmedSummit.name', signal.summitHint.name);
      add('ROUTE_SHAPE_HINT', 'semantic summit-ascent direction', 'ONE_WAY');
    }
    for (const field of ['name', 'official_name', 'local_name', 'alt_name']) add('ROUTE_VARIANT_NAME', `relation.${field}`, tags[field]);
    add('FEATURE_TYPE_HINT', 'relation.route', tags.route);
    add('REGION_NAME', 'relation.is_in', tags.is_in);
  } catch (error) { signal = null; reason = (error as Error).message; }
  const content = { version: SEMANTIC_EVIDENCE_VERSION, evidence, signal, reason: signal ? null : reason ?? 'SEMANTIC_EVIDENCE_ABSENT' };
  return { ...content, hash: sha256Stable(content) };
}
