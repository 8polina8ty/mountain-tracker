#!/usr/bin/env ts-node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Tier="HIGH_CONFIDENCE_REVIEW"|"STANDARD_REVIEW"|"THIRD_SOURCE_RECOMMENDED";
type Row={candidate_hash:string;mountain_id:number;candidate_country_code:string;review_tier:Tier;};

function arg(n:string,f:string){const i=process.argv.indexOf(n);return i>=0&&process.argv[i+1]?process.argv[i+1]:f;}
function intArg(n:string,f:number){const v=Number(arg(n,String(f)));if(!Number.isInteger(v)||v<=0)throw new Error(`${n} must be a positive integer`);return v;}
function read<T>(p:string):T[]{if(!existsSync(p))throw new Error(`Required file is missing: ${p}`);const raw=readFileSync(p,"utf8").trim();return raw?raw.split("\n").filter(Boolean).map(l=>JSON.parse(l) as T):[];}
function write(path:string,rows:unknown[]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,rows.length?`${rows.map(r=>JSON.stringify(r)).join("\n")}\n`:"");}

function main(){
 const input=arg("--input","data/border-peaks/global-review/geometric-support/all.jsonl");
 const outDir=arg("--output-dir","data/border-peaks/global-review/geometric-support/batches");
 const size=intArg("--batch-size",75);
 const rows=read<Row>(input);
 if(rows.length!==553)throw new Error(`Expected 553 GEOMETRIC_SUPPORT rows, found ${rows.length}`);
 const groups:Row[][]=[];
 for(const r of rows){const last=groups.at(-1);if(last&&last[0]?.mountain_id===r.mountain_id)last.push(r);else groups.push([r]);}
 const batches:Row[][]=[];let cur:Row[]=[];
 for(const g of groups){const sameTier=cur.length===0||cur[0]?.review_tier===g[0]?.review_tier;if(cur.length>0&&(!sameTier||cur.length+g.length>size)){batches.push(cur);cur=[];}cur.push(...g);}
 if(cur.length)batches.push(cur);
 if(existsSync(outDir))rmSync(outDir,{recursive:true,force:true});mkdirSync(outDir,{recursive:true});
 const summaries=batches.map((rows,i)=>{const id=`geo-${String(i+1).padStart(3,"0")}`;write(join(outDir,id+".jsonl"),rows.map((r,j)=>({...r,batch_id:id,batch_index:i+1,batch_row_index:j+1})));return{batch_id:id,rows:rows.length,unique_mountains:new Set(rows.map(r=>r.mountain_id)).size,review_tier:rows[0]?.review_tier,file:join(outDir,id+".jsonl")};});
 const summary={total_rows:rows.length,batch_size_target:size,batch_count:batches.length,batches:summaries,safety:"Review batching only. Tier boundaries and mountain groups are preserved. No decisions, SQL, or database writes."};
 writeFileSync(join(outDir,"summary.json"),JSON.stringify(summary,null,2));
 process.stdout.write(JSON.stringify(summary,null,2)+"\n");
}
try{main();}catch(e){process.stderr.write((e instanceof Error?e.stack:String(e))+"\n");process.exitCode=1;}
