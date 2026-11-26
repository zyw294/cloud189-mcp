import { createHash, createHmac } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import {
  API,
  CLOUD,
  SUFFIX,
  UA,
  AuthError,
  cookieHeader,
  readSession,
  remintPcSession,
  writeSession,
} from './session.js';

export class ApiError extends Error {
  constructor(message, { code, status, detail } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEB_IP_HINT =
  '天翼云盘网页会话已失效（常见原因：SSO 过期或登录 IP 与当前 IP 不一致）。' +
  '该操作需要网页 cookie 通道，请先完成扫码登录复活（cloud189-sync 的「扫码登录→双通道复活」），' +
  '或用 c189_keepalive.py 免密重签后再试。';

// Cloud 189 uses 19-digit ids that exceed Number.MAX_SAFE_INTEGER. Plain
// JSON.parse silently rounds them (…677800 -> …677800 mismatch), which makes the
// server answer "invalid uploadFileId" / "file not found". Quote any integer with
// 16+ digits before parsing so ids stay exact as strings.
export function parseJsonSafe(text) {
  const quoted = String(text).replace(/([:\[,]\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"');
  return JSON.parse(quoted);
}

function isAuthFailure(text, status) {
  if (!text) return false;
  return (
    status === 401 ||
    /InvalidSessionKey/.test(text) ||
    /check ip error/.test(text) ||
    /\"res_code\"\s*:\s*\"?PermissionDenied/.test(text)
  );
}

export function httpDate() {
  return new Date().toUTCString();
}

export class Cloud189 {
  constructor({ sessionPath, logger = () => {} } = {}) {
    this.sessionPath = sessionPath;
    this.log = logger;
    this.cache = null;
  }

  load() {
    if (!this.cache) this.cache = readSession(this.sessionPath);
    return this.cache;
  }

  persist() {
    if (!this.cache) return;
    writeSession(this.sessionPath, this.cache);
  }

  sign(operate, url, date) {
    const uri = new URL(url).pathname;
    const plain = `SessionKey=${this.cache.pc_sessionKey}&Operate=${operate}` +
      `&RequestURI=${uri}&Date=${date}`;
    return createHmac('sha1', this.cache.pc_sessionSecret)
      .update(plain)
      .digest('hex')
      .toUpperCase();
  }

  async pcRequest(path, params = {}, { method = 'GET', body } = {}) {
    this.load();
    const base = `${API}${path}?${SUFFIX}`;
    const date = httpDate();
    const headers = {
      SessionKey: this.cache.pc_sessionKey || '',
      'Sign-Type': '1',
      'User-Agent': UA,
      Date: date,
      Signature: this.sign(method, base, date),
      Accept: 'application/json;charset=UTF-8',
    };
    let url = base;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (params && Object.keys(params).length) {
      url = `${base}&${new URLSearchParams(params).toString()}`;
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    if (isAuthFailure(text, res.status) && /InvalidSessionKey/.test(text)) {
      const error = new ApiError('InvalidSessionKey', { code: 'InvalidSessionKey', status: res.status });
      error.authExpired = true;
      throw error;
    }
    return { status: res.status, text };
  }

  async pcJson(path, params, options) {
    const { status, text } = await this.pcRequest(path, params, options);
    if (isAuthFailure(text, status)) {
      throw new ApiError('pc channel rejected', { code: 'AuthFailed', status, detail: text.slice(0, 300) });
    }
    let json;
    try {
      json = parseJsonSafe(text);
    } catch {
      throw new ApiError(`响应不是 JSON（HTTP ${status}）`, { status, detail: text.slice(0, 300) });
    }
    const code = json.res_code != null ? String(json.res_code) : '';
    if (code) {
      if (code !== '0') {
        throw new ApiError(json.res_message || json.res_code, { code, status, detail: text.slice(0, 300) });
      }
      return json;
    }
    // 没有 res_code 的响应可能是网关错误页（例如 PC 通道不存在的接口返回
    // {status:404,error:"Not Found",path:"/restoreFile.action"}）。这类绝不能当成功。
    if (status >= 400 || json.error || json.status) {
      throw new ApiError(`接口不可用（HTTP ${status}）`, {
        code: 'HttpError',
        status,
        detail: JSON.stringify(json).slice(0, 200),
      });
    }
    return json;
  }

  // PC request with one automatic re-mint when the session key expired.
  async withRemint(run) {
    this.load();
    try {
      return await run();
    } catch (error) {
      if (!error.authExpired) throw error;
      this.log('PC 密钥失效，尝试用网页 SSO 免密重签');
      this.cache = await remintPcSession(this.cache);
      this.persist();
      return await run();
    }
  }

  async webRequest(path, params = {}) {
    this.load();
    const query = new URLSearchParams(params).toString();
    const url = `${CLOUD}${path}${query ? `?${query}` : ''}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/json;charset=UTF-8',
        Referer: `${CLOUD}/web/main/file`,
        Cookie: cookieHeader(this.cache),
      },
    });
    const text = await res.text();
    if (isAuthFailure(text, res.status)) {
      throw new AuthError(`${WEB_IP_HINT}（HTTP ${res.status}）`);
    }
    let json;
    try {
      json = parseJsonSafe(text);
    } catch {
      throw new ApiError(`网页通道响应不是 JSON（HTTP ${res.status}）`, {
        status: res.status,
        detail: text.slice(0, 200),
      });
    }
    return json;
  }

  async listFolder(folderId = '-11') {
    return this.withRemint(async () => {
      const json = await this.pcJson('/listFiles.action', {
        folderId: String(folderId),
        fileType: '0',
        mediaType: '0',
      });
      const ao = json.fileListAO || {};
      return {
        folderId: String(folderId),
        total: ao.count != null ? Number(ao.count) : undefined,
        folders: (ao.folderList || []).map((f) => ({
          id: String(f.id),
          name: f.name,
          fileCount: f.fileCount,
          modified: f.lastOpTime || f.createDate,
        })),
        files: (ao.fileList || []).map((f) => ({
          id: String(f.id),
          name: f.name,
          size: Number(f.size || 0),
          modified: f.lastOpTime || f.createDate,
          md5: f.md5,
        })),
      };
    });
  }

  // Resolve "AI报表产出/_接力盘点" style paths (leading slash optional).
  async resolvePath(path) {
    const segments = String(path).split('/').map((s) => s.trim()).filter(Boolean);
    let folderId = '-11';
    const walked = [];
    for (const segment of segments) {
      const listing = await this.listFolder(folderId);
      const hit = listing.folders.find((f) => f.name === segment);
      if (!hit) {
        const names = listing.folders.slice(0, 12).map((f) => f.name).join(' / ');
        throw new ApiError(
          `路径段不存在：${segment}（父目录 ${walked.join('/') || '<root>'} 下可选：${names}）`,
          { code: 'PathNotFound' }
        );
      }
      folderId = hit.id;
      walked.push(segment);
      await sleep(40);
    }
    return { folderId, resolvedPath: '/' + walked.join('/') };
  }

  async search(keyword, { folderId = '-11', limit = 100 } = {}) {
    if (!keyword || !String(keyword).trim()) {
      throw new ApiError('keyword 不能为空', { code: 'InvalidArgument' });
    }
    return this.withRemint(async () => {
      const json = await this.pcJson('/searchFiles.action', {
        folderId: String(folderId),
        fileName: String(keyword),
        fileType: '0',
        mediaType: '0',
      });
      const files = (json.fileList || []).slice(0, limit).map((f) => ({
        id: String(f.id),
        name: f.name,
        size: Number(f.size || 0),
        parentId: f.parentId != null ? String(f.parentId) : undefined,
        modified: f.lastOpTime || f.createDate,
      }));
      const folders = (json.folderList || []).slice(0, limit).map((f) => ({
        id: String(f.id),
        name: f.name,
        parentId: f.parentId != null ? String(f.parentId) : undefined,
      }));
      return { keyword: String(keyword), total: json.count != null ? Number(json.count) : undefined, files, folders };
    });
  }

  async downloadUrl(fileId) {
    if (!fileId) throw new ApiError('fileId 不能为空', { code: 'InvalidArgument' });
    return this.withRemint(async () => {
      const json = await this.pcJson('/getFileDownloadUrl.action', { fileId: String(fileId), dt: '1' });
      let url = json.fileDownloadUrl || '';
      if (url.startsWith('//')) url = `https:${url}`;
      if (!url) throw new ApiError('未拿到下载地址', { code: 'NoDownloadUrl' });
      return { fileId: String(fileId), url, host: new URL(url).host, note: '签名地址短时有效，过期后重新调用本工具获取' };
    });
  }

  async quota() {
    return this.withRemint(async () => {
      const json = await this.pcJson('/getUserInfo.action', {});
      const capacity = Number(json.capacity || 0);
      const available = Number(json.available || 0);
      return {
        capacityBytes: capacity,
        availableBytes: available,
        usedBytes: Math.max(capacity - available, 0),
        capacityText: formatBytes(capacity),
        availableText: formatBytes(available),
        usedText: formatBytes(Math.max(capacity - available, 0)),
        raw: { hasFamily: json.hasFamily, extPicCapacity: json.extPicCapacity },
      };
    });
  }

  // Creating folders needs the web-cookie channel: the PC appKey has no write right.
  async mkdir(name, { parentId = '-11' } = {}) {
    const folderName = String(name || '').trim();
    if (!folderName) throw new ApiError('name 不能为空', { code: 'InvalidArgument' });
    if (/[\\/:*?"<>|]/.test(folderName)) {
      throw new ApiError('目录名含非法字符', { code: 'InvalidArgument' });
    }
    const json = await this.webRequest('/v2/createFolder.action', {
      parentId: String(parentId),
      fileName: folderName,
    });
    if (json.fileId == null) {
      throw new ApiError(json.res_message || '建目录失败', { code: json.res_code, detail: JSON.stringify(json).slice(0, 300) });
    }
    return { folderId: String(json.fileId), name: folderName, parentId: String(parentId) };
  }

  // ---- 删除（进回收站，可恢复） -------------------------------------
  // 实测：PC 签名通道对 /deleteFile.action 有写权限（2026-11-26，bogus id 返回
  // res_code 0），所以删除不需要网页 cookie；建目录仍需网页通道。
  async deleteEntry(fileId, { fileType = '0' } = {}) {
    const id = String(fileId || '').trim();
    if (!id) throw new ApiError('fileId 不能为空', { code: 'InvalidArgument' });
    return this.withRemint(async () => {
      const json = await this.pcJson('/deleteFile.action', {
        fileId: id,
        fileType: String(fileType),
      });
      return {
        fileId: id,
        fileType: String(fileType),
        message: json.res_message || '已移入回收站',
        note: '文件进入回收站，可用 cloud189_recycle_restore 恢复',
      };
    });
  }

  async listRecycleBin({ pageNum = 1, pageSize = 60 } = {}) {
    const size = Math.min(Math.max(Number(pageSize) || 60, 1), 200);
    const page = Math.max(Number(pageNum) || 1, 1);
    return this.withRemint(async () => {
      const json = await this.pcJson('/listRecycleBinFiles.action', {
        pageNum: String(page),
        pageSize: String(size),
      });
      const ao = json.fileListAO || json.recycleBinAO || {};
      const files = (ao.fileList || json.fileList || []).map((f) => ({
        id: String(f.id),
        name: f.name,
        size: Number(f.size || 0),
        deletedAt: f.lastOpTime || f.createDate || f.deleteTime,
        fileType: f.fileType != null ? String(f.fileType) : undefined,
      }));
      const folders = (ao.folderList || json.folderList || []).map((f) => ({
        id: String(f.id),
        name: f.name,
        deletedAt: f.lastOpTime || f.createDate || f.deleteTime,
      }));
      return {
        pageNum: page,
        pageSize: size,
        total: ao.count != null ? Number(ao.count) : files.length + folders.length,
        files,
        folders,
      };
    });
  }

  // 恢复只能走网页通道：PC 通道的 /restoreFile.action 实测 404（2026-11-26）。
  async restoreFromRecycleBin(fileId) {
    const id = String(fileId || '').trim();
    if (!id) throw new ApiError('fileId 不能为空', { code: 'InvalidArgument' });
    const json = await this.webRequest('/api/open/recycleFile/restoreFile.action', { fileId: id });
    const code = json.res_code != null ? String(json.res_code) : '';
    if (code && code !== '0') {
      throw new ApiError(json.res_message || code, { code, detail: JSON.stringify(json).slice(0, 200) });
    }
    return { fileId: id, message: json.res_message || '已恢复', channel: 'web' };
  }

  // 不可恢复。调用方必须先显式传递确认字符串。
  async emptyRecycleBin({ confirm } = {}) {
    if (confirm !== 'EMPTY_RECYCLE_BIN') {
      throw new ApiError(
        '清空回收站不可恢复，必须传 confirm="EMPTY_RECYCLE_BIN" 才执行',
        { code: 'ConfirmationRequired' }
      );
    }
    const json = await this.webRequest('/api/open/recycleFile/clearRecycleBin.action', {});
    const code = json.res_code != null ? String(json.res_code) : '';
    if (code && code !== '0') {
      throw new ApiError(json.res_message || code, { code, detail: JSON.stringify(json).slice(0, 200) });
    }
    return { message: json.res_message || '回收站已清空', channel: 'web' };
  }

  async upload(localPath, { parentId = '-11', remoteName } = {}) {
    const path = String(localPath || '');
    if (!path) throw new ApiError('localPath 不能为空', { code: 'InvalidArgument' });
    const stat = statSync(path);
    if (!stat.isFile()) throw new ApiError(`不是文件：${path}`, { code: 'InvalidArgument' });
    const name = remoteName ? String(remoteName) : basename(path);
    const size = stat.size;
    const md5 = await fileMd5(path);
    return this.withRemint(async () => {
      const form = new URLSearchParams({
        parentFolderId: String(parentId),
        baseFileId: '',
        fileName: name,
        size: String(size),
        md5,
        lastWrite: '',
        localPath: path,
        opertype: '1',
        flag: '1',
        resumePolicy: '1',
        isLog: '0',
      });
      const task = await this.pcJson('/createUploadFile.action', {}, { method: 'POST', body: form });
      if (!task.uploadFileId) {
        throw new ApiError('创建上传任务失败', { code: 'UploadTaskFailed', detail: JSON.stringify(task).slice(0, 300) });
      }
      if (Number(task.fileDataExists) === 1) {
        const fileId = await this.commitUpload(task.fileCommitUrl, task.uploadFileId);
        return { fileId, name, size, md5, mode: '秒传', parentId: String(parentId) };
      }
      await this.putUpload(task.fileUploadUrl, task.uploadFileId, path, size);
      const fileId = await this.commitUpload(task.fileCommitUrl, task.uploadFileId);
      return { fileId, name, size, md5, mode: '上传', parentId: String(parentId) };
    });
  }

  async putUpload(uploadUrl, uploadFileId, path, size) {
    const url = `${uploadUrl}?${SUFFIX}`;
    const date = httpDate();
    const headers = {
      SessionKey: this.cache.pc_sessionKey,
      'Edrive-UploadFileId': String(uploadFileId),
      'User-Agent': UA,
      Date: date,
      Signature: this.sign('PUT', url, date),
      Accept: 'application/json;charset=UTF-8',
      'Content-Type': 'application/octet-stream',
      // 不能手写 Content-Length：与流式 body 一起发会被网关判为长度不符。
      // 与已验证的 Python 参考实现一致，让运行时用 chunked。
      'Edrive-UploadFileRange': `0-${size}`,
      ResumePolicy: '1',
    };
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers,
        body: createReadStream(path),
        duplex: 'half',
      });
      const text = (await res.text()).trim();
      if (text && /error/i.test(text) && !/UploadFileCompeletedError/.test(text)) {
        throw new ApiError(`上传数据出错（HTTP ${res.status}）：${text.slice(0, 600)}`, {
          code: 'UploadDataFailed',
          status: res.status,
          detail: text.slice(0, 600),
        });
      }
    } finally {
      await sleep(100);
    }
  }

  async commitUpload(commitUrl, uploadFileId) {
    const url = `${commitUrl}?${SUFFIX}`;
    const date = httpDate();
    const form = new URLSearchParams({
      uploadFileId: String(uploadFileId),
      opertype: '1',
      isLog: '0',
      ResumePolicy: '1',
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        SessionKey: this.cache.pc_sessionKey,
        'User-Agent': UA,
        Date: date,
        Signature: this.sign('POST', url, date),
        Accept: 'application/json;charset=UTF-8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const text = (await res.text()).trim();
    if (/<error>/i.test(text) || /^error/i.test(text)) {
      throw new ApiError(`提交上传失败：${text.slice(0, 200)}`, { code: 'UploadCommitFailed', status: res.status });
    }
    const m = text.match(/<id>(-?\d+)<\/id>/);
    if (m) return m[1];
    try {
      const j = JSON.parse(text);
      if (j.fileId != null) return String(j.fileId);
    } catch {
      /* XML or empty body */
    }
    return '';
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function fileMd5(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}
