import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionError } from '../sessions/index.js';
import { ClecError } from '../domain/errors.js';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export function invalid(): never { throw new HttpError(400, 'INVALID_REQUEST', 'Invalid request.'); }
export function id(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalid();
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid();
  return value;
}
export function queryInteger(value: string, min: number, max: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  return integer(Number(value), min, max);
}
export function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) invalid();
  return value;
}
export function query(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) invalid();
    seen.add(key);
  }
}
export function parseUrl(request: IncomingMessage): { url: URL; path: string[] } {
  const raw = request.url ?? '';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('#') || raw.includes('\\')) invalid();
  try {
    const rawPath = raw.split('?')[0]!;
    const path = rawPath.split('/').slice(1).map(part => decodeURIComponent(part));
    if (path.some(part => !part || part === '.' || part === '..' || /[/\\\u0000-\u001f\u007f]/.test(part))) invalid();
    return { url: new URL(raw, 'http://localhost'), path };
  } catch { return invalid(); }
}
export function noBody(request: IncomingMessage): void {
  if (request.headers['transfer-encoding'] !== undefined ||
    (request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) invalid();
}
export async function jsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use application/json with UTF-8 encoding.');
  }
  if (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Encoded request bodies are unsupported.');
  }
  const tooLarge = (): HttpError => new HttpError(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  if (Number(request.headers['content-length'] ?? 0) > maxBytes) throw tooLarge();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = (): void => {
      request.off('data', onData); request.off('end', onEnd);
      request.off('error', onError); request.off('aborted', onAborted);
    };
    const fail = (error: unknown): void => { cleanup(); request.pause(); reject(error); };
    const onError = (): void => fail(new HttpError(400, 'INVALID_REQUEST', 'Invalid request.'));
    const onAborted = (): void => onError();
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) { fail(tooLarge()); return; }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      try {
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(decoded) as unknown);
      } catch { reject(new HttpError(400, 'INVALID_REQUEST', 'Invalid JSON body.')); }
    };
    request.on('data', onData); request.once('end', onEnd);
    request.once('error', onError); request.once('aborted', onAborted);
  });
}
export function send(response: ServerResponse, status: number, value?: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}
export function sendError(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  let safe = error instanceof HttpError ? error : new HttpError(500, 'INTERNAL_ERROR', 'Internal server error.');
  if (error instanceof ClecError && error.code === 'INVALID_FILTER') safe = new HttpError(400, 'INVALID_FILTER', error.message);
  if (error instanceof SessionError) {
    if (error.code === 'INVALID_ARGUMENT') safe = new HttpError(400, 'INVALID_REQUEST', 'Invalid request.');
    else if (error.code === 'SESSION_NOT_FOUND' || error.code === 'RUN_NOT_FOUND') safe = new HttpError(404, error.code, 'Resource was not found.');
    else if (['REQUEST_CONFLICT', 'SESSION_BUSY', 'STORE_BUSY', 'SCHEDULER_CLOSED', 'STORE_CLOSED', 'RUN_NOT_RUNNING', 'RUN_NOT_QUEUED', 'RUN_NOT_TERMINAL'].includes(error.code)) {
      safe = new HttpError(409, error.code, 'Operation conflicts with current state.');
    }
  }
  // Stop parsing an unread/rejected body on a reusable connection.
  response.setHeader('Connection', 'close');
  send(response, safe.status, { error: { code: safe.code, message: safe.message } });
}
