const MAX_RESPONSE_BYTES = 262_144;
const MAX_SSE_FRAMES = 128;
const PROTOCOL_VERSION = '2025-11-25';
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A bounded, request-only MCP 2025-11-25 Streamable HTTP client.
 * No subscriptions, server requests, reconnects, or automatic RPC retries.
 */
export class McpMetadataTransport {
  private sessionId: string | undefined;
  private initialized = false;
  private nextId = 1;

  constructor(private readonly endpoint: URL, private readonly signal: AbortSignal) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(this.initialized ? { 'MCP-Protocol-Version': PROTOCOL_VERSION } : {}),
      ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}) };
  }

  private post(message: object): Promise<Response> {
    return fetch(this.endpoint, { method: 'POST', redirect: 'error', signal: this.signal,
      headers: this.headers(), body: JSON.stringify(message) });
  }

  async initialize(): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method: 'initialize', params: {
      protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'clec-generation', version: '1' },
    } });
    const sessionId = response.headers.get('mcp-session-id');
    // Retain an assigned session for cleanup even if the initialization body fails.
    if (sessionId !== null && /^[\x21-\x7e]{1,1024}$/.test(sessionId)) this.sessionId = sessionId;
    const result = await readRpcResponse(response, id);
    if ((sessionId !== null && this.sessionId === undefined) || result.protocolVersion !== PROTOCOL_VERSION ||
      !object(result.capabilities) || !object(result.serverInfo) ||
      typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') throw new Error('Incompatible MCP initialization');
    this.initialized = true;
    const notification = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    try {
      if (notification.status !== 202) throw new Error('MCP initialization notification rejected');
    } finally { await notification.body?.cancel(); }
    return result;
  }

  async request(method: string, params: object): Promise<Record<string, unknown>> {
    if (!this.initialized) throw new Error('MCP is not initialized');
    const id = this.nextId++;
    return readRpcResponse(await this.post({ jsonrpc: '2.0', id, method, params }), id);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    // Best effort within the SAME caller/deadline budget; never mask metadata errors.
    try {
      const response = await fetch(this.endpoint, { method: 'DELETE', redirect: 'error', signal: this.signal,
        headers: this.headers() });
      await response.body?.cancel();
    } catch { /* An expired/unavailable session must not extend the probe deadline. */ }
    this.sessionId = undefined;
  }
}

/** Validate envelopes before correlating responses. Notifications carry no evidence. */
function rpcResult(value: unknown, id: number): Record<string, unknown> | undefined {
  if (!object(value) || value.jsonrpc !== '2.0') throw new Error('Invalid MCP JSON-RPC envelope');
  if ('method' in value) {
    if ('id' in value || typeof value.method !== 'string' || !value.method.startsWith('notifications/') ||
      'result' in value || 'error' in value || ('params' in value && !object(value.params))) {
      throw new Error('Unsupported MCP server message');
    }
    return undefined;
  }
  if ((typeof value.id !== 'string' && (typeof value.id !== 'number' || !Number.isSafeInteger(value.id))) ||
    ('result' in value) === ('error' in value)) throw new Error('Invalid MCP response');
  if ('error' in value) {
    if (!object(value.error) || !Number.isInteger(value.error.code) || typeof value.error.message !== 'string') throw new Error('Invalid MCP error');
    if (value.id === id) throw new Error('MCP RPC failed');
  } else if (!object(value.result)) throw new Error('Invalid MCP result');
  return value.id === id ? value.result as Record<string, unknown> : undefined;
}

/** Incremental SSE line parsing, including CR/LF split across network chunks.
 * The byte budget below bounds every line/frame as well as the entire response.
 */
class RpcEventStream {
  private line = '';
  private afterCr = false;
  private event = '';
  private data: string[] = [];
  private frames = 0;

  constructor(private readonly id: number) {}

  push(text: string): Record<string, unknown> | undefined {
    for (const char of text) {
      if (this.afterCr && char === '\n') { this.afterCr = false; continue; }
      this.afterCr = char === '\r';
      if (char !== '\r' && char !== '\n') { this.line += char; continue; }
      const line = this.line;
      this.line = '';
      if (line === '') {
        if (++this.frames > MAX_SSE_FRAMES) throw new Error('Too many MCP SSE frames');
        const data = this.data.join('\n');
        const event = this.event;
        this.data = []; this.event = '';
        // Empty priming events, comments, id and retry fields carry no RPC.
        if (data === '') continue;
        if (event !== '' && event !== 'message') throw new Error('Unsupported MCP SSE event');
        const result = rpcResult(JSON.parse(data) as unknown, this.id);
        if (result !== undefined) return result;
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') this.data.push(value);
        else if (field === 'event') this.event = value;
      }
    }
    return undefined;
  }
}

async function readRpcResponse(response: Response, id: number): Promise<Record<string, unknown>> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!response.ok || !response.body || (contentType !== 'application/json' && contentType !== 'text/event-stream')) {
    await response.body?.cancel();
    throw new Error('Unavailable MCP response');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events = contentType === 'text/event-stream' ? new RpcEventStream(id) : undefined;
  let length = 0;
  let json = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        length += value.byteLength;
        if (length > MAX_RESPONSE_BYTES) throw new Error('MCP metadata too large');
      }
      const text = decoder.decode(value, { stream: !done });
      if (events) {
        const result = events.push(text);
        if (result !== undefined) return result;
      } else json += text;
      if (done) break;
    }
    // SSE dispatch requires a blank line. A truncated final frame is not a response.
    const result = events ? undefined : rpcResult(JSON.parse(json) as unknown, id);
    if (result === undefined) throw new Error('Missing matching MCP response');
    return result;
  } finally {
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
