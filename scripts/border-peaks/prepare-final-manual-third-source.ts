#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type ManualRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  latitude: number;
  longitude: number;
  height: number | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  distance_to_boundary_meters: number | null;
  named_review_tier: "STANDARD_MANUAL_REVIEW";
  named_review_reasons: string[];
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
};

type EvidenceRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: null;
  source_url: null;
  source_type: null;
  source_title: null;
  source_authority: null;
  evidence_notes: null;
  checked_by: null;
  checked_at: null;
};

function arg(name:string,fallback:string){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;}
function readJsonl<T>(path:string):T[]{if(!existsSync(path))throw new Error(`Required file is missing: ${path}`);const raw=readFileSync(path,"utf8").trim();return raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function writeJsonl(path:string,rows:unknown[]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,rows.length?`${rows.map(r=>JSON.stringify(r)).join("\n")}\n`:"");}

function main(){
  const manualPath=arg("--manual","data/border-peaks/global-review/geometric-support/named-standard/manual.jsonl");
  const decisionsPath=arg("--decisions","data/border-peaks/global-review/strong-review-decisions.jsonl");
  const investigationPath=arg("--investigation-output","data/border-peaks/global-review/final-manual-third-source-investigation.jsonl");
  const evidencePath=arg("--evidence-output","data/border-peaks/global-review/final-manual-third-source-evidence.jsonl");

  const manual=readJsonl<ManualRow>(manualPath);
  const decisions=readJsonl<DecisionRow>(decisionsPath);
  if(manual.length!==9)throw new Error(`Expected 9 manual rows, found ${manual.length}`);
  if(decisions.length!==1372)throw new Error(`Expected 1372 decision rows, found ${decisions.length}`);

  const pending=decisions.filter(r=>r.decision===null);
  if(pending.length!==9)throw new Error(`Expected exactly 9 pending decisions, found ${pending.length}`);
  const pendingByHash=new Map(pending.map(r=>[r.candidate_hash,r]));
  const seen=new Set<string>();

  const investigation=manual.map((row,index)=>{
    if(seen.has(row.candidate_hash))throw new Error("Duplicate manual candidate hash");
    seen.add(row.candidate_hash);
    if(row.named_review_tier!=="STANDARD_MANUAL_REVIEW")throw new Error("Unexpected manual tier");
    if(!row.primary_country_code)throw new Error(`Missing primary country for mountain ${row.mountain_id}`);
    const d=pendingByHash.get(row.candidate_hash);
    if(!d||d.mountain_id!==row.mountain_id)throw new Error(`Pending decision mismatch for ${row.candidate_hash.slice(0,12)}…`);
    if(d.reviewed_by!=null||d.reviewed_at!=null||d.review_notes!=null||d.decision_batch_id!=null)throw new Error("Pending row has reviewer metadata");
    return {
      candidate_hash:row.candidate_hash,
      mountain_id:row.mountain_id,
      mountain_name:row.mountain_name,
      latitude:row.latitude,
      longitude:row.longitude,
      height:row.height,
      primary_country_code:row.primary_country_code,
      candidate_country_code:row.candidate_country_code,
      pair:row.pair,
      distance_to_boundary_meters:row.distance_to_boundary_meters,
      priority:10-index,
      priority_reasons:row.named_review_reasons,
      source_requirement:"Independent of OSM/Overpass and geoBoundaries; prefer official national mapping, cadastral/border authority, official gazetteer, or legal/government source.",
    };
  });

  writeJsonl(investigationPath,investigation);

  if(existsSync(evidencePath)){
    process.stdout.write(JSON.stringify({
      investigation_rows:investigation.length,
      investigation_output:investigationPath,
      evidence_output:evidencePath,
      evidence_template_created:false,
      safety:"Investigation queue refreshed, but existing evidence was preserved and not overwritten. No decisions, SQL, or database writes.",
    },null,2)+"\n");
    return;
  }

  const evidence:EvidenceRow[]=investigation.map(row=>({
    candidate_hash:row.candidate_hash,
    mountain_id:row.mountain_id,
    primary_country_code:row.primary_country_code,
    candidate_country_code:row.candidate_country_code,
    finding:null,
    source_url:null,
    source_type:null,
    source_title:null,
    source_authority:null,
    evidence_notes:null,
    checked_by:null,
    checked_at:null,
  }));
  writeJsonl(evidencePath,evidence);

  process.stdout.write(JSON.stringify({
    investigation_rows:investigation.length,
    investigation_output:investigationPath,
    evidence_output:evidencePath,
    evidence_template_created:true,
    safety:"Final-nine third-source preparation only. All evidence fields start null. Existing evidence is never overwritten. No decisions, SQL, or database writes.",
  },null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
