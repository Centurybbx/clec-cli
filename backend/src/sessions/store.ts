import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Citation } from '../domain/contracts.js';
import { validateSearchFilter, type SearchFilter } from '../domain/search-filter.js';
import type {
  EventPageOptions, HostMessage, HostRun, HostSession, PiSessionReference,
  PublicRunError, SessionEvent, SessionEventData, ValidatedAnswer,
} from './types.js';
import { identifier, nonempty, piReference, requireValue } from './validation.js';

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const interrupted: PublicRunError = { code: 'INTERRUPTED', message: 'Execution was interrupted. Submit a new request to try again.' };

export interface SessionStoreOptions { databasePath: string; piSessionDirectory: string }

/** One scheduler owns this local database. Never point this at an evidence SQLite file. */
export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly owner = randomUUID();
  private readonly piDirectory: string;
  private closed = false;
  private schedulerAttached = false;

  constructor(options: SessionStoreOptions) {
    nonempty(options.databasePath);
    nonempty(options.piSessionDirectory);
    const databasePath = resolve(options.databasePath);
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(resolve(options.piSessionDirectory), { recursive: true, mode: 0o700 });
    this.piDirectory = realpathSync(resolve(options.piSessionDirectory));
    this.db = new DatabaseSync(databasePath);
    try {
      const existingTables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      const tables = new Set(['session_schema', 'session_owner', 'sessions', 'runs', 'messages', 'session_events']);
      requireValue(existingTables.every(row => tables.has(String(row.name))), 'WRONG_DATABASE', 'Use a dedicated sessions database.');
      if (existingTables.length > 0) {
        requireValue(existingTables.some(row => row.name === 'session_schema'), 'SCHEMA_VERSION', 'Unsupported session schema.');
        const versions = this.db.prepare('SELECT version FROM session_schema').all();
        requireValue(versions.length === 1 && versions[0]?.version === 3, 'SCHEMA_VERSION', 'Unsupported session schema. Preserve the old database and use a fresh state directory for schema 3 and a fresh Pi directory.');
      }
      this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;`);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_schema (version INTEGER NOT NULL CHECK(version = 3));
        CREATE TABLE IF NOT EXISTS session_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), token TEXT NOT NULL, pid INTEGER NOT NULL, host TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          pi_json TEXT CHECK(pi_json IS NULL OR json_valid(pi_json))
        );
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          question TEXT NOT NULL, filter_json TEXT NOT NULL CHECK(json_valid(filter_json)), state TEXT NOT NULL CHECK(state IN ('queued','running','completed','failed','cancelled','timed_out')),
          created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, settled_at TEXT,
          timeout_ms INTEGER NOT NULL CHECK(timeout_ms > 0), generation TEXT,
          error_json TEXT CHECK(error_json IS NULL OR json_valid(error_json)),
          result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
          CHECK((state IN ('queued','running') AND finished_at IS NULL) OR (state NOT IN ('queued','running') AND finished_at IS NOT NULL))
        );
        CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_session ON runs(session_id) WHERE state = 'running';
        CREATE TABLE IF NOT EXISTS messages (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('user','assistant')),
          status TEXT NOT NULL CHECK(status IN ('input','partial','final')), text TEXT NOT NULL,
          citations_json TEXT NOT NULL CHECK(json_valid(citations_json)), created_at TEXT NOT NULL,
          UNIQUE(run_id, role), CHECK((role = 'user' AND status = 'input') OR (role = 'assistant' AND status IN ('partial','final')))
        );
        CREATE TABLE IF NOT EXISTS session_events (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json))
        );
        CREATE INDEX IF NOT EXISTS events_session ON session_events(session_id, cursor);
      `);
      this.transaction(() => {
        const versions = this.db.prepare('SELECT version FROM session_schema').all();
        requireValue(versions.length <= 1 && (versions.length === 0 || versions[0]?.version === 3), 'SCHEMA_VERSION', 'Unsupported session schema.');
        if (versions.length === 0) this.db.prepare('INSERT INTO session_schema VALUES (3)').run();
        const existing = this.db.prepare('SELECT * FROM session_owner WHERE singleton = 1').get();
        if (existing) {
          requireValue(existing.host === hostname(), 'STORE_BUSY', 'Session database belongs to another host.');
          let alive = true;
          try { process.kill(Number(existing.pid), 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
          requireValue(!alive, 'STORE_BUSY', 'Session database already has a live owner.');
        }
        this.db.prepare('INSERT OR REPLACE INTO session_owner VALUES (1, ?, ?, ?)').run(this.owner, process.pid, hostname());
        const pending = this.db.prepare("SELECT id FROM runs WHERE state IN ('queued','running')").all();
        for (const row of pending) this.terminal(String(row.id), 'failed', interrupted);
        // A cancelled/timed-out executor may have died before its finally block.
        const unsettled = this.db.prepare('SELECT id FROM runs WHERE settled_at IS NULL AND finished_at IS NOT NULL').all();
        for (const row of unsettled) this.settle(String(row.id));
      });
    } catch (error) { this.db.close(); throw error; }
  }

  private transaction<T>(operation: () => T): T {
    this.ensureOpen();
    // Nested calls participate in the caller's atomic unit.
    if (this.db.isTransaction) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private ensureOpen(): void { requireValue(!this.closed, 'STORE_CLOSED', 'Session store is closed.'); }
  private event(run: HostRun, data: SessionEventData): SessionEvent {
    const createdAt = now();
    const row = this.db.prepare('INSERT INTO session_events(session_id,run_id,created_at,data_json) VALUES (?,?,?,?)')
      .run(run.sessionId, run.id, createdAt, JSON.stringify(data));
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(createdAt, run.sessionId);
    return { cursor: Number(row.lastInsertRowid), sessionId: run.sessionId, runId: run.id, createdAt, data };
  }
  createSession(input: { title?: string } = {}): HostSession {
    this.ensureOpen();
    const title = input.title ?? '';
    requireValue(typeof title === 'string' && title.length <= 500);
    const id = randomUUID(); const createdAt = now();
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,NULL)').run(id, title, createdAt, createdAt);
    return this.getSession(id);
  }
  listSessions(options: { limit?: number; offset?: number } = {}): HostSession[] {
    this.ensureOpen();
    const limit = options.limit ?? 100; const offset = options.offset ?? 0;
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000 && Number.isSafeInteger(offset) && offset >= 0);
    return this.db.prepare('SELECT id FROM sessions ORDER BY created_at DESC, id LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => this.getSession(String(row.id)));
  }
  getSession(id: string): HostSession {
    this.ensureOpen(); identifier(id);
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    requireValue(row, 'SESSION_NOT_FOUND', 'Session was not found.');
    return { id: String(row.id), title: String(row.title), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      piSession: row.pi_json === null ? null : json<PiSessionReference>(row.pi_json) };
  }
  deleteSession(id: string): void {
    this.transaction(() => {
      this.getSession(id);
      requireValue(!this.isBusy(id), 'SESSION_BUSY', 'Cancel and await all session runs before deletion.');
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    });
  }
  isBusy(id?: string): boolean {
    this.ensureOpen();
    if (id !== undefined) identifier(id);
    const where = "(state IN ('queued','running') OR (started_at IS NOT NULL AND settled_at IS NULL))";
    return Boolean(id === undefined ? this.db.prepare(`SELECT 1 FROM runs WHERE ${where} LIMIT 1`).get()
      : this.db.prepare(`SELECT 1 FROM runs WHERE session_id = ? AND ${where} LIMIT 1`).get(id));
  }
  getRun(id: string): HostRun {
    this.ensureOpen(); identifier(id);
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    requireValue(row, 'RUN_NOT_FOUND', 'Run was not found.');
    return this.runRow(row);
  }
  private runRow(row: Row): HostRun {
    const nullable = (key: string): string | null => row[key] === null ? null : String(row[key]);
    return { id: String(row.id), requestId: String(row.request_id), sessionId: String(row.session_id), question: String(row.question),
      filter: json<SearchFilter>(row.filter_json),
      state: row.state as HostRun['state'], createdAt: String(row.created_at), startedAt: nullable('started_at'),
      finishedAt: nullable('finished_at'), settledAt: nullable('settled_at'), timeoutMs: Number(row.timeout_ms), generation: nullable('generation'),
      error: row.error_json === null ? null : json<PublicRunError>(row.error_json),
      result: row.result_json === null ? null : json<ValidatedAnswer>(row.result_json),
      metrics: this.runMetrics(String(row.id)) };
  }
  private runMetrics(id: string): Record<string, number> | null {
    const row = this.db.prepare("SELECT data_json FROM session_events WHERE run_id = ? AND json_extract(data_json, '$.type') = 'metrics' ORDER BY cursor DESC LIMIT 1").get(id);
    return row ? json<{ metrics: Record<string, number> }>(row.data_json).metrics : null;
  }
  recordMetrics(id: string, metrics: Record<string, number>): SessionEvent {
    return this.transaction(() => {
      const run = this.getRun(id);
      requireValue(run.startedAt !== null && run.settledAt === null, 'RUN_NOT_RUNNING');
      requireValue(metrics !== null && typeof metrics === 'object' && !Array.isArray(metrics));
      requireValue(Object.values(metrics).every(n => Number.isFinite(n) && n >= 0));
      return this.event(run, { type: 'metrics', metrics });
    });
  }
  listRuns(sessionId: string): HostRun[] {
    this.getSession(sessionId);
    return this.db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY rowid').all(sessionId).map(row => this.runRow(row));
  }
  listMessages(sessionId: string): HostMessage[] {
    this.getSession(sessionId);
    return this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sequence').all(sessionId).map(row => ({
      id: String(row.id), sessionId, runId: String(row.run_id), role: row.role as HostMessage['role'],
      status: row.status as HostMessage['status'], text: String(row.text), citations: json<Citation[]>(row.citations_json), createdAt: String(row.created_at),
    }));
  }
  readEvents(sessionId: string, options: EventPageOptions = {}): SessionEvent[] {
    this.getSession(sessionId);
    const after = options.after ?? 0; const limit = options.limit ?? 100;
    requireValue(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit > 0 && limit <= 1000);
    if (options.runId !== undefined) {
      requireValue(this.getRun(options.runId).sessionId === sessionId, 'RUN_NOT_FOUND', 'Run was not found.');
    }
    const rows = options.runId === undefined
      ? this.db.prepare('SELECT * FROM session_events WHERE session_id = ? AND cursor > ? ORDER BY cursor LIMIT ?').all(sessionId, after, limit)
      : this.db.prepare('SELECT * FROM session_events WHERE session_id = ? AND run_id = ? AND cursor > ? ORDER BY cursor LIMIT ?').all(sessionId, options.runId, after, limit);
    return rows.map(row => ({ cursor: Number(row.cursor), sessionId, runId: String(row.run_id), createdAt: String(row.created_at), data: json<SessionEventData>(row.data_json) }));
  }

  /** Scheduler integration methods: mutations always commit before returning envelopes. */
  attachScheduler(): void {
    this.ensureOpen(); requireValue(!this.schedulerAttached, 'SCHEDULER_ATTACHED', 'Store already has a scheduler.');
    this.schedulerAttached = true;
  }
  enqueue(sessionId: string, requestId: string, question: string, timeoutMs: number, inputFilter?: SearchFilter): { run: HostRun; event: SessionEvent | null } {
    // One admission parser for HTTP, CLI and programmatic submissions. The
    // persisted canonical representation participates in request idempotence.
    const filter = validateSearchFilter(inputFilter === undefined ? {} : inputFilter);
    const filterJson = JSON.stringify(filter);
    return this.transaction(() => {
      this.getSession(sessionId); identifier(requestId); nonempty(question);
      const existing = this.db.prepare('SELECT * FROM runs WHERE request_id = ?').get(requestId);
      if (existing) {
        const run = this.runRow(existing);
        requireValue(run.sessionId === sessionId && run.question === question && run.timeoutMs === timeoutMs && JSON.stringify(run.filter) === filterJson,
          'REQUEST_CONFLICT', 'Request ID was already used with different input.');
        return { run, event: null };
      }
      const id = randomUUID(); const createdAt = now();
      this.db.prepare("INSERT INTO runs(id,request_id,session_id,question,filter_json,state,created_at,timeout_ms) VALUES (?,?,?,?,?,'queued',?,?)")
        .run(id, requestId, sessionId, question, filterJson, createdAt, timeoutMs);
      this.db.prepare("INSERT INTO messages(id,session_id,run_id,role,status,text,citations_json,created_at) VALUES (?,?,?,'user','input',?,'[]',?)")
        .run(randomUUID(), sessionId, id, question, createdAt);
      const run = this.getRun(id);
      return { run, event: this.event(run, { type: 'queued', question, filter }) };
    });
  }
  start(id: string): SessionEvent {
    return this.transaction(() => {
      const run = this.getRun(id); requireValue(run.state === 'queued', 'RUN_NOT_QUEUED');
      this.db.prepare("UPDATE runs SET state = 'running', started_at = ? WHERE id = ?").run(now(), id);
      return this.event(run, { type: 'running' });
    });
  }
  pinGeneration(id: string, generation: string): SessionEvent {
    return this.transaction(() => {
      identifier(generation); const run = this.requireRunning(id);
      requireValue(run.generation === null || run.generation === generation, 'GENERATION_ALREADY_PINNED');
      this.db.prepare('UPDATE runs SET generation = ? WHERE id = ?').run(generation, id);
      return this.event(run, { type: 'generation', generation });
    });
  }
  associatePiSession(id: string, reference: PiSessionReference): SessionEvent {
    return this.transaction(() => {
      const run = this.requireRunning(id); const safe = piReference(reference, this.piDirectory);
      this.db.prepare('UPDATE sessions SET pi_json = ? WHERE id = ?').run(JSON.stringify(safe), run.sessionId);
      return this.event(run, { type: 'pi_session', reference: safe });
    });
  }
  requireRunning(id: string): HostRun {
    const run = this.getRun(id); requireValue(run.state === 'running', 'RUN_NOT_RUNNING', 'Run is no longer running.'); return run;
  }
  progress(id: string, data: { type: 'progress'; event: import('./types.js').ExecutionProgressEvent }): SessionEvent {
    return this.transaction(() => {
      const run = this.requireRunning(id);
      requireValue(data.event.type === 'search' || data.event.type === 'read', 'INVALID_EVENT');
      return this.event(run, data);
    });
  }
  complete(id: string, result: ValidatedAnswer): SessionEvent[] {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (run.state !== 'running') return [];
      this.db.prepare(`INSERT INTO messages(id,session_id,run_id,role,status,text,citations_json,created_at)
        VALUES (?,?,?,'assistant','final',?,?,?) ON CONFLICT(run_id,role) DO UPDATE SET status='final',text=excluded.text,citations_json=excluded.citations_json`)
        .run(randomUUID(), run.sessionId, id, result.text, JSON.stringify(result.citations), now());
      this.db.prepare('UPDATE runs SET result_json = ? WHERE id = ?').run(JSON.stringify(result), id);
      const events = [this.event(run, { type: 'progress', event: { type: 'text', text: result.text } })];
      for (const citation of result.citations) events.push(this.event(run, { type: 'progress', event: { type: 'citation', citation } }));
      const terminal = this.terminal(id, 'completed', null);
      if (terminal) events.push(terminal);
      return events;
    });
  }
  terminal(id: string, state: Exclude<HostRun['state'], 'queued' | 'running'>, error: PublicRunError | null): SessionEvent | null {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (run.state !== 'queued' && run.state !== 'running') return null;
      const timestamp = now();
      this.db.prepare('UPDATE runs SET state=?,finished_at=?,error_json=?,settled_at=? WHERE id=?')
        .run(state, timestamp, error === null ? null : JSON.stringify(error), run.state === 'queued' ? timestamp : null, id);
      return this.event(run, { type: 'terminal', state, error, result: state === 'completed' ? run.result : null });
    });
  }
  settle(id: string): SessionEvent | null {
    return this.transaction(() => {
      const run = this.getRun(id);
      if (run.settledAt !== null) return null;
      requireValue(run.finishedAt !== null, 'RUN_NOT_TERMINAL');
      this.db.prepare('UPDATE runs SET settled_at = ? WHERE id = ?').run(now(), id);
      return this.event(run, { type: 'settled' });
    });
  }
  close(): void {
    if (this.closed) return;
    requireValue(!this.isBusy(), 'STORE_BUSY', 'Await scheduler shutdown before closing the store.');
    this.transaction(() => { this.db.prepare('DELETE FROM session_owner WHERE token = ?').run(this.owner); });
    this.db.close(); this.closed = true;
  }
}
