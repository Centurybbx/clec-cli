/** Real-service acceptance recorder. Run only against the parent-approved stable artifact. */
import { createHash, randomUUID } from 'node:crypto';
import { OwnedProcess, childEnv } from './process.ts';
import { collectSse } from './sse.ts';
import { reconcile } from './reconcile.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const args = process.argv.slice(2), mode = args.shift();
const options: Record<string,string> = {};
while (args.length) { const k = args.shift()!; if (!k.startsWith('--') || !args.length) throw Error('Expected --option value'); options[k.slice(2)] = args.shift()!; }
function required(k: string) { if (!options[k]) throw Error(`Missing --${k}`); return resolve(options[k]); }
function positive(k: string, fallback: number) { const n = Number(options[k] ?? fallback); if (!Number.isSafeInteger(n) || n < 1) throw Error(`Invalid --${k}`); return n; }
const out = required('out'); if (existsSync(out)) throw Error('Evidence output already exists'); mkdirSync(dirname(out), {recursive:true});
let secret = ''; // Only populated by an explicit private key-file argument for owned child processes.
function scrub(s: string) { return secret ? s.split(secret).join('[REDACTED]') : s; }
function record(value: unknown) { appendFileSync(out, scrub(JSON.stringify({at:new Date().toISOString(), ...value as object})) + '\n', {mode:0o600}); }
function hash(p: string) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }
function tree(p: string): {path:string,sha256:string}[] { const result: {path:string,sha256:string}[] = []; function visit(d: string) { for (const e of readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) { const f=join(d,e.name); if(e.isDirectory()) visit(f); else if(e.isFile()) result.push({path:f.slice(p.length+1),sha256:hash(f)}); else throw Error(`Unsupported non-regular source entry: ${f}`); } } visit(p); return result; }
const cli = required('cli'), workspace = required('workspace'), state = required('state'), piDir = required('pi-dir');
if (piDir === state || piDir.startsWith(state + '/') || state.startsWith(piDir + '/')) throw Error('State and Pi directories must be separate');
const dist = dirname(cli), source = resolve(options.source ?? 'backend/src');
const duration = positive('max-ms', 3600000), deadline = Date.now()+duration;
const maxQuestions = positive('max-questions',45), maxCalls = positive('max-calls',180);
const timeoutMs = positive('run-timeout-ms',600000);
const manifest = options.manifest ? resolve(options.manifest) : join(state,'full-intake.json');
const snapshot = () => ({ source:tree(source), build:tree(dist), cliSha256:hash(cli),
  identities:['backend/package.json','backend/package-lock.json','package-lock.json',manifest,join(state,'CURRENT')].filter(existsSync).map(path=>({path,sha256:hash(path)})),
  intakeSources: existsSync(manifest) ? JSON.parse(readFileSync(manifest,'utf8')).sources.filter((s:any)=>s.status==='ready' && s.type!=='metadata').map((s:any)=>({path:s.path,sha256:hash(join(workspace,s.path))})) : null });
