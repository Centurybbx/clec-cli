import { failureReason, silentDiagnostics, type DiagnosticSink } from '../diagnostics/contracts.js';
import { createServer, type Server } from 'node:http';
import type { RunScheduler, SessionStore } from '../sessions/index.js';
import * as dto from './dto.js';
import { fields, HttpError, id, integer, invalid, jsonBody, noBody, parseUrl, query, queryInteger, send, sendError, text } from './protocol.js';
import { openEventStream } from './sse.js';
import type { SearchFilter } from '../domain/search-filter.js';

export interface HttpTransportOptions {
  diagnostics?: DiagnosticSink;
  store: SessionStore;
  scheduler: RunScheduler;
  /** Explicit production readiness: dependencies, active generation and acceptance. */
  readiness?: () => boolean | Promise<boolean>;
  maxJsonBytes?: number;
  /** Must match the production QA/search input contract. */
  maxQuestionChars?: number;
  /** Admission ceiling, not a second execution timer. */
  maxRunTimeoutMs?: number;
  maxSseBufferedBytes?: number;
  maxEventStreams?: number;
}
export interface HttpTransport {
  /** Native server; host explicitly calls listen(port, '127.0.0.1'). */
  server: Server;
  /** Stop new HTTP work while existing streams observe execution cleanup. */
  stopAdmission(): void;
  /** Idempotent; closes transport sockets/listeners only, never scheduler/store. */
  close(): Promise<void>;
}

