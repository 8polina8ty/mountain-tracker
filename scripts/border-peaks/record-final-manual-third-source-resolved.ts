#!/usr/bin/env ts-node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Evidence={
  candidate_hash:string; mountain_id:number; primary_country_code:string; candidate_country_code:string;
  finding:string|null; source_url:string|null; source_type:string|null; source_title:string|null;
  source_authority:string|null; evidence_notes:string|null; checked_by:string|null; checked_at:string|null;
};
function arg(n:string,f:string){const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:f;}
function read<T>(p:string):T[]{if(!existsSync(p))throw new Error(`Required file is missing: ${p}`);const raw=readFileSync(p,"utf8").trim();return raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function isBlank(r:Evidence){return [r.finding,r.source_url,r.source_type,r.source_title,r.source_authority,r.evidence_notes,r.checked_by,r.checked_at].every(v=>v==null);}
function main(){
  const path=arg("--evidence","data/border-peaks/global-review/final-manual-third-source-evidence.jsonl");
  const rows=read<Evidence>(path);if(rows.length!==9)throw new Error(`Expected 9 evidence rows, found ${rows.length}`);
  const targets=new Map<number,Partial<Evidence>>([
    [6002,{
      finding:"SUPPORTS",
      source_url:"https://www.govern.ad/documents/d/guest/05-presentacio-coneixements-tecnics-caca-1?download=true",
      source_type:"OFFICIAL_LEGAL_DOCUMENT",
      source_title:"Presentació coneixements tècnics caça — zones d'activitat humana",
      source_authority:"Govern d'Andorra",
      evidence_notes:"Official Andorran material defines the winter activity-zone boundary from Pic d'Arcalís to Pic de Cataperdís and then as following the French border via Port de Rat and Port de Creussans. This independently places Pic de Cataperdís at the Andorra–France border context and supports the proposed FR->AD secondary membership.",
    }],
    [333297,{
      finding:"SUPPORTS",
      source_url:"https://www.visitmozambique.gov.mz/sobre-mocambique/",
      source_type:"GOVERNMENT_GAZETTEER",
      source_title:"Sobre Moçambique — Geografia",
      source_authority:"Visit Mozambique / Governo de Moçambique",
      evidence_notes:"Official Mozambique tourism geography states that Monte Binga, the country's highest point, is located on the country's border with Zimbabwe. This directly supports the proposed ZW->MZ secondary membership.",
    }],
  ]);
  const now=new Date().toISOString();let written=0;
  for(const row of rows){
    const data=targets.get(row.mountain_id);if(!data)continue;
    if(!isBlank(row))throw new Error(`Refusing to overwrite existing evidence for mountain ${row.mountain_id}`);
    Object.assign(row,data,{checked_by:"ChatGPT-assisted independent-source research; human approval pending",checked_at:now});
    written++;
  }
  if(written!==2)throw new Error(`Expected to write exactly 2 resolved evidence rows, wrote ${written}`);
  writeFileSync(path,`${rows.map(r=>JSON.stringify(r)).join("\n")}\n`);
  process.stdout.write(JSON.stringify({
    evidence_rows:rows.length,
    resolved_rows_written:written,
    supports_rows_written:2,
    pending_rows:7,
    safety:"Evidence only. No human APPROVE/REJECT decision, SQL, or database write is performed.",
  },null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
