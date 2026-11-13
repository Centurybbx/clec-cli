import type { SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { DiagnosticSink } from '../diagnostics/contracts.js';

interface RequestObservation { ended: boolean; abortRequested: boolean; signal: AbortSignal; onAbort(): void }
/** Public SDK callback observation only. Does not wrap, consume, delay or proxy streams. */
export class ProviderObservation {
  private readonly requests = new Map<number, RequestObservation>();
  constructor(private readonly runId: string, private readonly diagnostics: DiagnosticSink) {}
  options(ordinal: number, prior: SimpleStreamOptions | undefined, signal: AbortSignal): SimpleStreamOptions {
    const requestSignal = prior?.signal ? AbortSignal.any([signal, prior.signal]) : signal;
    let activity = false;
    const observation: RequestObservation = { ended: false, abortRequested: false, signal: requestSignal, onAbort: () => {
      if (observation.ended || observation.abortRequested) return;
      observation.abortRequested = true;
      this.diagnostics.record({ runId: this.runId, requestOrdinal: ordinal, stage: 'provider', code: 'ABORT_REQUESTED' });
    } };
    this.requests.set(ordinal, observation);
    requestSignal.addEventListener('abort', observation.onAbort, { once: true });
    if (requestSignal.aborted) observation.onAbort();
    return { ...prior, signal: requestSignal,
      onResponse: async (response, model) => {
        this.diagnostics.record({ runId: this.runId, requestOrdinal: ordinal, stage: 'provider', code: 'HTTP_RESPONSE' });
        await prior?.onResponse?.(response, model);
      },
      onProviderStreamEvent: async (event, model) => {
        if (!activity) {
          activity = true;
          this.diagnostics.record({ runId: this.runId, requestOrdinal: ordinal, stage: 'provider', code: 'FIRST_PROVIDER_EVENT' });
        }
        await prior?.onProviderStreamEvent?.(event, model);
      },
    };
  }
  /** Pi's normalized assistant message_end, not a remote cancellation/billing acknowledgment. */
  end(ordinal: number, aborted: boolean): void {
    const observation = this.requests.get(ordinal);
    if (!observation || observation.ended) return;
    observation.ended = true;
    observation.signal.removeEventListener('abort', observation.onAbort);
    this.diagnostics.record({ runId: this.runId, requestOrdinal: ordinal, stage: 'provider', code: aborted ? 'STREAM_ABORT' : 'STREAM_END' });
  }
  close(locallyIdle: boolean): void {
    for (const [ordinal, observation] of this.requests) {
      observation.signal.removeEventListener('abort', observation.onAbort);
      if (locallyIdle) this.diagnostics.record({ runId: this.runId, requestOrdinal: ordinal, stage: 'provider', code: 'LOCAL_SETTLED' });
    }
  }
}
