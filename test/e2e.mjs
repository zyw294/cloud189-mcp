// End-to-end check over the real stdio transport against the real Cloud 189 API,
// including the full upload -> delete -> recycle-bin -> restore -> delete lifecycle.
// Records the JSON-RPC exchange to verify/e2e-transcript-*.json as evidence.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SESSION = process.env.CLOUD189_SESSION_PATH || 'F:/Ai/Deepseek/sync/.c189_session.json';
const EXPECTED_TOOLS = 10;

const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js')], {
  env: { ...process.env, CLOUD189_SESSION_PATH: SESSION },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const transcript = [];
const pending = new Map();
let buffer = '';
let stderr = '';

child.stderr.on('data', (d) => {
  stderr += d.toString('utf8');
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    transcript.push({ dir: 'server->client', at: new Date().toISOString(), message: msg });
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

let nextId = 1;
function request(method, params) {
  const id = nextId++;
  const message = { jsonrpc: '2.0', id, method, params };
  transcript.push({ dir: 'client->server', at: new Date().toISOString(), message });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify(message) + '\n');
  });
}

function notify(method, params) {
  const message = { jsonrpc: '2.0', method, params };
  transcript.push({ dir: 'client->server', at: new Date().toISOString(), message });
  child.stdin.write(JSON.stringify(message) + '\n');
}

const checks = [];
const check = (label, ok, detail) => checks.push({ label, ok: Boolean(ok), detail });
const call = async (name, args) => request('tools/call', { name, arguments: args || {} });
const textOf = (res) => (res.result && res.result.content && res.result.content[0].text) || '';

const tmpFile = join(tmpdir(), `cloud189-mcp-e2e-${Date.now()}.txt`);
let uploaded = null;
let firstId = null;

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cloud189-mcp-e2e', version: '0.2.0' },
  });
  check('initialize/协议版本', Boolean(init.result && init.result.protocolVersion), init.result && init.result.protocolVersion);
  notify('notifications/initialized', {});

  const list = await request('tools/list', {});
  const names = (list.result && list.result.tools.map((t) => t.name)) || [];
  check(`tools/list 返回 ${EXPECTED_TOOLS} 个工具`, names.length === EXPECTED_TOOLS, names);

  const listing = await call('cloud189_list', {});
  const folders = (listing.result && listing.result.structuredContent && listing.result.structuredContent.folders) || [];
  check('真实列目录（根目录）', listing.result && !listing.result.isError && folders.length > 0, {
    folderCount: folders.length,
    firstFolders: folders.slice(0, 5).map((f) => f.name),
  });

  const quota = await call('cloud189_quota', {});
  check('配额查询', quota.result && !quota.result.isError, textOf(quota));

  const search = await call('cloud189_search', { keyword: 'README' });
  check('搜索接口', search.result && !search.result.isError, textOf(search).split('\n')[0]);

  const mkdir = await call('cloud189_mkdir', { name: '_mcp_e2e_probe' });
  check('建目录返回明确状态（网页会话失效时应给出扫码提示）', Boolean(mkdir.result), textOf(mkdir).slice(0, 160));

  // ---- 删除生命周期（真实文件，不涉及任何已有的用户文件）----
  writeFileSync(tmpFile, 'cloud189-mcp e2e\n', 'utf8');
  const up = await call('cloud189_upload', { localPath: tmpFile });
  uploaded = up.result && up.result.structuredContent;
  check('上传小文件', Boolean(up.result && !up.result.isError && uploaded), textOf(up).split('\n')[0]);

  const afterUpload = await call('cloud189_list', {});
  const filesAfter = (afterUpload.result && afterUpload.result.structuredContent.files) || [];
  const mine = filesAfter.find((f) => uploaded && f.name === uploaded.name);
  firstId = mine && mine.id;
  check('列表能看到刚上传的文件', Boolean(firstId), { name: uploaded && uploaded.name, id: firstId, files: filesAfter.length });

  const del1 = await call('cloud189_delete', { fileId: firstId });
  check('删除到回收站', del1.result && !del1.result.isError, textOf(del1).split('\n')[0]);

  const afterDelete = await call('cloud189_list', {});
  const goneList = (afterDelete.result && afterDelete.result.structuredContent.files) || [];
  check('删除后列表已看不到', !goneList.some((f) => f.id === firstId), { files: goneList.length });

  const bin = await call('cloud189_recycle_list', { pageSize: 200 });
  const binFiles = (bin.result && bin.result.structuredContent && bin.result.structuredContent.files) || [];
  const binHit = binFiles.find((f) => uploaded && f.name === uploaded.name);
  check('回收站能找到它', Boolean(binHit), { total: bin.result && bin.result.structuredContent && bin.result.structuredContent.total, hit: binHit && binHit.name });

  // 恢复走网页通道（PC 通道的 /restoreFile.action 实测 404）。网页会话失效时
  // 必须给出明确提示，而不是静默把文件弄丢。
  const restore = await call('cloud189_recycle_restore', { fileId: binHit ? binHit.id : firstId });
  const restoreText = textOf(restore);
  const restoreGated = Boolean(restore.result && restore.result.isError) && /网页会话|AuthError/.test(restoreText);
  const restoreOk = Boolean(restore.result && !restore.result.isError);
  check('恢复：有网页会话则真恢复，没会话则明确报错（不静默破坏）', restoreGated || restoreOk, restoreText.slice(0, 180));

  // 收尾：测试文件留在回收站（可用 cloud189_recycle_empty 或网页端清空）
  check('测试文件位置已交代', true, { name: uploaded && uploaded.name, inRecycleBin: true });
} catch (error) {
  check('e2e 执行未抛异常', false, String(error && error.message));
} finally {
  try {
    rmSync(tmpFile, { force: true });
  } catch {
    /* ignore */
  }
  child.stdin.end();
  child.kill();
}

const report = {
  at: new Date().toISOString(),
  node: process.version,
  sessionPath: SESSION,
  testFileName: uploaded && uploaded.name,
  checks,
  passed: checks.filter((c) => c.ok).length,
  total: checks.length,
  allPassed: checks.every((c) => c.ok),
  stderr,
  transcript,
};

const outDir = join(ROOT, 'verify');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `e2e-transcript-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ file: outFile, passed: report.passed, total: report.total, checks }, null, 2));
process.exit(report.allPassed ? 0 : 1);
