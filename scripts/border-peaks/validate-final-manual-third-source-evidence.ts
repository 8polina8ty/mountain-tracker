#!/usr/bin/env ts-node
import { existsSync, readFileSync } from "node:fs";

type Finding="SUPPORTS"|"DOES_NOT_SUPPORT"|"AMBIGUOUS";
type SourceType="OFFICIAL_NATIONAL_MAPPING"|"CADASTRAL"|"BORDER_COMMISSION"|"GOVERNMENT_GAZETTEER"|"OFFICIAL_LEGAL_DOCUMENT"|"OTHER_AUTHORITATIVE";
type Investigation={candidate_hash:string;mountain_id:number;primary_country_code:string;candidate_country_code:string;};
type Evidence={candidate_hash:string;mountain_id:number;primary_country_code:string;candidate_country_code:string;finding:Finding|null;source_url:string|null;source_type:SourceType|null;source_title:string|null;source_authority:string|null;evidence_notes:string|null;checked_by:string|null;checked_at:string|null;};

const findings=new Set(["SUPPORTS","DOES_NOT_SUPPORT","AMBIGUOUS"]);
const sourceTypes=new Set(["OFFICIAL_NATIONAL_MAPPING","CADASTRAL","BORDER_COMMISSION","GOVERNMENT_GAZETTEER","OFFICIAL_LEGAL_DOCUMENT","OTHER_AUTHORITATIVE"]);

function arg(n:string,f:string){const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:f;}
function read<T>(p:string):T[]{if(!existsSync(p))throw new Error(`Required file is missing: ${p}`);const raw=readFileSync(p,"utf8").trim();return raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function main(){
  const inv=read<Investigation>(arg("--investigation","data/border-peaks/global-review/final-manual-third-source-investigation.jsonl"));
  const ev=read<Evidence>(arg("--evidence","data/border-peaks/global-review/final-manual-third-source-evidence.jsonl"));
  if(inv.length!==9||ev.length!==9)throw new Error(`Expected 9/9 rows, found ${inv.length}/${ev.length}`);
  const by=new Map(inv.map(r=>[r.candidate_hash,r]));const seen=new Set<string>();let completed=0;
  const counts={SUPPORTS:0,DOES_NOT_SUPPORT:0,AMBIGUOUS:0};
  for(const r of ev){
    if(!/^[a-f0-9]{64}$/.test(r.candidate_hash)||seen.has(r.candidate_hash))throw new Error("Invalid/duplicate evidence hash");
    seen.add(r.candidate_hash);
    const q=by.get(r.candidate_hash);if(!q)throw new Error("Evidence hash missing from investigation");
    if(q.mountain_id!==r.mountain_id||q.primary_country_code!==r.primary_country_code||q.candidate_country_code!==r.candidate_country_code)throw new Error("Evidence identity mismatch");
    const blank=[r.finding,r.source_url,r.source_type,r.source_title,r.source_authority,r.evidence_notes,r.checked_by,r.checked_at].every(v=>v==null);
    if(blank)continue;
    if(!findings.has(String(r.finding)))throw new Error(`Invalid finding for ${r.candidate_hash.slice(0,12)}…`);
    if(!sourceTypes.has(String(r.source_type)))throw new Error(`Invalid source type for ${r.candidate_hash.slice(0,12)}…`);
    for(const [k,v] of Object.entries({source_url:r.source_url,source_title:r.source_title,source_authority:r.source_authority,evidence_notes:r.evidence_notes,checked_by:r.checked_by,checked_at:r.checked_at})){
      if(typeof v!=="string"||v.trim().length<3)throw new Error(`Incomplete ${k} for ${r.candidate_hash.slice(0,12)}…`);
    }
    const u=new URL(r.source_url!);if(!["http:","https:"].includes(u.protocol))throw new Error("Evidence URL must be http(s)");
    const host=u.hostname.toLowerCase();
    for(const f of ["openstreetmap.org","overpass-api.de","overpass.private.coffee","geoboundaries.org","geolab.wm.edu"]){if(host===f||host.endsWith("."+f))throw new Error(`Non-independent source ${host}`);}
    if(!Number.isFinite(Date.parse(r.checked_at!)))throw new Error("Invalid checked_at");
    counts[r.finding as Finding]++;completed++;
  }
  process.stdout.write(JSON.stringify({
    investigation_rows:inv.length,
    evidence_rows:ev.length,
    completed_evidence_rows:completed,
    pending_rows:9-completed,
    finding_counts:counts,
    valid:true,
    safety:"Evidence validation only. Findings are not human decisions and cannot export SQL.",
  },null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
