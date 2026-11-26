import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '../src/protocol.js';

const fixtureClient = {
  async listFolder(folderId) {
    return {
      folderId: String(folderId),
      folders: [{ id: '111', name: 'AI报表产出', fileCount: 2 }],
      files: [{ id: '222', name: 'a.txt', size: 12, modified: '2026-11-26 10:00:00' }],
    };
  },
  async resolvePath() {
    return { folderId: '111', resolvedPath: '/AI报表产出' };
  },
};

const server = new McpServer({ client: fixtureClient, version: '0.1.0' });

async function rpc(method, params, id = 1) {
  return server.dispatch({ jsonrpc: '2.0', id, method, params });
}

test('initialize negotiates a supported protocol and advertises tools', async () => {
  const res = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.equal(res.result.serverInfo.name, 'cloud189-mcp');
  assert.ok(res.result.capabilities.tools);
});

test('unknown protocol version falls back to the newest supported one', async () => {
  const res = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(res.result.protocolVersion, '2025-06-18');
});

test('tools/list exposes the ten documented tools, including the recycle-bin set', async () => {
  const res = await rpc('tools/list', {});
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'cloud189_delete',
    'cloud189_download_link',
    'cloud189_list',
    'cloud189_mkdir',
    'cloud189_quota',
    'cloud189_recycle_empty',
    'cloud189_recycle_list',
    'cloud189_recycle_restore',
    'cloud189_search',
    'cloud189_upload',
  ]);
  for (const tool of res.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
  }
  options_check: {
    const empty = res.result.tools.find((t) => t.name === 'cloud189_recycle_empty');
    assert.deepEqual(empty.inputSchema.properties.confirm.enum, ['EMPTY_RECYCLE_BIN']);
    assert.deepEqual(empty.inputSchema.required, ['confirm']);
  }
});

test('tools/call cloud189_list returns human text plus structured content', async () => {
  const res = await rpc('tools/call', { name: 'cloud189_list', arguments: {} });
  assert.equal(res.result.isError, false);
  assert.match(res.result.content[0].text, /1 个子目录、1 个文件/);
  assert.equal(res.result.structuredContent.folders[0].name, 'AI报表产出');
});

test('unknown tool is reported as a tool-level error, not a crash', async () => {
  const res = await rpc('tools/call', { name: 'cloud189_purge_everything', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /未知工具/);
});

test('recycle_empty without the confirm gate is refused', async () => {
  const res = await rpc('tools/call', { name: 'cloud189_recycle_empty', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /EMPTY_RECYCLE_BIN/);
});

test('delete without fileId is rejected', async () => {
  const res = await rpc('tools/call', { name: 'cloud189_delete', arguments: {} });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /fileId/);
});

test('unknown method returns JSON-RPC -32601', async () => {
  const res = await rpc('resources/list', {});
  assert.equal(res.error.code, -32601);
});

test('notifications produce no response', async () => {
  const res = await server.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res, null);
});
