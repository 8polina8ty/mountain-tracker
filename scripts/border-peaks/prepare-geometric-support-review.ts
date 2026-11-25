#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
type ProbeStatus = "VERIFIED" | "GEOMETRIC_SUPPORT" | "CONFLICT" | "INSUFFICIENT" | "ERROR";
type ReviewTier = "HIGH_CONFIDENCE_REVIEW" | "STANDARD_REVIEW" | "THIRD_SOURCE_RECOMMENDED";

type StrongRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
};

type DecisionRow = StrongRow & {
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
};

type ProbeEvidence = {
  candidate_hash: string;
  mountain_id: number;
  status: ProbeStatus;
  mode?: "CENTER" | "PROBE";
  queried_at?: string;
  endpoint?: string;
  center_country_codes?: string[];
  probe_country_codes?: string[];
  osm_peak?: {
    id: number;
    lat: number;
    lon: number;
    distance_meters: number;
    name: string | null;
    wikidata: string | null;
  } | null;
  notes?: string;
};

type EnrichedRow = StrongRow & {
  review_tier: ReviewTier;
  review_reasons: string[];
  evidence_source: string;
  probe_status: ProbeStatus;
  probe_queried_at: string | null;
  center_country_codes: string[];
  probe_country_codes: string[];
  osm_peak_distance_meters: number | null;
  osm_peak_name: string | null;
  osm_peak_wikidata: string | null;
  decision: null;
  reviewed_by: null;
  reviewed_at: null;
};

function arg(name:string,fallback:string){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;}
function readJsonl<T>(path:string,required=true):T[]{if(!existsSync(path)){if(required)throw new Error(`Required file is missing: ${path}`);return [];}const raw=readFileSync(path,"utf8").trim();return raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function writeJsonl(path:string,rows:unknown[]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,rows.length?`${rows.map(r=>JSON.stringify(r)).join("\n")}\n`:"");}
function ts(row:ProbeEvidence){const v=row.queried_at?Date.parse(row.queried_at):0;return Number.isFinite(v)?v:0;}
function rank(status:ProbeStatus){return status==="VERIFIED"?5:status==="GEOMETRIC_SUPPORT"?4:status==="INSUFFICIENT"?3:status==="CONFLICT"?2:1;}

