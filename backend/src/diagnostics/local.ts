import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { ANSWER_PROTOCOL_REASONS, COUNT_FIELDS, FAILURE_REASONS, type DiagnosticRecord, type DiagnosticSink } from './contracts.js';

const STAGES = new Set(['qa', 'admission', 'provider', 'scheduler', 'cleanup', 'http', 'cli']);
const CODES = new Set(['BEGIN', 'SUCCESS', 'FAILURE', 'CLEANUP_FAILURE', 'ADMITTED', 'REFUSED', 'HTTP_RESPONSE',
  'ABORT_REQUESTED', 'FIRST_PROVIDER_EVENT', 'STREAM_END', 'STREAM_ABORT', 'LOCAL_SETTLED', 'CANCELLED', 'TIMED_OUT', 'COMMITTED']);
const MAX_RECORD_BYTES = 4096;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Content-free synchronous append; visibility is not fsync/crash durability. Never throws. */
export class LocalDiagnosticSink implements DiagnosticSink {
  private sequence = 0;
  private drops = 0;
  private warned = false;
  constructor(private readonly path: string) {}
  get dropped(): number { return this.drops; }
  record(event: DiagnosticRecord): void {
    try {
      if (!STAGES.has(event.stage) || !CODES.has(event.code) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(event.runId)) throw new Error();
      const counts: Record<string, number> = {};
      for (const field of COUNT_FIELDS) {
        const n = event.counts?.[field];
        if (typeof n === 'number' && Number.isFinite(n) && n >= 0) counts[field] = n;
      }
      const line = `${JSON.stringify({ sequence: ++this.sequence, timestamp: new Date().toISOString(), runId: event.runId,
        ...(Number.isSafeInteger(event.requestOrdinal) && event.requestOrdinal! > 0 ? { requestOrdinal: event.requestOrdinal } : {}),
        stage: event.stage, code: event.code,
        ...(event.reason && FAILURE_REASONS.includes(event.reason) ? { reason: event.reason } : {}),
        ...(event.stage === 'qa' && event.code === 'FAILURE' && event.reason === 'ANSWER_PROTOCOL' &&
          event.answerProtocolReason && ANSWER_PROTOCOL_REASONS.includes(event.answerProtocolReason)
          ? { answerProtocolReason: event.answerProtocolReason } : {}), counts })}\n`;
      const bytes = Buffer.byteLength(line);
      if (bytes > MAX_RECORD_BYTES) throw new Error();
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (existsSync(this.path) && statSync(this.path).size + bytes > MAX_FILE_BYTES) {
        if (existsSync(`${this.path}.2`)) unlinkSync(`${this.path}.2`);
        if (existsSync(`${this.path}.1`)) renameSync(`${this.path}.1`, `${this.path}.2`);
        renameSync(this.path, `${this.path}.1`);
      }
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      this.drops++;
      if (!this.warned) {
        this.warned = true;
        try { process.stderr.write('CLEC diagnostics unavailable; records dropped.\n'); } catch { /* No secondary failure. */ }
      }
    }
  }
}