export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const { store, scheduler } = options;
  const diagnostics = options.diagnostics ?? silentDiagnostics();
  const maxJsonBytes = integer(options.maxJsonBytes ?? 65_536, 1024, 1_048_576);
  const maxQuestionChars = integer(options.maxQuestionChars ?? 2000, 1, 32_768);
  const maxRunTimeoutMs = integer(options.maxRunTimeoutMs ?? 600_000, 1, 2_147_483_647);
  const maxSseBufferedBytes = integer(options.maxSseBufferedBytes ?? 1_048_576, 1024, 16_777_216);
  const maxEventStreams = integer(options.maxEventStreams ?? 256, 1, 4096);
  const streams = new Set<() => void>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const ownedRun = (sessionId: string, runId: string) => {
    store.getSession(sessionId);
    const run = store.getRun(runId);
    if (run.sessionId !== sessionId) throw new HttpError(404, 'RUN_NOT_FOUND', 'Resource was not found.');
    return run;
  };
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    let diagnosticRunId: string | undefined;
    void (async () => {
      if (closing) throw new HttpError(503, 'UNAVAILABLE', 'Service is unavailable.');
      const { url, path } = parseUrl(request);
      const method = request.method;
      if (method !== 'POST') noBody(request);
      if (path.length === 1 && path[0] === 'health' && method === 'GET') {
        query(url, ['check']);
        const check = url.searchParams.get('check') ?? 'live';
        if (check === 'live') { send(response, 200, { status: 'live' }); return; }
        if (check !== 'ready') invalid();
        let ready = false;
        // A missing callback must never imply production QA is ready.
        if (options.readiness) {
          let timer: NodeJS.Timeout | undefined;
          try {
            ready = await Promise.race([
              Promise.resolve().then(options.readiness),
              new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); timer.unref(); }),
            ]) === true;
          } catch { ready = false; }
          finally { if (timer) clearTimeout(timer); }
        }
        ready = ready && !closing;
        send(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' }); return;
      }
      if (path[0] !== 'v1' || path[1] !== 'sessions') throw new HttpError(404, 'NOT_FOUND', 'Resource was not found.');
      if (path.length === 2) {
        if (method === 'GET') {
          query(url, ['limit', 'offset']);
          const limit = queryInteger(url.searchParams.get('limit') ?? '100', 1, 1000);
          const offset = queryInteger(url.searchParams.get('offset') ?? '0', 0, Number.MAX_SAFE_INTEGER);
          send(response, 200, { sessions: store.listSessions({ limit, offset }).map(dto.session) }); return;
        }
        if (method === 'POST') {
          query(url, []);
          const body = fields(await jsonBody(request, maxJsonBytes), ['title']);
          const input = body.title === undefined ? {} : { title: text(body.title, 500, false) };
          const session = store.createSession(input);
          response.setHeader('Location', `/v1/sessions/${session.id}`);
          send(response, 201, dto.session(session)); return;
        }
      }
      const sessionId = path[2] === undefined ? undefined : id(path[2]);
      if (sessionId !== undefined) {
        if (path.length === 3) {
          query(url, []);
          if (method === 'GET') { send(response, 200, dto.session(store.getSession(sessionId))); return; }
          if (method === 'DELETE') { store.deleteSession(sessionId); send(response, 204); return; }
        }
        if (path.length === 4 && path[3] === 'messages' && method === 'GET') {
          query(url, []); send(response, 200, { messages: store.listMessages(sessionId).map(dto.message) }); return;
        }
        if (path.length === 4 && path[3] === 'runs') {
          query(url, []);
          if (method === 'GET') { send(response, 200, { runs: store.listRuns(sessionId).map(dto.run) }); return; }
          if (method === 'POST') {
            const body = fields(await jsonBody(request, maxJsonBytes), ['question', 'requestId', 'timeoutMs', 'filter']);
            const question = text(body.question, maxQuestionChars);
            const requestId = id(text(body.requestId, 128));
            const timeout = body.timeoutMs === undefined ? {} : { timeoutMs: integer(body.timeoutMs, 1, maxRunTimeoutMs) };
            // SessionStore's shared admission parser validates/canonicalizes
            // this untrusted field before any run/user message is inserted.
            const run = scheduler.enqueueRun({ sessionId, requestId, question, ...timeout,
              ...(body.filter === undefined ? {} : { filter: body.filter as SearchFilter }) });
            diagnosticRunId = run.id;
            diagnostics.record({ runId: run.id, stage: 'http', code: 'ADMITTED' });
            response.setHeader('Location', `/v1/sessions/${sessionId}/runs/${run.id}`);
            send(response, 202, dto.run(run)); return;
          }
        }
        if (path.length === 4 && path[3] === 'events' && method === 'GET') {
          query(url, ['after', 'runId']);
          store.getSession(sessionId);
          const filter = url.searchParams.get('runId');
          const runId = filter === null ? undefined : id(filter);
          if (runId !== undefined) ownedRun(sessionId, runId);
          const header = request.headers['last-event-id'];
          if (Array.isArray(header)) invalid();
          const afterQuery = url.searchParams.get('after');
          const after = queryInteger(afterQuery ?? header ?? '0', 0, Number.MAX_SAFE_INTEGER);
          if (header !== undefined) {
            const headerCursor = queryInteger(header, 0, Number.MAX_SAFE_INTEGER);
            if (afterQuery !== null && headerCursor !== after) invalid();
          }
          if (streams.size >= maxEventStreams) throw new HttpError(503, 'UNAVAILABLE', 'Service is unavailable.');
          let close = (): void => {};
          close = openEventStream({ store, scheduler, response, sessionId, after,
            ...(runId === undefined ? {} : { runId }), maxBufferedBytes: maxSseBufferedBytes,
            onClose: () => { streams.delete(close); } });
          streams.add(close); return;
        }
        if (path[3] === 'runs' && path[4] !== undefined) {
          const runId = id(path[4]);
          query(url, []);
          if (path.length === 5 && method === 'GET') { send(response, 200, dto.run(ownedRun(sessionId, runId))); return; }
          if (path.length === 6 && path[5] === 'cancel' && method === 'POST') {
            fields(await jsonBody(request, maxJsonBytes), []);
            ownedRun(sessionId, runId);
            send(response, 200, dto.run(scheduler.cancelRun(runId))); return;
          }
        }
      }
      throw new HttpError(404, 'NOT_FOUND', 'Resource was not found.');
    })().catch(error => {
      if (diagnosticRunId) diagnostics.record({ runId: diagnosticRunId, stage: 'http', code: 'FAILURE', reason: failureReason(error) });
      sendError(response, error);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    else socket.destroy();
  });
  return {
    server,
    stopAdmission() { closing = true; },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const close of [...streams]) close();
      closePromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { server.closeAllConnections(); }, 10_000);
        timer.unref();
        server.close(error => {
          clearTimeout(timer);
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
