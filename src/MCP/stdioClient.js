// StdioMcpClient: lightweight JSON-RPC 2.0 client for external MCP servers launched via spawn.
// It writes JSON-RPC requests newline-delimited to child's stdin and parses line-delimited JSON from stdout.
// Each outbound request includes an incrementing id; responses matched and resolved.
// Includes initialize() convenience which sends the standard MCP initialize request.
// Provides listTools() and callTool(name, args) wrappers.
// NOTE: The official SDK prefers transports; here we directly operate on stdio for minimal integration.

import { once } from 'node:events';

export class StdioMcpClient {
  constructor(childProc, { timeoutMs = 8000 } = {}) {
    this.proc = childProc;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.timeoutMs = timeoutMs;
    this.initialized = false;
    this.capabilities = null;
    this.toolsCache = null;
    this._stdoutBuf = '';

    if (!childProc || !childProc.stdout || !childProc.stdin) {
      throw new Error('Invalid child process passed to StdioMcpClient');
    }

    childProc.stdout.setEncoding('utf8');
    childProc.stdout.on('data', chunk => {
      this._stdoutBuf += chunk;
      const lines = this._stdoutBuf.split(/\r?\n/);
      this._stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        if (obj.jsonrpc !== '2.0' || (obj.id == null && !obj.method)) continue;
        if (obj.id != null && this.pending.has(obj.id)) {
          const entry = this.pending.get(obj.id);
          this.pending.delete(obj.id);
          clearTimeout(entry.timer);
          if (obj.error) entry.reject(new Error(obj.error.message || JSON.stringify(obj.error)));
          else entry.resolve(obj.result);
        } else if (obj.method) {
          // Notification or request from server (not handled). Could emit event.
        }
      }
    });

    childProc.stderr?.setEncoding('utf8');
    childProc.stderr?.on('data', chunk => {
      // Could optionally log or buffer for diagnostics
    });

    childProc.on('exit', code => {
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Process exited (code ${code}) before response`));
      }
      this.pending.clear();
    });
  }

  _send(method, params = {}) {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const json = JSON.stringify(payload);
    this.proc.stdin.write(json + '\n');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method}`));
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  async initialize() {
    if (this.initialized) return this.capabilities;
    // Standard MCP initialize per spec; adapt if server expects different shape
    const result = await this._send('initialize', {
      clientInfo: { name: 'local-host', version: '0.1.0' },
      protocols: ['mcp'],
      capabilities: { resources: {}, tools: {} }
    });
    this.initialized = true;
    this.capabilities = result?.capabilities || null;
    return this.capabilities;
  }

  async listTools({ forceRefresh = false } = {}) {
    if (!this.initialized) await this.initialize();
    if (this.toolsCache && !forceRefresh) return this.toolsCache;
    const result = await this._send('tools/list', {});
    // Expected result: { tools: [ { name, description, inputSchema? } ] }
    this.toolsCache = Array.isArray(result?.tools) ? result.tools : [];
    return this.toolsCache;
  }

  async callTool(name, args = {}) {
    if (!this.initialized) await this.initialize();
    if (typeof name !== 'string' || !name) throw new Error('Tool name required');
    const result = await this._send('tools/call', { name, arguments: args });
    return result; // Format: { content: [ { type, text? } ], isError? }
  }
}

export async function waitForReady(client, { toolName = 'read_file', maxWaitMs = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const tools = await client.listTools({ forceRefresh: true });
      if (tools.some(t => t.name === toolName)) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}
