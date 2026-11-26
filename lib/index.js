// DSH (DeepSeek Harness) plugin entry, shipped inside the same npm package as the
// stdio server. DSH reads dsh.bundle.patch from package.json -> cordis.patch.yml,
// imports this file, and we register every MCP tool through ctx.tools.register
// (same plugin shape as dsh-email: name / inject / apply).
//
// Because the server lives in the same package, the default command is this
// Node binary running ../src/index.js — no PATH or global install required.
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioMcpClient } from './mcp-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF_ENTRY = join(HERE, '..', 'src', 'index.js');

export const name = 'cloud189-mcp';
export const inject = ['tools'];

const LOG_FILE = join(tmpdir(), 'cloud189-mcp-plugin.log');

function log(message) {
  const line = `[cloud189-mcp] ${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    /* 日志写不进去不影响主流程 */
  }
}

function isNodeExecutable(candidate) {
  return /(^|[\\/])node(\.exe)?$/i.test(String(candidate || ''));
}

function resolveLaunch(config) {
  if (config.command) {
    return { command: String(config.command), args: Array.isArray(config.args) ? config.args : [] };
  }
  if (process.env.CLOUD189_MCP_COMMAND) {
    return {
      command: process.env.CLOUD189_MCP_COMMAND,
      args: Array.isArray(config.args) ? config.args : [],
    };
  }
  // 在 DSH 里 process.execPath 是 Electron 本体（DeepSeek Harness.exe），拿去跑脚本只会
  // 再开一个应用实例，stdio 握手永远不回来。只有真的是 node 才用 execPath。
  const explicitNode = process.env.CLOUD189_MCP_NODE || process.env.npm_node_execpath;
  const candidates = [
    explicitNode,
    isNodeExecutable(process.execPath) ? process.execPath : null,
    'C:\\Program Files\\nodejs\\node.exe',
    'node',
  ].filter(Boolean);
  const command = candidates[0];
  return { command, args: [SELF_ENTRY, ...(Array.isArray(config.args) ? config.args : [])] };
}

export function apply(ctx, config = {}) {
  const sessionPath = config.sessionPath ? String(config.sessionPath) : undefined;
  const launch = resolveLaunch(config);
  const args = sessionPath ? [...launch.args, '--session', sessionPath] : launch.args;
  const env = { ...process.env };
  if (sessionPath) env.CLOUD189_SESSION_PATH = sessionPath;

  const client = new StdioMcpClient({ command: launch.command, args, env, logger: log });
  const disposers = [];
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const off of disposers) {
      try {
        off();
      } catch {
        /* ignore */
      }
    }
    client.close();
  };

  ctx.effect?.(() => cleanup);
  ctx.on?.('dispose', cleanup);

  (async () => {
    const init = await client.initialize({ name: 'dsh-cloud189-mcp', version: '0.2.0' });
    log(`已连接 ${(init.serverInfo && init.serverInfo.name) || 'cloud189-mcp'}（协议 ${init.protocolVersion}）`);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const definition = {
        name: tool.name,
        description: tool.description || tool.name,
        parameters: tool.inputSchema || { type: 'object', properties: {}, additionalProperties: false },
        timeoutMs: 180000,
        output: {
          // DSH 会拿 output.schema 做校验，缺了它会在注册阶段报
          // "unsupported JSON schema: schema must be a schema object"。
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            additionalProperties: true,
          },
          render: (_args, value) => [
            { type: 'text', text: value && typeof value === 'object' && value.text ? value.text : String(value ?? '') },
          ],
        },
        async execute(rawArgs) {
          const result = await client.callTool(tool.name, rawArgs || {});
          const text = (result.content || [])
            .map((part) => (part && part.text) || '')
            .filter(Boolean)
            .join('\n');
          if (result.isError) throw new Error(text || `${tool.name} 调用失败`);
          return { text, structured: result.structuredContent };
        },
      };
      const off = ctx.tools.register(definition);
      if (typeof off === 'function') disposers.push(off);
    }
    log(`已注册 ${tools.length} 个天翼云盘工具`);
  })().catch((error) => {
    log(`初始化失败：${error && error.message}`);
  });
}
