import type { ServerResponse } from 'node:http';
import type { RunScheduler, SessionStore } from '../sessions/index.js';
import { event } from './dto.js';

export interface EventStreamOptions {
  store: SessionStore;
  scheduler: RunScheduler;
  response: ServerResponse;
  sessionId: string;
  runId?: string;
  after: number;
  maxBufferedBytes: number;
  onClose: () => void;
}

/** Durable pages are the only event queue. Notifications only schedule a read. */
export function openEventStream(options: EventStreamOptions): () => void {
  const { store, scheduler, response, sessionId, runId, maxBufferedBytes } = options;
  let cursor = options.after;
  let closed = false;
  let blockedAt = 0;
  let lastWriteAt = Date.now();
  let scheduled: NodeJS.Immediate | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe = (): void => {};
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (timer) clearInterval(timer);
    if (scheduled) clearImmediate(scheduled);
    response.off('close', cleanup); response.off('error', cleanup); response.off('drain', onDrain);
    options.onClose();
  };
  const close = (): void => { cleanup(); if (!response.destroyed) response.end(); };
  const drop = (): void => { cleanup(); response.destroy(); };
  const write = (frame: string): boolean => {
    // Account for Node's existing writable buffer before accepting another frame.
    if (Buffer.byteLength(frame) + response.writableLength > maxBufferedBytes) { drop(); return false; }
    lastWriteAt = Date.now();
    if (!response.write(frame)) blockedAt = Date.now();
    return true;
  };
  const schedule = (): void => {
    if (closed || blockedAt || scheduled) return;
    scheduled = setImmediate(() => { scheduled = undefined; drain(); });
  };
  const onDrain = (): void => { blockedAt = 0; schedule(); };
  const drain = (): void => {
    if (closed || blockedAt) return;
    try {
      const page = store.readEvents(sessionId, { after: cursor, limit: 64, ...(runId === undefined ? {} : { runId }) });
      for (const envelope of page) {
        if (envelope.cursor <= cursor) continue;
        const safe = event(envelope);
        if (!write(`id: ${envelope.cursor}\nevent: ${safe.data.type}\ndata: ${JSON.stringify(safe)}\n\n`)) return;
        cursor = envelope.cursor;
        if (blockedAt) return;
      }
      // Even a short page may race a subsequent commit; always finish replay first.
      if (page.length) { schedule(); return; }
      if (runId !== undefined) {
        const run = store.getRun(runId);
        if (run.sessionId !== sessionId) { drop(); return; }
        // Queued cancellation settles immediately without a separate settled event.
        if (run.settledAt !== null) close();
      }
    } catch { drop(); } // After headers, reconnect/GET reveals a sanitized status.
  };
  response.on('close', cleanup); response.on('error', cleanup); response.on('drain', onDrain);
  // Register before reading any pages: no replay/live handoff gap.
  unsubscribe = scheduler.subscribe(envelope => {
    if (envelope.sessionId === sessionId && (runId === undefined || envelope.runId === runId)) schedule();
  });
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
  });
  response.flushHeaders();
  write(': connected\n\n');
  timer = setInterval(() => {
    if (closed) return;
    if (blockedAt) {
      if (Date.now() - blockedAt >= 30_000) drop();
      return;
    }
    if (Date.now() - lastWriteAt >= 15_000) write(': heartbeat\n\n');
    // Also recover durable commits whose notification never reached this reader.
    schedule();
  }, 5_000);
  timer.unref();
  schedule();
  return close;
}