function left() { const ms=deadline-Date.now(); if(ms<=0) throw Error('Overall time budget exhausted'); return ms; }
function safeUrl(s: string) { const u = new URL(s); if (!['localhost','127.0.0.1','[::1]'].includes(u.hostname) || u.username || u.password) throw Error('Only credential-free loopback URLs are supported'); return u; }
let api = safeUrl(options.api ?? 'http://127.0.0.1:3000');
let qmd = safeUrl(options.qmd ?? 'http://localhost:8181');
async function request(path: string, method='GET', body?: unknown, timeout=30000) { const response=await fetch(new URL(path,api),{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(Math.min(left(),timeout))}); const text=await response.text(); let data: any; try { data=JSON.parse(text); } catch { data=text; } return {status:response.status,data}; }
let commandNumber=0;
async function command(argv: string[]) {
  const log = `${out}.cli-${++commandNumber}.log`;
  const child = new OwnedProcess([cli,...argv],childEnv({CLEC_WORKSPACE:workspace,CLEC_STATE_DIR:state,CLEC_PI_DIR:piDir,CLEC_QMD_URL:qmd.href}),log,secret);
  const result=await child.wait(left()); record({type:'cli',argv,...result,log});
  if(result.code!==0) throw Error('CLI failed');
  return readFileSync(log,'utf8');
}
async function citations(result: any) {
  const checks=[]; const cache = new Map<string, any>(); // One run, one fixed generation only.
  for (const c of result.result?.citations ?? []) {
    let data=cache.get(c.sourceId);
    if (!data) { data=JSON.parse(await command(['source',c.sourceId])); cache.set(c.sourceId,data); }
    const path=resolve(workspace,c.path);
    if (!path.startsWith(workspace+'/')) throw Error('Citation path escapes workspace');
    const bytes=readFileSync(path), original=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const actualHash=createHash('sha256').update(bytes).digest('hex');
    checks.push({id:c.id,sourceId:c.sourceId,sourceVersion:c.sourceVersion,generation:c.generation,actualHash,
      matches: {sourceId:data.source.id===c.sourceId,version:data.source.version===c.sourceVersion,path:data.source.path===c.path,
        hash:data.source.contentHash===actualHash,original:data.original===original,range:Number.isSafeInteger(c.start)&&Number.isSafeInteger(c.end)&&c.start>=0&&c.end>=c.start&&c.end<=original.length,
        quote:original.slice(c.start,c.end)===c.quote,generation:c.generation===result.generation && c.generation===readFileSync(join(state,'CURRENT'),'utf8').trim()}});
    record({type:'citation_audit',run:result.id,check:checks[checks.length-1]});
  }
  return checks;
}
async function events(session: string, run: string, phase = 'live') {
  const started=Date.now();
  return collectSse(new URL(`/v1/sessions/${session}/events?runId=${run}&after=0`,api), left(), frame => record({type:'sse',phase,session,run,elapsedMs:Date.now()-started,...frame}));
}
async function lifecycle() {
  // Port allocation minimizes collisions; binding is still subject to a normal OS race.
  const {createServer}=await import('node:net');
  const port=async()=>await new Promise<number>((ok,fail)=>{const s=createServer(); s.once('error',fail); s.listen(0,'127.0.0.1',()=>{const a=s.address(); if(!a || typeof a==='string') return fail(Error('No port')); const n=a.port; s.close(()=>ok(n));});});
  const keyFile=options['key-file']; if(!keyFile) throw Error('Lifecycle requires private --key-file');
  try { secret=readFileSync(resolve(keyFile),'utf8').trim(); } catch { throw Error('Unable to read private credential'); } if(!secret) throw Error('Empty credential');
  const qp=await port(), ap=await port(); qmd=new URL(`http://127.0.0.1:${qp}`); api=new URL(`http://127.0.0.1:${ap}`);
  const common={CLEC_WORKSPACE:workspace,CLEC_STATE_DIR:state,CLEC_PI_DIR:piDir,CLEC_QMD_URL:qmd.href,CLEC_PORT:String(ap)};
  let q:OwnedProcess|undefined, server:OwnedProcess|undefined, serverNumber=0;
  const startServer=()=>{server=new OwnedProcess([cli,'serve'],{...childEnv(common),DEEPSEEK_API_KEY:secret},`${out}.api-${++serverNumber}.log`,secret);};
  const ready=async()=>{while(true){left(); try {if((await request('/health?check=ready','GET',undefined,2000)).status===200)return;}catch{} await new Promise(r=>setTimeout(r,500));}};
  const create=async()=>{const r=await request('/v1/sessions','POST',{title:'E2E lifecycle'}); if(r.status!==201)throw Error(`session create ${r.status}`); return r.data.id as string;};
  const submit=async(s:string,question:string,id=randomUUID(),timeout=timeoutMs)=>{const r=await request(`/v1/sessions/${s}/runs`,'POST',{question,requestId:id,timeoutMs:timeout}); record({type:'lifecycle_http',action:'submit',session:s,response:r}); return r;};
  const get=async(s:string,r:string)=>await request(`/v1/sessions/${s}/runs/${r}`);
  const settle=async(s:string,r:string)=>{await events(s,r); return (await get(s,r)).data;};
  const check=(name:string,status:'PASS'|'FAIL'|'NOT_EXERCISED',detail:unknown)=>record({type:'scenario',name,status,detail});
  const question='資料中如何描述退休所需的年開銷倍數？', other='資料如何討論資產配置與風險？';
  try {
    q=new OwnedProcess([cli,'qmd-serve',String(qp)],childEnv(common),`${out}.qmd.log`,secret); startServer(); await ready();
    const a=await create(), b=await create(), id=randomUUID();
    const first=await submit(a,question,id), duplicate=await submit(a,question,id), conflict=await submit(a,other,id);
    check('idempotence',first.status===202&&duplicate.status===202&&first.data.id===duplicate.data.id&&conflict.status===409?'PASS':'FAIL',{first,duplicate,conflict});
    const queued=await submit(a,other), concurrent=await submit(b,other);
    const [one,two,independent]=await Promise.all([settle(a,first.data.id),settle(a,queued.data.id),settle(b,concurrent.data.id)]);
    check('fifo',one.settledAt&&two.startedAt&&Date.parse(two.startedAt)>=Date.parse(one.settledAt)?'PASS':'FAIL',{one,two});
    check('concurrent_isolation',one.startedAt&&independent.startedAt&&Date.parse(independent.startedAt)<Date.parse(one.settledAt)&&Date.parse(one.startedAt)<Date.parse(independent.settledAt)?'NOT_EXERCISED':'NOT_EXERCISED',{reason:'Overlap and semantic isolation require inspection of the recorded events and answers',one,independent});
    const active=await submit(a,question), waiting=await submit(a,other); const before=await get(a,active.data.id);
    const cancelQueued=await request(`/v1/sessions/${a}/runs/${waiting.data.id}/cancel`,'POST',{});
    const busyDelete=await request(`/v1/sessions/${a}`,'DELETE');
    const cancelActive=await request(`/v1/sessions/${a}/runs/${active.data.id}/cancel`,'POST',{});
    const [activeDone,waitingDone]=await Promise.all([settle(a,active.data.id),settle(a,waiting.data.id)]);
    check('cancel_and_delete',before.data.state==='running'&&cancelActive.data.state==='cancelled'&&cancelQueued.data.state==='cancelled'&&waitingDone.state==='cancelled'&&busyDelete.status===409?'PASS':'NOT_EXERCISED',{before,cancelQueued,busyDelete,cancelActive,activeDone,waitingDone});
    const deleted=await request(`/v1/sessions/${a}`,'DELETE'); check('delete_after_settlement',deleted.status===204?'PASS':'FAIL',deleted);
    const short=await submit(b,question,randomUUID(),1); const shortDone=await settle(b,short.data.id); check('real_timeout',shortDone.state==='timed_out'?'PASS':'NOT_EXERCISED',shortDone);
    check('restart_interrupted','NOT_EXERCISED','Manual crash at an observed running stage and follow-up context verification required');
    check('sse_replay','NOT_EXERCISED','Reconnect using Last-Event-ID and compare durable cursors');
    check('incremental_rebuild','NOT_EXERCISED','Use isolated copied sources and compare generation metadata; see scenario specification');
  } finally { if(server) await server.stop(); if(q) await q.stop(); secret=''; }
}
async function main() {
  record({type:'start',mode,node:process.version,platform:process.platform,arch:process.arch,cli,workspace,state,piDir,cacheState:'unknown',api:api.origin,qmd:qmd.origin,limits:{duration,maxQuestions,maxCalls,timeoutMs},snapshot:snapshot()});
  try {
    if(mode==='prepare') { mkdirSync(state,{recursive:true}); await command(['catalogue','--root',workspace,'--manifest',join(state,'full-intake.json'),'--report',join(state,'catalogue.json')]); record({type:'preparation',manifest:join(state,'full-intake.json'),catalogue:join(state,'catalogue.json'),note:'Catalogue only; inspect coverage and omissions before full hybrid build.'}); }
    else if(mode==='lifecycle') { await lifecycle(); }
    else if(mode==='dataset') {
      const split=options.split; if(!['development','heldout'].includes(split)) throw Error('Explicit --split development or heldout required');
      if(split==='heldout' && options['final-phase']!=='frozen') throw Error('Heldout requires --final-phase frozen');
      const file=required('cases'); const cases=readFileSync(file,'utf8').trim().split(/\r?\n/).map(x=>JSON.parse(x));
      const expected=split==='heldout'?'held_out':'development'; if(cases.some(c=>c.split!==expected)) throw Error('Case split mismatch');
      if((await request('/health?check=ready')).status!==200) throw Error('Readiness prerequisite failed');
      record({type:'dataset',split,caseFileSha256:hash(file),caseCount:cases.length,caseIds:cases.map(c=>c.id),note:'Semantic evaluation requires manual review; annotation is never sent to service.'});
      const sessions=new Map<string,{id:string,last:string,turn:number,state:string}>(); let submitted=0;
      for(const c of cases) {
        if(submitted>=maxQuestions || (submitted+1)*4>maxCalls) { record({type:'budget_stop',submitted,reason:'question or worst-case model call admission limit'}); break; }
        const conv=c.conversation; if(!conv || !['ordered','standalone'].includes(conv.mode)) throw Error(`Invalid conversation metadata ${c.id}`);
        let session: string;
        if(conv.mode==='ordered' && conv.turn>1) { const prev=sessions.get(conv.session_id); if(!prev || prev.last!==conv.previous_case_id || prev.turn!==conv.turn-1) throw Error(`Missing or out-of-order predecessor for ${c.id}`); session=prev.id; }
        else { const created=await request('/v1/sessions','POST',{title:`E2E ${c.id}`}); if(created.status!==201) throw Error(`Create session HTTP ${created.status}`); session=created.data.id; }
        const started=Date.now(); let run: string | null = null; let observedState = 'unknown';
        const predecessor = conv.mode === 'ordered' && conv.turn > 1 ? sessions.get(conv.session_id) : undefined;
        try {
          const accepted=await request(`/v1/sessions/${session}/runs`,'POST',{question:c.question,requestId:randomUUID(),timeoutMs});
          record({type:'admission',id:c.id,session,response:accepted});
          if(accepted.status!==202) throw Error(`Run admission HTTP ${accepted.status}`);
          submitted++; run=accepted.data.id;
          const live=await events(session,run!);
          const settledElapsedMs=Date.now()-started;
          const fetched=await request(`/v1/sessions/${session}/runs/${run}`);
          const history=await request(`/v1/sessions/${session}/messages`);
          const replay=await events(session,run!,'replay');
          if(fetched.status!==200 || history.status!==200) throw Error(`GET run/history HTTP ${fetched.status}/${history.status}`);
          const result=fetched.data; observedState = result.state;
          let citationChecks: any[] = []; let citationError: string | null = null;
          try { citationChecks=await citations(result); } catch(e) { citationError=String(e); }
          const contract=reconcile(result,history.data,live,replay);
          const citationMechanical = citationError ? 'INCOMPLETE' : citationChecks.some(c => Object.values(c.matches).some(v => !v)) ? 'FAIL' : citationChecks.length ? 'PASS' : 'NO_CITATIONS';
          record({type:'case',id:c.id,session,run,elapsedMs:Date.now()-started,settledElapsedMs,predecessor,runRecord:result,history:history.data,contract,citationChecks,citationError,citationMechanical,review:{status:'manual_review_required',question:c.question,annotations:{evidence:c.evidence,required_answer_points:c.required_answer_points,forbidden_inferences:c.forbidden_inferences,quality_caveat:c.quality_caveat,evidence_completeness:c.evidence_completeness,conversation:conv},note:'Review each block, source and claim, including provenance and negative claims. Mechanical checks do not establish entailment.'}});
        } catch(e) {
          let fetched: unknown = null, history: unknown = null;
          if (run) { try { fetched=await request(`/v1/sessions/${session}/runs/${run}`); history=await request(`/v1/sessions/${session}/messages`); } catch {} }
          record({type:'case_error',id:c.id,session,run,elapsedMs:Date.now()-started,predecessor,error:String(e),fetched,history});
        }
        if(conv.mode==='ordered') sessions.set(conv.session_id,{id:session,last:c.id,turn:conv.turn,state:observedState});
      }
    } else throw Error('Mode must be prepare, dataset or lifecycle');
  } finally { record({type:'end',snapshot:snapshot()}); }
}
main().catch(e=>{record({type:'error',message:String(e)}); process.exitCode=1;});
