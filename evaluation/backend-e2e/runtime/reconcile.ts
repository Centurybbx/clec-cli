/** Independent public transport checks, not the production validator or semantic grading. */
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function reconcile(run: any, messages: any, live: any[], replay: any[]) {
  const checks: Record<string, boolean> = {};
  const inspect = (frames: any[], prefix: string) => {
    checks[prefix + '_envelopes'] = frames.every((f, i) => Number.isSafeInteger(f.envelope?.cursor) && f.id === String(f.envelope.cursor) && f.event === f.envelope.data?.type && f.envelope.sessionId === run.sessionId && f.envelope.runId === run.id && (i === 0 || f.envelope.cursor > frames[i-1].envelope.cursor));
  };
  inspect(live, 'live'); inspect(replay, 'replay');
  checks.replay_matches = equal(live, replay);
  const data = live.map(f => f.envelope.data), terminals = data.filter(d => d.type === 'terminal');
  checks.one_terminal = terminals.length === 1;
  checks.terminal_matches_get = terminals.length === 1 && terminals[0].state === run.state && equal(terminals[0].error, run.error) && equal(terminals[0].result, run.result);
  checks.settled = !!run.settledAt;
  const progress = data.filter(d => d.type === 'progress').map(d => d.event);
  const texts = progress.filter(e => e.type === 'text').map(e => e.text);
  const cites = progress.filter(e => e.type === 'citation').map(e => e.citation);
  const assistants = (messages?.messages ?? []).filter((m: any) => m.runId === run.id && m.role === 'assistant');
  if (run.state === 'completed' && run.result) {
    const r = run.result;
    checks.validated = r.validated === true;
    checks.final_text = equal(texts, [r.text]);
    checks.final_citations = equal(cites, r.citations);
    checks.history = assistants.length === 1 && assistants[0].status === 'final' && assistants[0].text === r.text && equal(assistants[0].citations, r.citations);
    const ids = (r.blocks ?? []).flatMap((b: any) => b.evidenceIds ?? []);
    const unique = [...new Set(ids)];
    checks.block_citation_order = equal(unique, (r.citations ?? []).map((c: any) => c.id));
    checks.citation_generation = (r.citations ?? []).every((c: any) => c.generation === run.generation);
    const versions = new Map<string, string>();
    checks.source_versions_consistent = (r.citations ?? []).every((c: any) => { const old = versions.get(c.sourceId); versions.set(c.sourceId, c.sourceVersion); return old === undefined || old === c.sourceVersion; });
  } else {
    checks.no_result = run.result === null;
    checks.no_final_events = texts.length === 0 && cites.length === 0;
    checks.no_assistant_history = assistants.length === 0;
  }
  return {checks, mechanical: Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL', semantic: 'manual review required', note: 'Empty citations do not establish support; inspect every block and its claims.'};
}
