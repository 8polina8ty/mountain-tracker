#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type EvidenceRow = {
  candidate_hash: string;
  mountain_id: number;
  primary_country_code: string;
  candidate_country_code: string;
  finding: "SUPPORTS" | "DOES_NOT_SUPPORT" | "AMBIGUOUS" | null;
  source_url: string | null;
  source_type: string | null;
  source_title: string | null;
  source_authority: string | null;
  evidence_notes: string | null;
  checked_by: string | null;
  checked_at: string | null;
};

type ManualRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  named_review_tier: "STANDARD_MANUAL_REVIEW";
};

type DecisionRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
  approval_basis?: "EXPLICIT_HUMAN_OVERRIDE" | null;
};

function arg(name:string,fallback:string){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;}
function read<T>(p:string):T[]{if(!existsSync(p))throw new Error(`Required file is missing: ${p}`);const raw=readFileSync(p,"utf8").trim();return raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function evidenceBlank(r:EvidenceRow){return [r.finding,r.source_url,r.source_type,r.source_title,r.source_authority,r.evidence_notes,r.checked_by,r.checked_at].every(v=>v==null);}

function main(){
  const evidencePath=arg("--evidence","data/border-peaks/global-review/final-manual-third-source-evidence.jsonl");
  const manualPath=arg("--manual","data/border-peaks/global-review/geometric-support/named-standard/manual.jsonl");
  const decisionsPath=arg("--decisions","data/border-peaks/global-review/strong-review-decisions.jsonl");

  const evidence=read<EvidenceRow>(evidencePath);
  const manual=read<ManualRow>(manualPath);
  const decisions=read<DecisionRow>(decisionsPath);

  if(evidence.length!==9||manual.length!==9||decisions.length!==1372){
    throw new Error(`Expected evidence/manual/decisions = 9/9/1372, found ${evidence.length}/${manual.length}/${decisions.length}`);
  }

  const pending=decisions.filter(r=>r.decision===null);
  if(pending.length!==9) throw new Error(`Expected exactly 9 pending strong decisions, found ${pending.length}`);

  const evidenceByHash=new Map(evidence.map(r=>[r.candidate_hash,r]));
  const manualByHash=new Map(manual.map(r=>[r.candidate_hash,r]));
  const decisionByHash=new Map(decisions.map(r=>[r.candidate_hash,r]));

  const supported=evidence.filter(r=>r.finding==="SUPPORTS");
  const unresolved=evidence.filter(evidenceBlank);

  if(supported.length!==2||unresolved.length!==7){
    throw new Error(`Expected 2 SUPPORTS and 7 unresolved evidence rows, found ${supported.length}/${unresolved.length}`);
  }

  for(const row of evidence){
    if(!manualByHash.has(row.candidate_hash)) throw new Error(`Evidence hash missing from final manual queue: ${row.candidate_hash.slice(0,12)}…`);
    const d=decisionByHash.get(row.candidate_hash);
    if(!d||d.decision!==null) throw new Error(`Expected final-manual decision to remain pending for ${row.candidate_hash.slice(0,12)}…`);
  }

  for(const row of unresolved){
    const m=manualByHash.get(row.candidate_hash)!;
    const d=decisionByHash.get(row.candidate_hash)!;
    if(m.named_review_tier!=="STANDARD_MANUAL_REVIEW") throw new Error("Unexpected manual tier");
    if(
      d.mountain_id!==m.mountain_id ||
      d.mountain_name!==m.mountain_name ||
      d.primary_country_code!==m.primary_country_code ||
      d.candidate_country_code!==m.candidate_country_code ||
      d.pair!==m.pair
    ) throw new Error(`Decision/manual identity mismatch for ${row.candidate_hash.slice(0,12)}…`);
    if(d.reviewed_by!=null||d.reviewed_at!=null||d.review_notes!=null||d.decision_batch_id!=null||d.approval_basis!=null){
      throw new Error(`Refusing to overwrite reviewer metadata for ${row.candidate_hash.slice(0,12)}…`);
    }
  }

  const now=new Date().toISOString();
  for(const row of unresolved){
    const d=decisionByHash.get(row.candidate_hash)!;
    d.decision="APPROVE";
    d.reviewed_by="Human reviewer (explicit confirmation of final 7 manual peaks)";
    d.reviewed_at=now;
    d.review_notes="Human reviewer explicitly approved this final STANDARD_MANUAL_REVIEW border-country membership despite unresolved third-source evidence. The evidence layer remains unchanged and does not independently resolve exact summit dual-country membership; this is an auditable human override.";
    d.decision_batch_id="final-manual-unresolved-7";
    d.approval_basis="EXPLICIT_HUMAN_OVERRIDE";
  }

  writeFileSync(decisionsPath,`${decisions.map(r=>JSON.stringify(r)).join("\n")}\n`);

  const remaining=decisions.filter(r=>r.decision===null);
  const remainingHashes=new Set(remaining.map(r=>r.candidate_hash));
  const supportedStillPending=supported.filter(r=>remainingHashes.has(r.candidate_hash));

  if(remaining.length!==2||supportedStillPending.length!==2){
    throw new Error(`Post-write invariant failed: expected only 2 evidence-supported rows pending, found pending=${remaining.length}, supportedPending=${supportedStillPending.length}`);
  }

  process.stdout.write(JSON.stringify({
    explicit_override_approvals_written:7,
    remaining_pending_rows:remaining.length,
    remaining_pending_supported_rows:supportedStillPending.length,
    approve_rows:decisions.filter(r=>r.decision==="APPROVE").length,
    reject_rows:decisions.filter(r=>r.decision==="REJECT").length,
    reviewed_at:now,
    decision_file:decisionsPath,
    safety:"Only the seven explicitly confirmed unresolved final-manual candidates were approved using EXPLICIT_HUMAN_OVERRIDE. Third-source evidence was not changed. The two independently supported cases remain pending. No SQL or database write is performed."
  },null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
