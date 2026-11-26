// Minimal, dependency-free MCP server core (stdio transport).
// Implements initialize / tools.list / tools.call with newline-delimited JSON-RPC 2.0,
// which is the framing MCP uses for stdio servers (2024-11-05 .. 2025-06-18).
import { createInterface } from 'node:readline';
import { callTool, toolCatalog } from './tools.js';

export const SERVER_NAME = 'cloud189-mcp';
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const INSTRUCTIONS =
  '天翼云盘（cloud.189.cn）工具：列目录、搜文件、取下载直链、上传、建目录、查容量。' +
  '支持删除（进回收站）、回收站列表/恢复/清空（清空需 confirm 闸门）；不提供移动/重命名。网页会话失效时，cloud189_mkdir 会返回需要扫码登录的提示。';

export class McpServer {
  constructor({ client, version = '0.0.0', logger = () => {} } = {}) {
    this.client = client;
    this.version = version;
    this.log = logger;
    this.initialized = false;
  }

  async dispatch(message) {
    const { id, method, params } = message || {};
    const isNotification = id === undefined || id === null;
    try {
      const result = await this.route(method, params || {});
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (isNotification) {
        this.log(`notification ${method} 失败：${error.message}`);
        return null;
      }
      const code = error instanceof ProtocolError ? error.code : -32603;
      const payload = {
        jsonrpc: '2.0',
        id,
        error: { code, message: error.message || 'internal error' },
      };
      if (error.data !== undefined) payload.error.data = error.data;
      return payload;
    }
  }

  async route(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
          ? requested
          : SUPPORTED_PROTOCOLS[0];
        this.initialized = true;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: this.version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'notifications/initialized':
      case 'initialized':
        return {};
      case 'ping':
        return {};
      case 'logging/setLevel':
        return {};
      case 'tools/list':
        return { tools: toolCatalog() };
      case 'tools/call': {
        const name = params.name;
        if (!name) throw new ProtocolError(-32602, 'tools/call 缺少 name');
        const args = params.arguments || {};
        if (typeof args !== 'object' || Array.isArray(args)) {
          throw new ProtocolError(-32602, 'tools/call 的 arguments 必须是对象');
        }
        try {
          const out = await callTool(this.client, name, args);
          const content = [{ type: 'text', text: out.text }];
          const result = { content, isError: false };
          if (out.structured !== undefined) result.structuredContent = out.structured;
          return result;
        } catch (error) {
          return {
            content: [{ type: 'text', text: `${error.name || 'Error'}: ${error.message}` }],
            isError: true,
          };
        }
      }
      default:
        throw new ProtocolError(-32601, `未知方法：${method}`);
    }
  }

  // Serve newline-delimited JSON-RPC over stdio until stdin closes.
  listen({ input = process.stdin, output = process.stdout } = {}) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      chain = chain.then(async () => {
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch (error) {
          output.write(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } }) + '\n'
          );
          return;
        }
        const response = await this.dispatch(message);
        if (response) output.write(JSON.stringify(response) + '\n');
      });
    });
    return new Promise((resolve) => rl.on('close', () => chain.then(resolve)));
  }
}
