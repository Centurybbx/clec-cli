import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const root = '/tmp/clec-unified-lifecycle-terra-20261111';
const output = '/tmp/clec-lifecycle-evidence-addendum-20261111';
const jsonl = (name: string) => readFileSync(`${root}/${name}`, 'utf8').trim().split('\n').map((s, i) => ({ ...JSON.parse(s), line: i + 1 }));
const events = jsonl('events.jsonl'), stale = jsonl('stale.jsonl'), diagnostics = jsonl('diagnostics.jsonl');
const histories = events.filter(x => x.type === 'http' && x.method === 'GET' && x.path.endsWith('/messages') && x.response?.data?.messages);
const streams = new Map<string, any>();
for (const x of events) if (x.type === 'stream' && x.after === undefined) streams.set(x.id, { text: x.text, ref: `events.jsonl:${x.line}` });
for (const x of stale) if (x.method === 'GET' && x.path.includes('/events?runId=')) streams.set(x.path.split('runId=')[1], { text: x.data, ref: `stale.jsonl:${x.line}` });
const gets = [...events.filter(x => x.type === 'http' && x.method === 'GET' && x.response?.data?.settledAt).map(x => ({ run: x.response.data, ref: `events.jsonl:${x.line}` })), ...stale.filter(x => x.method === 'GET' && x.data?.settledAt).map(x => ({ run: x.data, ref: `stale.jsonl:${x.line}` }))];
function frames(text: string) { return text.split(/\r?\n\r?\n/).filter(s => s.split('\n').some(l => l.startsWith('data: '))).map(s => { const lines = s.split('\n'); const id = Number(lines.find(l => l.startsWith('id: '))?.slice(4)); return { id, ...JSON.parse(lines.find(l => l.startsWith('data: '))!.slice(6)) }; }); }
const result = gets.map(({run: r, ref}) => {
  const stream = streams.get(r.id), fs = stream ? frames(stream.text) : [], failures: string[] = [];
  const check = (condition: boolean, label: string) => { if (!condition) failures.push(label); };
  const historyRows = histories.filter(x => x.path.split('/')[3] === r.sessionId && Date.parse(x.at) >= Date.parse(r.settledAt));
  const history = historyRows.at(-1), assistants = history?.response.data.messages.filter((m: any) => m.runId === r.id && m.role === 'assistant');
  const terminal = fs.filter(f => f.data.type === 'terminal'), settled = fs.filter(f => f.data.type === 'settled');
  const final = fs.filter(f => f.data.type === 'progress' && f.data.event.type === 'text');
  const cites = fs.filter(f => f.data.type === 'progress' && f.data.event.type === 'citation');
  check(Date.parse(r.createdAt) <= Date.parse(r.finishedAt) && Date.parse(r.finishedAt) <= Date.parse(r.settledAt), 'GET timestamp boundary');
  if (r.startedAt) check(Date.parse(r.createdAt) <= Date.parse(r.startedAt) && Date.parse(r.startedAt) <= Date.parse(r.finishedAt), 'GET start boundary');
  if (stream) {
    check(fs.every((f, i) => f.id === f.cursor && f.runId === r.id && f.sessionId === r.sessionId && (!i || f.cursor > fs[i-1].cursor)), 'cursor/id/identity');
    check(terminal.length === 1 && settled.length <= 1, 'terminal/settled count');
    if (terminal.length === 1) {
      check(terminal[0].data.state === r.state && isDeepStrictEqual(terminal[0].data.error, r.error) && isDeepStrictEqual(terminal[0].data.result, r.result), 'GET/terminal');
    }
    if (terminal.length === 1 && settled.length === 1) {
      check(terminal[0].cursor < settled[0].cursor && fs.at(-1) === settled[0], 'terminal before final settlement');
      check(Date.parse(terminal[0].createdAt) >= Date.parse(r.finishedAt) && Date.parse(terminal[0].createdAt) <= Date.parse(settled[0].createdAt) && Date.parse(settled[0].createdAt) >= Date.parse(r.settledAt), 'terminal/settlement timestamps');
    }
    if (r.state === 'completed') {
      check(final.length === 1 && final[0].data.event.text === r.result.text, 'final text');
      check(isDeepStrictEqual(cites.map(f => f.data.event.citation), r.result.citations), 'ordered SSE citations');
      if (final.length === 1 && terminal.length === 1) check(final[0].cursor < terminal[0].cursor && cites.every((c, i) => c.cursor > final[0].cursor && c.cursor < terminal[0].cursor && (!i || c.cursor > cites[i-1].cursor)), 'text/citations/terminal order');
      check(isDeepStrictEqual([...new Set(r.result.blocks.flatMap((b: any) => b.evidenceIds ?? []))], r.result.citations.map((c: any) => c.id)), 'block citation order');
    } else check(final.length === 0 && cites.length === 0 && r.result === null, 'non-success final output');
  } else if (r.state !== 'completed') check(r.result === null, 'GET non-success result');
  if (history) {
    if (r.state === 'completed') check(assistants.length === 1 && assistants[0].status === 'final' && assistants[0].text === r.result.text && isDeepStrictEqual(assistants[0].citations, r.result.citations), 'history text/citations');
    else check(assistants.length === 0, 'non-success assistant');
  }
  if (r.result?.answerability === 'no_hits') {
    check(r.result.blocks.length === 0 && r.result.citations.length === 0 && r.metrics.modelCalls === 0 && r.metrics.modelRequestAttempts === 0 && r.result.metrics.modelCalls === 0 && r.result.metrics.modelRequestAttempts === 0 && r.metrics.searchResults === 0, 'no_hits zero calls');
    check(!diagnostics.some(x => x.runId === r.id && (x.stage === 'provider' || x.requestOrdinal != null)), 'no_hits diagnostics calls');
  } else if (r.state === 'completed') {
    const kinds = r.result.blocks.map((b: any) => b.kind); const expected = kinds.includes('answer') ? (kinds.includes('gap') ? 'partial' : 'supported') : 'insufficient_evidence';
    check(r.result.answerability === expected, 'answerability');
  }
  let sources = 'NOT_OBSERVED';
  if (r.state === 'completed' && r.result.citations.length) {
    try {
      const db = new DatabaseSync(`${root}/state/generations/${r.generation}/evidence.sqlite`, { readOnly: true });
      const rows = db.prepare('select id,version,record from sources').all() as any[]; db.close();
      const map = new Map(rows.map(x => [x.id, { ...x, record: JSON.parse(x.record) }]));
      for (const c of r.result.citations) { const s = map.get(c.sourceId); if (!s || c.sourceVersion !== s.version || c.generation !== r.generation || readFileSync(`${root}/workspace/${s.record.path}`, 'utf8').slice(c.start, c.end) !== c.quote) failures.push('source version/generation/UTF16'); }
      sources = 'PASS';
    } catch { sources = 'NOT_OBSERVED'; }
  } else if (r.state === 'completed') sources = 'PASS (zero citations)';
  if (failures.includes('source version/generation/UTF16')) sources = 'FAIL';
  return {id:r.id,state:r.state,answerability:r.result?.answerability ?? null,get:ref,stream:stream?.ref ?? 'NOT_OBSERVED',history:history ? `events.jsonl:${history.line}` : 'NOT_OBSERVED',settledEvent:settled.length ? 'OBSERVED' : 'NOT_OBSERVED',cursors:fs.map(f=>({cursor:f.cursor,type:f.data.type,progress:f.data.event?.type})),finishedAt:r.finishedAt,settledAt:r.settledAt,sourceCheck:sources,failures};
});
mkdirSync(output, { recursive: true }); writeFileSync(`${output}/audit.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result.map(({cursors,...x})=>x),null,2));
