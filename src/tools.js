// Tool definitions exposed over MCP. Read-only by design except mkdir/upload:
// there is deliberately no delete / move / rename tool.
import { ApiError } from './api.js';

const folderArgs = {
  folderId: {
    type: 'string',
    description: "目录 id。根目录为 -11；与 path 二选一，path 优先。",
  },
  path: {
    type: 'string',
    description: "云端目录路径，如 \"AI报表产出/_接力盘点_2026-11-20\"（首尾斜杠任意）。",
  },
};

async function resolveFolder(client, { folderId, path }) {
  if (path && String(path).trim()) {
    const resolved = await client.resolvePath(path);
    return resolved.folderId;
  }
  return folderId != null && String(folderId).trim() ? String(folderId) : '-11';
}

export const tools = [
  {
    name: 'cloud189_list',
    description:
      '列出天翼云盘某个目录下的子目录与文件（包含 id、名称、大小、修改时间）。不传参数则列根目录。',
    inputSchema: {
      type: 'object',
      properties: {
        ...folderArgs,
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: '最多返回多少个条目' },
      },
      additionalProperties: false,
    },
    async handler(client, args) {
      const folderId = await resolveFolder(client, args);
      const listing = await client.listFolder(folderId);
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 200, 1000);
      const folders = listing.folders.slice(0, limit);
      const files = listing.files.slice(0, limit);
      const lines = [
        `目录 ${folderId}：${listing.folders.length} 个子目录、${listing.files.length} 个文件`,
        ...folders.map((f) => `[目录] ${f.name}\tid=${f.id}\t${f.fileCount != null ? f.fileCount + ' 项' : ''}`),
        ...files.map((f) => `[文件] ${f.name}\tid=${f.id}\t${f.size} B\t${f.modified || ''}`),
      ];
      return {
        text: lines.join('\n'),
        structured: { folderId, folders, files, truncated: listing.folders.length > limit || listing.files.length > limit },
      };
    },
  },
  {
    name: 'cloud189_search',
    description: '在天翼云盘内按文件名关键词搜索（在指定目录及其子孙中搜）。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '文件名关键词，支持部分匹配' },
        ...folderArgs,
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const folderId = await resolveFolder(client, args);
      const limit = Math.min(Number(args.limit) > 0 ? Number(args.limit) : 50, 500);
      const result = await client.search(args.keyword, { folderId, limit });
      const lines = [
        `关键词“${result.keyword}”：${result.files.length} 个文件、${result.folders.length} 个目录` +
          (result.total != null ? `（服务端计数 ${result.total}）` : ''),
        ...result.folders.map((f) => `[目录] ${f.name}\tid=${f.id}`),
        ...result.files.map((f) => `[文件] ${f.name}\tid=${f.id}\t${f.size} B`),
      ];
      return { text: lines.join('\n'), structured: result };
    },
  },
  {
    name: 'cloud189_download_link',
    description: '为单个文件获取临时下载直链（签名地址短时有效），不下载文件本身。',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string', description: '文件 id，从 cloud189_list / cloud189_search 获取' } },
      required: ['fileId'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const result = await client.downloadUrl(args.fileId);
      return {
        text: `下载直链（${result.host}）：\n${result.url}\n${result.note}`,
        structured: result,
      };
    },
  },
  {
    name: 'cloud189_upload',
    description: '上传本机文件到云端目录（三步签名上传，支持秒传）。同名文件会新建副本，不覆盖不删除。',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: '本机文件绝对路径' },
        parentId: { type: 'string', description: '目标目录 id，默认 -11（根目录）' },
        remoteName: { type: 'string', description: '云端文件名，默认用本地文件名' },
      },
      required: ['localPath'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const result = await client.upload(args.localPath, {
        parentId: args.parentId != null ? String(args.parentId) : '-11',
        remoteName: args.remoteName,
      });
      return {
        text:
          `${result.mode}完成：${result.name}（${result.size} B，md5 ${result.md5}）\n` +
          `远端 fileId=${result.fileId || '<未返回>'}，父目录 ${result.parentId}`,
        structured: result,
      };
    },
  },
  {
    name: 'cloud189_mkdir',
    description:
      '在云端创建目录（需要网页 cookie 通道；网页会话失效时返回明确的登录提示，而不是默默失败）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '新目录名' },
        parentId: { type: 'string', description: '父目录 id，默认 -11（根目录）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async handler(client, args) {
      const result = await client.mkdir(args.name, {
        parentId: args.parentId != null ? String(args.parentId) : '-11',
      });
      return {
        text: `目录已创建：${result.name}\tid=${result.folderId}\t父目录 ${result.parentId}`,
        structured: result,
      };
    },
  },
  {
    name: 'cloud189_delete',
    description:
      '删除云端文件或目录（默认移入回收站，可用 cloud189_recycle_restore 恢复）。fileType 默认 0（文件），目录传 1。',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: '要删除的文件/目录 id（从 cloud189_list / cloud189_search 获取）' },
        fileType: { type: 'string', enum: ['0', '1'], description: '0=文件（默认），1=目录' },
      },
      required: ['fileId'],
      additionalProperties: false,
    },
    async handler(client, args) {
      if (!args.fileId || !String(args.fileId).trim()) {
        throw new ApiError('fileId 不能为空', { code: 'InvalidArgument' });
      }
      const result = await client.deleteEntry(args.fileId, { fileType: args.fileType || '0' });
      return {
        text: `已移入回收站：fileId=${result.fileId}（fileType=${result.fileType}）\n${result.message}\n${result.note}`,
        structured: result,
      };
    },
  },
  {
    name: 'cloud189_recycle_list',
    description: '列出回收站里的文件与目录（分页），用于确认删除结果或找回。',
    inputSchema: {
      type: 'object',
      properties: {
        pageNum: { type: 'integer', minimum: 1, default: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 60 },
      },
      additionalProperties: false,
    },
    async handler(client, args) {
      const r = await client.listRecycleBin(args);
      const lines = [
        `回收站第 ${r.pageNum} 页（共 ${r.total} 项）：${r.folders.length} 个目录、${r.files.length} 个文件`,
        ...r.folders.map((f) => `[目录] ${f.name}\tid=${f.id}\t${f.deletedAt || ''}`),
        ...r.files.map((f) => `[文件] ${f.name}\tid=${f.id}\t${f.size} B\t${f.deletedAt || ''}`),
      ];
      return { text: lines.join('\n'), structured: r };
    },
  },
  {
    name: 'cloud189_recycle_restore',
    description: '从回收站恢复指定的文件/目录（需要回收站里的 fileId）。',
    inputSchema: {
      type: 'object',
      properties: { fileId: { type: 'string', description: '回收站条目的 id' } },
      required: ['fileId'],
      additionalProperties: false,
    },
    async handler(client, args) {
      if (!args.fileId || !String(args.fileId).trim()) {
        throw new ApiError('fileId 不能为空', { code: 'InvalidArgument' });
      }
      const r = await client.restoreFromRecycleBin(args.fileId);
      return { text: `已恢复 fileId=${r.fileId}：${r.message}`, structured: r };
    },
  },
  {
    name: 'cloud189_recycle_empty',
    description:
      '清空回收站（不可恢复）。必须显式传 confirm="EMPTY_RECYCLE_BIN"，否则拒绝执行。',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'string',
          enum: ['EMPTY_RECYCLE_BIN'],
          description: '安全闸门：必须为 EMPTY_RECYCLE_BIN 才真正清空',
        },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
    async handler(client, args) {
      // 安全闸门放在工具层：不依赖底层客户端，任何调用方都要过这道卡。
      if (args.confirm !== 'EMPTY_RECYCLE_BIN') {
        throw new ApiError('清空回收站不可恢复，必须传 confirm="EMPTY_RECYCLE_BIN"', {
          code: 'ConfirmationRequired',
        });
      }
      const r = await client.emptyRecycleBin({ confirm: args.confirm });
      return { text: `回收站已清空：${r.message}`, structured: r };
    },
  },
  {
    name: 'cloud189_quota',
    description: '查询云盘容量与已用空间（走 PC 签名通道，不依赖网页会话）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler(client) {
      const q = await client.quota();
      return {
        text: `总容量 ${q.capacityText}，已用 ${q.usedText}，剩余 ${q.availableText}`,
        structured: q,
      };
    },
  },
];

export function toolCatalog() {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(client, name, args) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new ApiError(`未知工具：${name}`, { code: 'UnknownTool' });
  }
  return tool.handler(client, args || {});
}
