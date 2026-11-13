import type { TranscriptContext, Usage } from '@earendil-works/pi-ai';
import type { DiagnosticCounts, DiagnosticSink } from '../diagnostics/contracts.js';
import { ClecError } from '../domain/errors.js';

const serializedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
/** Observed transcript components, not replayed active state or HTTP payload bytes.
 * messageBytes includes system messages, so these measures deliberately overlap.
 * Omit unavailable components rather than reporting a fabricated observed zero.
 */
function transcriptComponentBytes(context: TranscriptContext): DiagnosticCounts {
  if (!Array.isArray(context.messages)) return {};
  const counts: DiagnosticCounts = { messageBytes: serializedBytes(context.messages) };
  for (const message of context.messages) {
    if (message.role !== 'system') continue;
    // Named sections include the actual preamble even when content is empty.
    counts.systemBytes = (counts.systemBytes ?? 0) + serializedBytes(message.content) +
      (message.sections === undefined ? 0 : serializedBytes(message.sections));
    // Measure declarations/removals as observed, not a synthetic current tools array.
    if (message.toolsAdded !== undefined) counts.toolBytes = (counts.toolBytes ?? 0) + serializedBytes(message.toolsAdded);
    if (message.toolsRemoved !== undefined) counts.toolBytes = (counts.toolBytes ?? 0) + serializedBytes(message.toolsRemoved);
  }
  return counts;
}

/** Conservative accounting units, NOT tokenizer tokens. Every request reserves output. */
export class ModelBudget {
  attempts = 0;
  admitted = 0;
  reservedUnits = 0;
  readonly usages: Usage[] = [];
  constructor(private readonly maxUnits: number, private readonly priced: boolean, private readonly diagnostics: DiagnosticSink, private readonly runId: string) {}
  admit(context: TranscriptContext): void {
    this.attempts++;
    const contextBytes = serializedBytes(context);
    const units = contextBytes + 2048;
    const counts = { requestedUnits: units, contextBytes, ...transcriptComponentBytes(context), outputReserve: 2048,
      reservedUnits: this.reservedUnits, limitUnits: this.maxUnits, modelCalls: this.admitted };
    if (this.admitted >= 4 || this.reservedUnits + units > this.maxUnits) {
      this.diagnostics.record({ runId: this.runId, requestOrdinal: this.attempts, stage: 'admission', code: 'REFUSED', reason: 'MODEL_BUDGET', counts });
      throw new ClecError('MODEL_BUDGET', 'Conservative serialized context plus output admission budget exhausted.');
    }
    this.admitted++;
    this.reservedUnits += units;
    this.diagnostics.record({ runId: this.runId, requestOrdinal: this.attempts, stage: 'admission', code: 'ADMITTED', counts });
  }
  metrics(): Record<string, number> {
    const result: Record<string, number> = { modelCalls: this.admitted, modelRequestAttempts: this.attempts,
      contextAdmissionUnits: this.reservedUnits, usageReports: this.usages.length,
      usageComplete: this.usages.length === this.admitted ? 1 : 0, costEstimateAvailable: this.priced && this.usages.length === this.admitted ? 1 : 0 };
    if (this.usages.length || this.admitted === 0) {
      result.inputTokens = this.usages.reduce((n, u) => n + u.input, 0);
      result.outputTokens = this.usages.reduce((n, u) => n + u.output, 0);
      result.cacheReadTokens = this.usages.reduce((n, u) => n + u.cacheRead, 0);
      result.cacheWriteTokens = this.usages.reduce((n, u) => n + u.cacheWrite, 0);
      if (this.priced && this.usages.length === this.admitted) result.estimatedCostUsd = this.usages.reduce((n, u) => n + u.cost.total, 0);
      else if (this.priced && this.usages.length) result.knownEstimatedCostUsd = this.usages.reduce((n, u) => n + u.cost.total, 0);
    }
    return result;
  }
}
