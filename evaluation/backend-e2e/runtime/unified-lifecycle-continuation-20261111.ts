import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,openSync,closeSync,cpSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
const dir='/tmp/clec-unified-lifecycle-terra-20261111', cli=dir+'/backend/dist/cli.js';
const secret=readFileSync('/Users/century/.t3/userdata/secrets/files/b95bc1b656616ef07438bdf9654a8b38','utf8').trim();
const log=(x:any)=>appendFileSync(dir+'/events.jsonl',JSON.stringify({at:new Date().toISOString(),...x}).split(secret).join('[REDACTED]')+'\n',{mode:0o600});
const port=()=>new Promise<number>(resolve=>{const s=createServer().listen(0,'127.0.0.1',()=>{const a=s.address() as any;s.close(()=>resolve(a.port))})});
const qp=await port(), ap=await port(), env={...process.env,CLEC_WORKSPACE:dir+'/workspace',CLEC_STATE_DIR:dir+'/state',CLEC_QMD_URL:`http://localhost:${qp}`,CLEC_PORT:String(ap),CLEC_PI_DIR:dir+'/pi',CLEC_DIAGNOSTIC_PATH:dir+'/diagnostics.jsonl'};delete env.DEEPSEEK_API_KEY;
const children:any[]=[];function start(args:string[],name:string,key=false){const o=openSync(`${dir}/${name}.stdout`,'wx',0o600),e=openSync(`${dir}/${name}.stderr`,'wx',0o600);const p=spawn(process.execPath,[cli,...args],{env:key?{...env,DEEPSEEK_API_KEY:secret}:env,detached:true,stdio:['ignore',o,e]});closeSync(o);closeSync(e);children.push(p);log({type:'spawn',name,pid:p.pid});return p}
async function stop(p:any,sig:NodeJS.Signals='SIGTERM'){if(p.exitCode!==null||p.signalCode!==null)return;try{process.kill(-p.pid,sig)}catch{};await new Promise<void>(resolve=>{p.once('close',()=>resolve());const t=setTimeout(()=>{try{process.kill(-p.pid,'SIGKILL')}catch{}},5000);t.unref()});log({type:'exit',pid:p.pid,code:p.exitCode,signal:p.signalCode})}
const url=`http://127.0.0.1:${ap}`;async function req(path:string,method='GET',body?:any,headers:any={}){const r=await fetch(url+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const t=await r.text();let data:any;try{data=JSON.parse(t)}catch{data=t}const result={status:r.status,data};log({type:'http',path,method,body,response:result});return result}
async function ready(){for(let i=0;i<100;i++){try{const r=await req('/health?check=ready');if(r.status===200)return}catch{}await new Promise(r=>setTimeout(r,100))}throw Error('not ready')}
async function session(title:string){return (await req('/v1/sessions','POST',{title})).data.id}
async function submit(s:string,q:string,extra:any={}){return req(`/v1/sessions/${s}/runs`,'POST',{question:q,requestId:randomUUID(),timeoutMs:180000,...extra})}
async function events(s:string,id:string,after?:number){const h=after===undefined?{}:{'Last-Event-ID':String(after)};const r=await fetch(url+`/v1/sessions/${s}/events?runId=${id}`,{headers:h,signal:AbortSignal.timeout(200000)});const text=await r.text();log({type:'stream',s,id,after,status:r.status,text});return text}
async function result(s:string,id:string){return req(`/v1/sessions/${s}/runs/${id}`)}
async function settle(s:string,id:string){await events(s,id);return result(s,id)}
async function until(s:string,id:string,predicate:(x:any)=>boolean){for(let i=0;i<400;i++){let r=await result(s,id);if(predicate(r.data))return r.data;await new Promise(r=>setTimeout(r,25))}throw Error('observation timeout')}
async function first(id:string){for(let i=0;i<3000;i++){const rows=existsSync(dir+'/diagnostics.jsonl')?readFileSync(dir+'/diagnostics.jsonl','utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];const hit=rows.find(x=>x.runId===id&&x.code==='FIRST_PROVIDER_EVENT');if(hit){log({type:'observed_first',id,hit});return true}await new Promise(r=>setTimeout(r,10))}log({type:'first_not_observed',id});return false}
const q1='00400 如何调整 2013 年的价格以比较拆股后的图？',q2='老师对周期预测有哪些限制？',q3='00014 老师如何教小孩理财？';
let api:any,qmd:any;try{qmd=start(['qmd-serve',String(qp)],'qmd-cont');api=start(['serve'],'api-cont',true);await ready();
const ac=await session('provider cancel');const ar=await submit(ac,q1);await first(ar.data.id);await req(`/v1/sessions/${ac}/runs/${ar.data.id}/cancel`,'POST',{});await settle(ac,ar.data.id);await req(`/v1/sessions/${ac}/messages`);
const ts=await session('deadline');const tr=await submit(ts,q1,{timeoutMs:1});await settle(ts,tr.data.id);await req(`/v1/sessions/${ts}/messages`);
const crash=await session('provider crash');const baseline=await submit(crash,q1);await settle(crash,baseline.data.id);const cr=await submit(crash,q2);await first(cr.data.id);const cq=await submit(crash,q3);await stop(api,'SIGKILL');cpSync(dir+'/pi',dir+'/pi-after-crash',{recursive:true});api=start(['serve'],'api-restart',true);await ready();await result(crash,cr.data.id);await result(crash,cq.data.id);await req(`/v1/sessions/${crash}/messages`);const cf=await submit(crash,'刚才提到的拆股价格，应该怎样比较？');await settle(crash,cf.data.id);await req(`/v1/sessions/${crash}/messages`);
}catch(e){log({type:'continuation_fatal',error:String(e)});process.exitCode=1}finally{for(const p of children.reverse())await stop(p);log({type:'continuation_cleanup',children:children.map(p=>({pid:p.pid,exitCode:p.exitCode,signal:p.signalCode}))})}
