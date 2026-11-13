/** Render preserved real evidence without assigning semantic grades. */
import { readFileSync, writeFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node report.ts <evidence.jsonl> <new-report.json>');
const rows = readFileSync(input,'utf8').trim().split(/\r?\n/).map(line=>JSON.parse(line));
const dataset = rows.find(row=>row.type==='dataset');
const cases = rows.filter(row=>row.type==='case' || row.type==='case_error');
const admitted = rows.filter(row=>row.type==='admission' && row.response?.status===202).length;
const known = cases.map(row=>row.runRecord?.metrics ?? row.runRecord?.result?.metrics ?? row.fetched?.data?.metrics).filter(Boolean);
const totals: Record<string, number> = {};
for (const m of known) for (const [key,value] of Object.entries(m)) if (typeof value === 'number' && Number.isFinite(value) && /calls|attempt|cost/i.test(key)) totals[key]=(totals[key] ?? 0)+value;
writeFileSync(output, JSON.stringify({start:rows.find(row=>row.type==='start'),dataset,cases,
  counts:{planned:dataset?.caseCount ?? 'unknown', admitted, recorded:cases.length, completed:cases.filter(r=>r.runRecord?.state==='completed').length, failedOrCancelled:cases.filter(r=>['failed','cancelled','timed_out'].includes(r.runRecord?.state)).length, recordingErrors:cases.filter(r=>r.type==='case_error').length, notExecuted:dataset ? dataset.caseCount-admitted : 'unknown'},
  observedMetricTotals:totals, metricCoverage:{withMetrics:known.length, admitted, note:'Reported values only; missing or interrupted usage is unknown. Cost is an estimate, not a bill.'},
  scenarios:rows.filter(row=>row.type==='scenario'),budgetStops:rows.filter(row=>row.type==='budget_stop'),errors:rows.filter(row=>row.type==='error'),end:rows.find(row=>row.type==='end'),semanticVerdict:'manual review required'},null,2)+'\n',{flag:'wx',mode:0o600});
