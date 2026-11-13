import { LocalDiagnosticSink } from '../diagnostics/local.js';
import type { AppConfig } from '../config.js';
import { SessionStore, RunScheduler, type RunExecutor } from '../sessions/index.js';
import { createHttpTransport, type HttpTransport } from '../http/index.js';
import { answerQuestion } from '../qa/service.js';
import { associateConversation, openConversation } from '../qa/conversation.js';
import { dependenciesReady } from './readiness.js';

export function createApplication(config: AppConfig) {
  const diagnostics = new LocalDiagnosticSink(config.diagnosticPath);
  const store = new SessionStore({ databasePath: config.sessionDatabase, piSessionDirectory: config.piSessionDirectory });
  let scheduler: RunScheduler;
  try {
    const executor: RunExecutor = async (context, signal, output) => {
      // Future queued questions are excluded, including when submitted before this run starts.
      const runs = store.listRuns(context.sessionId);
      const manager = openConversation(config.workspace, config.piSessionDirectory, context.piSession,
        new Set(runs.filter(run => run.state === 'completed').map(run => run.id)));
      const position = runs.findIndex(run => run.id === context.runId);
      const priorQuestions = runs.slice(0, position).filter(run => run.state === 'completed').slice(-3).map(run => run.question);
      return answerQuestion(config, { runId: context.runId, question: context.question, signal, diagnostics, manager, priorQuestions, filter: context.filter,
        associate: () => associateConversation(manager, config.piSessionDirectory, output.associatePiSession),
        pinGeneration: output.pinGeneration, emit: output.emit, reportMetrics: output.recordMetrics });
    };
    scheduler = new RunScheduler(store, executor, { defaultTimeoutMs: config.deadlineMs, diagnostics });
  } catch (error) { store.close(); throw error; }
  let accepting = true;
  const readinessAbort = new AbortController();
  const checks = new Set<Promise<boolean>>();
  const ready = (): Promise<boolean> => {
    if (!accepting) return Promise.resolve(false);
    const task = dependenciesReady(config, readinessAbort.signal).then(value => value && accepting);
    checks.add(task);
    void task.finally(() => checks.delete(task));
    return task;
  };
  let shutdownPromise: Promise<void> | undefined;
  let transport: HttpTransport;
  try { transport = createHttpTransport({ store, scheduler, diagnostics, readiness: ready, maxQuestionChars: 2000, maxRunTimeoutMs: 600_000 }); }
  catch (error) { store.close(); throw error; }
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    accepting = false;
    transport.stopAdmission();
    readinessAbort.abort();
    // shutdown() synchronously stops scheduler admission before its first await.
    const executions = scheduler.shutdown();
    shutdownPromise = (async () => {
      try { await executions; }
      finally {
        try { await transport.close(); await Promise.all([...checks]); }
        finally { store.close(); }
      }
    })();
    return shutdownPromise;
  };
  return { store, scheduler, transport, ready, shutdown };
}

export async function serve(config: AppConfig, signal: AbortSignal): Promise<void> {
  const app = createApplication(config);
  const stop = () => { void app.shutdown().catch(() => undefined); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      app.transport.server.once('error', reject);
      app.transport.server.listen(config.port, '127.0.0.1', () => {
        app.transport.server.off('error', reject); resolve();
      });
    });
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const stopped = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const cleanup = () => { signal.removeEventListener('abort', stopped); app.transport.server.off('error', failed); };
      signal.addEventListener('abort', stopped, { once: true });
      app.transport.server.once('error', failed);
      if (signal.aborted) stopped();
    });
  } finally { signal.removeEventListener('abort', stop); await app.shutdown(); }
}
