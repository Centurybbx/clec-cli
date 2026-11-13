/** Bounded real HTTP SSE collection. Each accepted frame is persisted immediately. */
export async function collectSse(url: URL, timeout: number, record: (frame: {id: string | undefined; event: string | undefined; envelope: any}) => void, limit = 10000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) throw Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const frames: any[] = []; let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      buffer += decoder.decode(value, {stream: !done});
      if (buffer.length > 8_000_000) throw Error('SSE frame exceeds collector limit');
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const raw = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const lines = raw.split(/\r?\n/), data = lines.filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const frame = {id: lines.find(x => x.startsWith('id:'))?.slice(3).trim(), event: lines.find(x => x.startsWith('event:'))?.slice(6).trim(), envelope: JSON.parse(data)};
        record(frame); frames.push(frame);
        if (frames.length > limit) throw Error('SSE event limit exceeded');
      }
      if (done) break;
    }
    if (buffer.trim()) throw Error('Incomplete SSE frame');
    return frames;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
