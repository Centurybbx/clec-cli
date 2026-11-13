import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { ClecError, checkAbort } from '../domain/errors.js';
import { scopedQuestion } from '../io/scoped-question.js';

/** Thin client of the composed HTTP service. Never opens a second sessions DB owner. */
export async function sessionCommand(config: AppConfig, args: string[], signal: AbortSignal, write: (value: unknown) => void): Promise<void> {
  const [command, sessionId, ...rest] = args;
  const base = `http://127.0.0.1:${config.port}`;
  const endpoint = (path: string) => new URL(path, base);
  const json = async (path: string, body?: object) => {
    const response = await fetch(endpoint(path), { signal, redirect: 'error',
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new ClecError('SESSION_HTTP', `Session service returned HTTP ${response.status}.`); }
    return response.json() as Promise<unknown>;
  };
  if (command === 'create') {
    write(await json('/v1/sessions', { title: args.slice(1).join(' ') })); return;
  }
  if (command === 'list' && args.length === 1) { write(await json('/v1/sessions')); return; }
  if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sessionId)) throw new ClecError('USAGE', 'session create [title] | list | ask <session-id> <question> | history <session-id>');
  const path = `/v1/sessions/${encodeURIComponent(sessionId)}`;
  if (command === 'history' && !rest.length) { write(await json(`${path}/messages`)); return; }
  if (command !== 'ask' || !rest.length) throw new ClecError('USAGE', 'session ask <session-id> <question>');
  const { question, filter } = scopedQuestion(rest);
  if (!question.trim() || question.length > 2000) throw new ClecError('INVALID_QUERY', 'Question must contain 1–2000 characters.');
  const accepted = await json(`${path}/runs`, { question, requestId: randomUUID(), ...(filter ? { filter } : {}) });
  if (!accepted || typeof accepted !== 'object' || !('id' in accepted) || typeof accepted.id !== 'string') throw new ClecError('SESSION_HTTP', 'Invalid run response.');
  write(accepted);
  // A disconnect/caller interrupt detaches observation, never cancels the durable run.
  const response = await fetch(endpoint(`${path}/events?runId=${encodeURIComponent(accepted.id)}&after=0`), { signal, redirect: 'error' });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new ClecError('SESSION_HTTP', 'Could not open run events; use HTTP reconnect or session history.'); }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (true) {
      checkAbort(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) write(JSON.parse(data) as unknown);
      }
      if (buffered.length > 16_777_216) throw new ClecError('SESSION_HTTP', 'Event frame exceeded the client limit.');
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const result = await json(`${path}/runs/${encodeURIComponent(accepted.id)}`);
  write(result);
  if (!result || typeof result !== 'object' || !('state' in result) || result.state !== 'completed') throw new ClecError('RUN_FAILED', 'Durable run did not complete; inspect the returned run state.');
}
