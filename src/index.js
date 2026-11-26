#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cloud189 } from './api.js';
import { McpServer } from './protocol.js';
import { defaultSessionPath } from './session.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'));

function parseArgs(argv) {
  const out = { sessionPath: undefined, help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--version' || arg === '-v') out.version = true;
    else if (arg === '--session') {
      out.sessionPath = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--session=')) {
      out.sessionPath = arg.slice('--session='.length);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(
    [
      'cloud189-mcp — 天翼云盘 MCP stdio server',
      '',
      '用法: cloud189-mcp [--session <session.json>]',
      '',
      '会话文件默认取 $CLOUD189_SESSION_PATH，否则 ~/.cloud189/session.json。',
      '可指向 cloud189-sync 现有的 .c189_session.json 以直接复用扫码登录态。',
      '',
      '工具: cloud189_list / cloud189_search / cloud189_download_link /',
      '      cloud189_upload / cloud189_mkdir / cloud189_quota',
    ].join('\n') + '\n'
  );
  process.exit(0);
}
if (args.version) {
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
  process.exit(0);
}

const sessionPath = args.sessionPath || defaultSessionPath();
const log = (msg) => process.stderr.write(`[cloud189-mcp] ${msg}\n`);
const client = new Cloud189({ sessionPath, logger: log });
const server = new McpServer({ client, version: pkg.version, logger: log });

log(`启动，会话文件 ${sessionPath}`);
server.listen().then(() => log('stdin 已关闭，退出'));
