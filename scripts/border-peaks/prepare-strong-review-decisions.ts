#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Status = "TIER1_VERIFIED" | "GEOMETRIC_SUPPORT";
type QueueRow = {
  candidate_hash: string;
  mountain_id: number;
  mountain_name: string | null;
  primary_country_code: string | null;
  candidate_country_code: string;
  pair: string;
  final_machine_status: Status;
  distance_to_boundary_meters: number | null;
  tier1_status: string | null;
  best_probe_status: string | null;
  latest_probe_status: string | null;
  latest_probe_source: string | null;
  boundary_source: string;
  boundary_source_id: string | null;
  boundary_dataset_version: string | null;
  review_action: "HUMAN_REVIEW";
  decision: null;
  reviewed_by: null;
  reviewed_at: null;
};
type DecisionRow = QueueRow & {
  decision: "APPROVE" | "REJECT" | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  decision_batch_id: string | null;
};

function arg(name:string,fallback:string){const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback;}
function main(){
  const input=arg("--input","data/border-peaks/global-review/strong-human-review.jsonl");
  const output=arg("--output","data/border-peaks/global-review/strong-review-decisions.jsonl");
  if(!existsSync(input)) throw new Error(`Required file is missing: ${input}`);
  if(existsSync(output)) throw new Error(`Refusing to overwrite existing strong decision file: ${output}`);
  const raw=readFileSync(input,"utf8").trim();
  const rows=raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as QueueRow):[];
  if(rows.length!==1372) throw new Error(`Expected 1372 strong rows, found ${rows.length}`);
  const seen=new Set<string>();
  const out:DecisionRow[]=rows.map(r=>{
    if(!/^[a-f0-9]{64}$/.test(r.candidate_hash)||seen.has(r.candidate_hash)) throw new Error("Invalid or duplicate candidate_hash");
    seen.add(r.candidate_hash);
    if(r.review_action!=="HUMAN_REVIEW"||r.decision!==null||r.reviewed_by!==null||r.reviewed_at!==null) throw new Error(`Strong queue row is already mutated: ${r.candidate_hash.slice(0,12)}…`);
    return {...r,decision:null,reviewed_by:null,reviewed_at:null,review_notes:null,decision_batch_id:null};
  });
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,out.map(r=>JSON.stringify(r)).join("\n")+"\n");
  process.stdout.write(JSON.stringify({decision_rows:out.length,pending_rows:out.length,output,safety:"Template only. No decisions, SQL, or database writes."},null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
