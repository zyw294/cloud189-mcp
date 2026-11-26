// Tiny MCP stdio client: enough for initialize / tools.list / tools.call.
// No dependencies — newline-delimited JSON-RPC, same framing as the server.
import { spawn } from 'node:child_process';

export class McpClientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'McpClientError';
  }
}

export class StdioMcpClient {
  constructor({ command, args = [], env = process.env, cwd, logger = () => {}, requestTimeoutMs = 180000 }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.log = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.seq = 0;
    this.pending = new Map();
    this.buffer = '';
    this.child = null;
    this.closed = false;
    this.serverInfo = null;
  }

  start() {
    if (this.child) return this.child;
    this.child = spawn(this.command, this.args, {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Only .cmd/.bat npm shims need a shell; a direct node.exe path must not be
      // handed to cmd.exe, or Windows splits it at the first space.
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command),
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.log(`[server] ${line.trim()}`);
      }
    });
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        entry.reject(new McpClientError(`MCP server 已退出（code=${code}, signal=${signal}）`));
      }
      this.pending.clear();
    });
    this.child.on('error', (error) => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new McpClientError(`MCP server 启动失败：${error.message}`));
      this.pending.clear();
    });
    return this.child;
  }

  onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.log(`忽略无法解析的行：${line.slice(0, 120)}`);
        continue;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new McpClientError(`${message.error.message}（code ${message.error.code}）`));
        else entry.resolve(message.result);
      }
    }
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new McpClientError('MCP 连接已关闭'));
    this.start();
    const id = ++this.seq;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpClientError(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.start();
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async initialize(clientInfo = { name: 'cloud189-mcp', version: '0.2.0' }) {
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo,
    });
    this.serverInfo = result.serverInfo;
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name, args = {}) {
    return this.request('tools/call', { name, arguments: args });
  }

  close() {
    this.closed = true;
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* already gone */
      }
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}