function main(){
 const strongPath=arg("--strong","data/border-peaks/global-review/strong-human-review.jsonl");
 const decisionsPath=arg("--decisions","data/border-peaks/global-review/strong-review-decisions.jsonl");
 const outDir=arg("--output-dir","data/border-peaks/global-review/geometric-support");
 const strong=readJsonl<StrongRow>(strongPath);
 const decisions=readJsonl<DecisionRow>(decisionsPath);
 if(strong.length!==1372||decisions.length!==1372)throw new Error(`Expected 1372 strong/decision rows, found ${strong.length}/${decisions.length}`);
 const strongByHash=new Map(strong.map(r=>[r.candidate_hash,r]));
 const pending=decisions.filter(r=>r.decision===null);
 const pendingGeo=pending.filter(r=>r.final_machine_status==="GEOMETRIC_SUPPORT");
 const completedTier1=decisions.filter(r=>r.decision==="APPROVE"&&r.final_machine_status==="TIER1_VERIFIED");
 if(completedTier1.length!==819||pending.length!==553||pendingGeo.length!==553)throw new Error(`Expected 819 approved TIER1 and exactly 553 pending GEOMETRIC_SUPPORT; found approvedTier1=${completedTier1.length}, pending=${pending.length}, pendingGeo=${pendingGeo.length}`);
 for(const r of pendingGeo){const q=strongByHash.get(r.candidate_hash);if(!q||q.mountain_id!==r.mountain_id||q.pair!==r.pair)throw new Error(`Strong queue mismatch for ${r.candidate_hash.slice(0,12)}…`);if(r.reviewed_by!=null||r.reviewed_at!=null||r.review_notes!=null||r.decision_batch_id!=null)throw new Error(`Pending GEOMETRIC_SUPPORT row has reviewer metadata for ${r.candidate_hash.slice(0,12)}…`);}

 const sources=[
  ["tier2","data/border-peaks/global-verification/osm-evidence-tier2.jsonl"],
  ["tier2b-retry","data/border-peaks/global-verification/osm-evidence-tier2b-retry.jsonl"],
  ["tier2c-priority","data/border-peaks/global-verification/osm-evidence-tier2c.jsonl"],
  ["tier2c-errors","data/border-peaks/global-verification/osm-evidence-tier2c-errors.jsonl"],
  ["v2-delta-probe","data/border-peaks/global-verification/osm-evidence-v2-delta-probe.jsonl"],
  ["technical-probe-retry","data/border-peaks/global-verification/osm-evidence-technical-probe.jsonl"],
 ] as const;

 const evidenceByHash=new Map<string,Array<{source:string;row:ProbeEvidence}>>();
 for(const [source,path] of sources){for(const row of readJsonl<ProbeEvidence>(path,false)){if(row.mode&&row.mode!=="PROBE")continue;const arr=evidenceByHash.get(row.candidate_hash)??[];arr.push({source,row});evidenceByHash.set(row.candidate_hash,arr);}}

 const enriched:EnrichedRow[]=pendingGeo.map(decision=>{
  const base=strongByHash.get(decision.candidate_hash)!;
  const candidates=(evidenceByHash.get(decision.candidate_hash)??[]).filter(({row})=>row.status==="VERIFIED"||row.status==="GEOMETRIC_SUPPORT");
  if(candidates.length===0)throw new Error(`No successful probe evidence found for GEOMETRIC_SUPPORT ${decision.candidate_hash.slice(0,12)}…`);
  candidates.sort((a,b)=>rank(b.row.status)-rank(a.row.status)||ts(b.row)-ts(a.row));
  const best=candidates[0];
  const peak=best.row.osm_peak??null;
  const dist=base.distance_to_boundary_meters;
  const peakDist=peak?.distance_meters??null;
  const reasons:string[]=[];
  let reviewTier:ReviewTier;
  if(dist!=null&&dist<=30&&peakDist!=null&&peakDist<=10&&(peak?.name||peak?.wikidata)){
    reviewTier="HIGH_CONFIDENCE_REVIEW";
    reasons.push("geoBoundaries distance <=30m","OSM peak identity <=10m","OSM peak has name or Wikidata identity","successful dual-country probe evidence");
  }else if((dist!=null&&dist<=100)||(peakDist!=null&&peakDist<=25)){
    reviewTier="STANDARD_REVIEW";
    if(dist!=null&&dist<=100)reasons.push("geoBoundaries distance <=100m");
    if(peakDist!=null&&peakDist<=25)reasons.push("OSM peak identity <=25m");
    reasons.push("successful dual-country probe evidence");
  }else{
    reviewTier="THIRD_SOURCE_RECOMMENDED";
    reasons.push("successful probe evidence exists but summit-level identity/boundary proximity is weaker");
    if(dist==null||dist>100)reasons.push("geoBoundaries distance >100m or unavailable");
    if(peakDist==null||peakDist>25)reasons.push("no OSM peak identity within 25m");
  }
  return {...base,review_tier:reviewTier,review_reasons:reasons,evidence_source:best.source,probe_status:best.row.status,probe_queried_at:best.row.queried_at??null,center_country_codes:best.row.center_country_codes??[],probe_country_codes:best.row.probe_country_codes??[],osm_peak_distance_meters:peakDist,osm_peak_name:peak?.name??null,osm_peak_wikidata:peak?.wikidata??null,decision:null,reviewed_by:null,reviewed_at:null};
 });

 const tierRank=(t:ReviewTier)=>t==="HIGH_CONFIDENCE_REVIEW"?0:t==="STANDARD_REVIEW"?1:2;
 enriched.sort((a,b)=>tierRank(a.review_tier)-tierRank(b.review_tier)||(a.distance_to_boundary_meters??Infinity)-(b.distance_to_boundary_meters??Infinity)||a.mountain_id-b.mountain_id||a.candidate_country_code.localeCompare(b.candidate_country_code));

 if(existsSync(outDir))rmSync(outDir,{recursive:true,force:true});
 mkdirSync(outDir,{recursive:true});
 writeJsonl(join(outDir,"all.jsonl"),enriched);
 for(const tier of ["HIGH_CONFIDENCE_REVIEW","STANDARD_REVIEW","THIRD_SOURCE_RECOMMENDED"] as const)writeJsonl(join(outDir,`${tier.toLowerCase()}.jsonl`),enriched.filter(r=>r.review_tier===tier));

 const summary={
  generated_at:new Date().toISOString(),
  total_rows:enriched.length,
  unique_mountains:new Set(enriched.map(r=>r.mountain_id)).size,
  tiers:{
   HIGH_CONFIDENCE_REVIEW:enriched.filter(r=>r.review_tier==="HIGH_CONFIDENCE_REVIEW").length,
   STANDARD_REVIEW:enriched.filter(r=>r.review_tier==="STANDARD_REVIEW").length,
   THIRD_SOURCE_RECOMMENDED:enriched.filter(r=>r.review_tier==="THIRD_SOURCE_RECOMMENDED").length,
  },
  outputs:{all:join(outDir,"all.jsonl"),high_confidence:join(outDir,"high_confidence_review.jsonl"),standard:join(outDir,"standard_review.jsonl"),third_source_recommended:join(outDir,"third_source_recommended.jsonl")},
  safety:"Evidence enrichment and triage only. All 553 GEOMETRIC_SUPPORT rows remain undecided. No APPROVE/REJECT, SQL, or database writes are performed."
 };
 writeFileSync(join(outDir,"summary.json"),JSON.stringify(summary,null,2));
 process.stdout.write(JSON.stringify(summary,null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
