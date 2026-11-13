#!/usr/bin/env node
import { resolve } from 'node:path';
import { ClecError, integer, isHash, reference, validDate } from './contracts.js';
import { defaultDataDir, managedBytes, openCurrent, sync } from './releases.js';
const usage = 'clec sync --manifest PATH | search QUERY [--match any|all --limit N --source ID --date-from DATE --date-to DATE] | read RELEASE:SECTION | source RELEASE:SOURCE [--offset N --limit N] | status; all accept --data-dir PATH';
async function main(): Promise<object> {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')) return { usage, commands: ['sync', 'search', 'read', 'source', 'status'], runtime: 'Node >=22.19.0 with built-in SQLite', distribution: 'No default public manifest URL is configured.' };
  const command = args.shift(); const positional: string[] = []; const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; if (!arg) continue;
    if (arg.startsWith('--')) { const value = args[++i]; if (!value || value.startsWith('--') || options.has(arg)) throw new ClecError('INVALID_ARGUMENT', usage); options.set(arg, value); }
    else positional.push(arg);
  }
  const allowed = command === 'sync' ? ['--manifest'] : command === 'search' ? ['--match', '--limit', '--source', '--date-from', '--date-to'] : command === 'source' ? ['--offset', '--limit'] : [];
  for (const key of options.keys()) if (key !== '--data-dir' && !allowed.includes(key)) throw new ClecError('INVALID_ARGUMENT', `Unknown option ${key}. ${usage}`);
  const directory = resolve(options.get('--data-dir') ?? defaultDataDir());
  const numeric = (key: string, fallback: number, minimum: number, maximum: number): number => {
    const value = options.get(key); if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new ClecError('INVALID_ARGUMENT', `${key} must be an integer.`);
    return integer(Number(value), minimum, maximum);
  };
  if (command === 'sync') { const manifest = options.get('--manifest'); if (!manifest || positional.length) throw new ClecError('INVALID_ARGUMENT', usage); return sync(directory, manifest); }
  if (command !== 'search' && command !== 'read' && command !== 'source' && command !== 'status') throw new ClecError('INVALID_ARGUMENT', usage);
  if (positional.length !== (command === 'status' ? 0 : 1)) throw new ClecError('INVALID_ARGUMENT', usage);
  const value = positional[0] ?? '';
  const ref = command === 'read' || command === 'source' ? reference(value) : undefined;
  const limit = numeric('--limit', command === 'search' ? 8 : 20, 1, command === 'search' ? 50 : 100);
  const offset = numeric('--offset', 0, 0, 10_000_000);
  const match = options.get('--match') ?? 'any';
  if (match !== 'any' && match !== 'all') throw new ClecError('INVALID_ARGUMENT', '--match must be any or all.');
  const source = options.get('--source'); if (source !== undefined && !isHash(source)) throw new ClecError('INVALID_ARGUMENT', '--source needs a source SHA-256 ID.');
  const dateFrom = options.get('--date-from'); const dateTo = options.get('--date-to');
  if ((dateFrom !== undefined && !validDate(dateFrom)) || (dateTo !== undefined && !validDate(dateTo)) || (dateFrom && dateTo && dateFrom > dateTo)) throw new ClecError('INVALID_ARGUMENT', 'Date filters require a valid ordered YYYY-MM-DD range.');
  const corpus = await openCurrent(directory, ref?.release);
  try {
    if (command === 'status') return { release: corpus.release, counts: corpus.counts(), managedBytes: await managedBytes(directory) };
    if (command === 'read' && ref) return corpus.read(ref.id);
    if (command === 'source' && ref) return corpus.source(ref.id, offset, limit);
    return corpus.search(value, { limit, match, ...(source === undefined ? {} : { source }), ...(dateFrom === undefined ? {} : { dateFrom }), ...(dateTo === undefined ? {} : { dateTo }) });
  } finally { corpus.close(); }
}
try { process.stdout.write(JSON.stringify({ ok: true, ...await main() }) + '\n'); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { code: error instanceof ClecError ? error.code : 'IO_ERROR', message: error instanceof Error ? error.message : 'Operation failed.' } }) + '\n'); process.exitCode = 1; }
