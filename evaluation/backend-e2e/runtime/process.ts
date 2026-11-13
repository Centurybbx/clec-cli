/** Owned subprocesses only. Logs are bounded on disk; no child inherits the provider key. */
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export function childEnv(extra: Record<string,string> = {}) {
  const env = { ...process.env, ...extra };
  delete env.DEEPSEEK_API_KEY;
  return env;
}
export class OwnedProcess {
  child: ChildProcess;
  done: Promise<{code:number|null,signal:NodeJS.Signals|null}>;
  private exited = false;
  private overflow = false;
  constructor(argv: string[], env: NodeJS.ProcessEnv, log: string, secret = '', limit = 8_000_000) {
    const fd = openSync(log, 'wx', 0o600);
    try { this.child = spawn(process.execPath, argv, {env, detached:true, stdio:['ignore','pipe','pipe']}); }
    catch (e) { closeSync(fd); throw e; }
    let bytes = 0;
    // Keep a suffix across chunks so credentials split between chunks are redacted.
    const pipe = (stream: NodeJS.ReadableStream) => {
      const decoder = new StringDecoder('utf8'); let pending = '';
      const flush = (final = false) => {
        const keep = final ? 0 : Math.max(0, secret.length - 1);
        const n = Math.max(0, pending.length - keep);
        // Do not split a secret crossing the flush boundary.
        let cut = n;
        if (secret) { const at = pending.lastIndexOf(secret, n); if (at >= 0 && at + secret.length > n) cut = at; }
        const part = pending.slice(0, cut); pending = pending.slice(cut);
        const text = secret ? part.split(secret).join('[REDACTED]') : part;
        const b = Buffer.from(text); const remaining = Math.max(0, limit - bytes);
        if (remaining) { const piece = b.subarray(0, remaining); writeSync(fd, piece); bytes += piece.length; }
        if (b.length > remaining && !this.overflow) { this.overflow = true; void this.stop(); }
      };
      stream.on('data', (chunk: Buffer) => { pending += decoder.write(chunk); flush(); });
      stream.on('end', () => { pending += decoder.end(); flush(true); });
    };
    pipe(this.child.stdout!); pipe(this.child.stderr!);
    this.done = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => { this.exited = true; closeSync(fd); resolve({code,signal}); });
    });
  }
  async stop(graceMs = 3000) {
    if (this.exited || !this.child.pid) return;
    const signal = (sig: NodeJS.Signals) => { try { process.kill(-this.child.pid!, sig); } catch (e: any) { if (e.code !== 'ESRCH') throw e; } };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), graceMs);
    try { await this.done; } finally { clearTimeout(timer); }
  }
  async wait(ms: number) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([this.done, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Command timed out')), ms); })]);
      if (this.overflow) throw Error('Command log limit exceeded');
      return result;
    } finally { if (timer) clearTimeout(timer); if (!this.exited) await this.stop(); }
  }
}
