import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClecError } from './domain/errors.js';
export interface AppConfig {
  workspace: string; stateRoot: string; qmdUrl: string; model: string; baseUrl: string; deadlineMs: number;
  piSessionDirectory: string; sessionDatabase: string; port: number; modelAdmissionUnits: number; diagnosticPath: string;
}
function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ClecError('INVALID_CONFIG', `${name} must be ${min}–${max}.`);
  return value;
}
export function config(): AppConfig {
  const workspace = resolve(process.env.CLEC_WORKSPACE ?? fileURLToPath(new URL('../..', import.meta.url)));
  const stateRoot = resolve(process.env.CLEC_STATE_DIR ?? fileURLToPath(new URL('../.data', import.meta.url)));
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ClecError('INVALID_CONFIG', 'Invalid DeepSeek API URL.'); }
  if (url.origin !== 'https://api.deepseek.com' || !['/', '/v1', '/v1/'].includes(url.pathname) || url.search || url.hash || url.username || url.password) {
    throw new ClecError('INVALID_CONFIG', 'DeepSeek must use the official https://api.deepseek.com API.');
  }
  const qmdUrl = process.env.CLEC_QMD_URL ?? 'http://localhost:8181';
  let qmd: URL;
  try { qmd = new URL(qmdUrl); } catch { throw new ClecError('INVALID_CONFIG', 'Invalid QMD URL.'); }
  if (qmd.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(qmd.hostname) || qmd.username || qmd.password || qmd.search || qmd.hash) {
    throw new ClecError('INVALID_CONFIG', 'QMD must use local HTTP without credentials.');
  }
  return { workspace, stateRoot, qmdUrl, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', baseUrl,
    deadlineMs: integer('CLEC_DEADLINE_MS', 600_000, 1000, 600_000),
    port: integer('CLEC_PORT', 3000, 1024, 65535),
    modelAdmissionUnits: integer('CLEC_MODEL_ADMISSION_UNITS', 240_000, 4096, 2_000_000),
    piSessionDirectory: resolve(process.env.CLEC_PI_DIR ?? resolve(stateRoot, 'pi')),
    diagnosticPath: resolve(process.env.CLEC_DIAGNOSTIC_PATH ?? resolve(stateRoot, 'diagnostics.jsonl')),
    sessionDatabase: resolve(stateRoot, 'sessions.sqlite') };
}
