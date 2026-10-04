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
  const approve=decisions.filter(r=>r.decision==="APPROVE");
  const reject=decisions.filter(r=>r.decision==="REJECT");
  if(pending.length!==2||approve.length!==1318||reject.length!==52){
    throw new Error(`Expected current state pending=2/approve=1318/reject=52, found ${pending.length}/${approve.length}/${reject.length}`);
  }

  const supported=evidence.filter(r=>r.finding==="SUPPORTS");
  if(supported.length!==2)throw new Error(`Expected exactly 2 SUPPORTS evidence rows, found ${supported.length}`);

  const manualByHash=new Map(manual.map(r=>[r.candidate_hash,r]));
  const decisionByHash=new Map(decisions.map(r=>[r.candidate_hash,r]));
  const pendingHashes=new Set(pending.map(r=>r.candidate_hash));

  for(const row of supported){
    if(!row.source_url||!row.source_type||!row.source_title||!row.source_authority||!row.evidence_notes||!row.checked_by||!row.checked_at){
      throw new Error(`Incomplete SUPPORTS evidence for ${row.candidate_hash.slice(0,12)}…`);
    }
    if(!pendingHashes.has(row.candidate_hash))throw new Error(`Supported row is not pending: ${row.candidate_hash.slice(0,12)}…`);

    const m=manualByHash.get(row.candidate_hash);
    const d=decisionByHash.get(row.candidate_hash);
    if(!m||!d)throw new Error(`Supported row missing from manual/decision manifests: ${row.candidate_hash.slice(0,12)}…`);
    if(m.named_review_tier!=="STANDARD_MANUAL_REVIEW")throw new Error("Unexpected manual review tier");
    if(
      row.mountain_id!==m.mountain_id ||
      row.primary_country_code!==m.primary_country_code ||
      row.candidate_country_code!==m.candidate_country_code ||
      d.mountain_id!==m.mountain_id ||
      d.mountain_name!==m.mountain_name ||
      d.primary_country_code!==m.primary_country_code ||
      d.candidate_country_code!==m.candidate_country_code ||
      d.pair!==m.pair
    ) throw new Error(`Identity mismatch for ${row.candidate_hash.slice(0,12)}…`);

    if(d.reviewed_by!=null||d.reviewed_at!=null||d.review_notes!=null||d.decision_batch_id!=null||d.approval_basis!=null){
      throw new Error(`Refusing to overwrite reviewer metadata for ${row.candidate_hash.slice(0,12)}…`);
    }
  }

  const supportedHashes=new Set(supported.map(r=>r.candidate_hash));
  if(pending.some(r=>!supportedHashes.has(r.candidate_hash))){
    throw new Error("One or more pending decisions are not the two evidence-supported final-manual rows");
  }

  const now=new Date().toISOString();
  for(const row of supported){
    const d=decisionByHash.get(row.candidate_hash)!;
    d.decision="APPROVE";
    d.reviewed_by="Human reviewer (explicit confirmation of final 2 supported peaks)";
    d.reviewed_at=now;
    d.review_notes="Human reviewer explicitly approved this final STANDARD_MANUAL_REVIEW border-country membership after independent third-source evidence returned SUPPORTS. No override is used; the evidence finding remains unchanged.";
    d.decision_batch_id="final-manual-supported-2";
    d.approval_basis=null;
  }

  writeFileSync(decisionsPath,`${decisions.map(r=>JSON.stringify(r)).join("\n")}\n`);

  const remaining=decisions.filter(r=>r.decision===null);
  if(remaining.length!==0)throw new Error(`Post-write invariant failed: expected 0 pending rows, found ${remaining.length}`);

  process.stdout.write(JSON.stringify({
    supported_approvals_written:2,
    remaining_pending_rows:0,
    approve_rows:decisions.filter(r=>r.decision==="APPROVE").length,
    reject_rows:decisions.filter(r=>r.decision==="REJECT").length,
    reviewed_at:now,
    decision_file:decisionsPath,
    safety:"Only the two explicitly confirmed final-manual SUPPORTS rows were approved. Evidence findings were not changed. No SQL or database write is performed."
  },null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
