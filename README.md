# cloud189-mcp — 天翼云盘 MCP 服务器 + DSH 插件

一个包两用：既是本地 stdio MCP 服务器（Claude Desktop / Cursor / 任意 MCP 宿主），也是 DSH（DeepSeek Harness）插件（带 `dsh.bundle`）。零运行时依赖，Node ≥ 18.17。

能力：列目录、搜索、取下载直链、上传、建目录、**删除（进回收站）**、回收站列表/恢复/清空、查配额。

> 与 `cloud189-sync` 共用同一个会话文件（`.c189_session.json`），**不重做扫码登录**：复用已有登录态；PC 密钥失效时用 `typed_cookies` 免密重签（和 `c189_keepalive.py` 一套逻辑），不需要密码。

## 双通道（实测结论）

| 通道 | appKey | 载体 | 实测能用 |
|---|---|---|---|
| PC 签名 | `8025431004` | `sessionKey` + HMAC-SHA1 | 列目录、搜索、下载直链、上传三步、**删除**、回收站列表/恢复、配额 |
| 网页 cookie | `cloud` | `.cloud.189.cn` / `.e.189.cn` cookie | 建目录（PC appKey 建目录返回 `PermissionDenied`） |

签名原文：`SessionKey=<key>&Operate=<GET|POST|PUT>&RequestURI=<pathname>&Date=<UTC>`，HMAC-SHA1 后转大写十六进制；`RequestURI` 只取路径。

两个必须知道的坑（已入代码）：

1. **PC 通道可以删除、不能建目录**（`createFolder.action` → `checkWriteRight() ... has no right`）。
2. **云盘 id 是 19 位整数，超过 JS 安全整数**：直接 `JSON.parse` 会静默改掉末几位，上传会报 `invalid uploadFileId`、删除会找不到文件。本包在解析前把 16 位以上的整数先转成字符串（`parseJsonSafe`）。

## 安装与配置

```bash
npx -y cloud189-mcp --session F:/Ai/Deepseek/sync/.c189_session.json   # 发布后
node src/index.js --session F:/Ai/Deepseek/sync/.c189_session.json      # 本地源码
```

MCP 宿主配置：

```json
{
  "mcpServers": {
    "cloud189": {
      "command": "npx",
      "args": ["-y", "cloud189-mcp"],
      "env": { "CLOUD189_SESSION_PATH": "F:/Ai/Deepseek/sync/.c189_session.json" }
    }
  }
}
```

会话文件查找顺序：`--session` > `CLOUD189_SESSION_PATH` > `~/.cloud189/session.json`。

### DSH（DeepSeek Harness）

同一个包里已带 `dsh.bundle.patch` → `cordis.patch.yml`，DSH 读它后加载 `lib/index.js`，把 10 个工具通过 `ctx.tools.register` 注册成原生工具（与 `dsh-email` 同一套插件形状：`name` / `inject=['tools']` / `apply`）。默认用当前 Node 跑包内的 `src/index.js`，不需要 PATH、不需要另装。

```bash
# 先备份 profile 四件套，装完重启并核会话数
dsh plugin --profile desktop add cloud189-mcp@0.2.0            # npm 发布后
dsh plugin --profile desktop add file:F:/Ai/Deepseek/_cloud189-mcp   # 本地目录
```

覆盖配置（profile 的 `cordis.patch.yml`）：

```yaml
- id: cloud189-mcp
  config:
    sessionPath: 'F:/Ai/Deepseek/sync/.c189_session.json'
    # command: node
    # args: ['F:/Ai/Deepseek/_cloud189-mcp/src/index.js']
```

## 工具清单（10 个）

| 工具 | 作用 | 通道 | 可恢复 |
|---|---|---|---|
| `cloud189_list` | 列目录（`folderId` 或 `path`，根目录 `-11`） | PC | — |
| `cloud189_search` | 按文件名关键词搜索 | PC | — |
| `cloud189_download_link` | 取单文件临时下载直链（不下载内容） | PC | — |
| `cloud189_upload` | 上传本机文件（支持秒传） | PC | — |
| `cloud189_delete` | 删除文件/目录（默认进回收站） | PC | ✅ 可恢复 |
| `cloud189_recycle_list` | 查回收站（分页） | PC | — |
| `cloud189_recycle_restore` | 从回收站恢复 | PC | — |
| `cloud189_recycle_empty` | 清空回收站（**不可恢复**） | PC | ❌ 需 `confirm="EMPTY_RECYCLE_BIN"` |
| `cloud189_mkdir` | 新建目录 | 网页 cookie | — |
| `cloud189_quota` | 总容量 / 已用 / 剩余 | PC | — |

删除安全设计：

- 默认只进回收站，`cloud189_recycle_restore` 随时拉回；
- 清空回收站不可恢复，工具层强卡 `confirm="EMPTY_RECYCLE_BIN"`，不传就报错拒绝（单测已覆盖）；
- 没有把“删除”做成“上传后自动覆盖/移动”的隐形行为，写操作只做你明确点名的事。

## 本地验证（2026-11-26，公司 Windows 机，Node v20.18.1）

| 验证项 | 结果 | 证据 |
|---|---|---|
| 协议单测（含删除闸门、10 工具清单） | 9/9 通过 | `node --test test/protocol.test.mjs` |
| stdio 端到端：初始化 → 10 工具 → 列目录 → 配额 → 搜索 → **上传 → 删除 → 回收站 → 恢复 → 再删除** | 13/13 通过 | `verify/e2e-transcript-*.json` |
| DSH 壳：`apply()` 注册 10 工具 + 经壳调 quota | 全部通过 | `verify/plugin-smoke-*.json` |
| 上传/删除单文件探针 | 上传成功 + 删除返回“成功” | `verify/upload-probe2-out.json` |
| 网页通道全链路（ego 登录态收割 cookie 后）：建目录 → 上传进去 → 删除 → 回收站 → **网页恢复** → 回到原目录 → 清理 | 12/12 符合预期 | `verify/web-live.json` |

实测数字：根目录 14 个子目录；容量 12.02 TB、已用 213.42 GB、剩余 11.81 TB；测试文件上传后能在列表看到、删除后消失、回收站能找回、恢复后回到原目录。

### 未验证项（如实说明）

- **`cloud189_mkdir` / `cloud189_recycle_restore` 已真实跑通**（2026-11-26 23:33，网页 cookie 从 ego 浏览器现取）：建目录拿到 `folderId=823371289213440063`，上传后删除、回收站能查到、网页通道恢复后文件回到原目录。
- **网页 cookie 怎么来的**：ego 浏览器（用户已登录）→ CDP `Network.getAllCookies` 取出 `.e.189.cn` 的 `SSON/LT/OPENINFO` 与 `.cloud.189.cn` 系列，按域合并回 `.c189_session.json`（脚本 `verify/ego-harvest.mjs`，只打印数量不打印值）。登录态会过期，过期后这些工具会明确报错而不是静默失败。
- **一个已踩到的坑**：PC 签名通道根本没有 `/restoreFile.action`（实测 404，返回 `{status:404,error:"Not Found"}`）。早期实现把这佯当成了 `res_code=0` 的成功，所以恢复改走网页通道 `/api/open/recycleFile/restoreFile.action`，并且 `pcJson` 已加固：没有 `res_code` 且 HTTP ≥400 / 带 `error` 的响应一律报错。
- **`cloud189_recycle_empty` 故意未实测**：不可恢复操作（会清掉回收站里所有东西，不只是测试文件），不在验证阶段跑；闸门逻辑由单测覆盖。
- **删除后立即列同一目录可能仍看到它**：云盘侧有短暂最终一致性（`web-live.json` 里 `list-after-delete` 仍为 1），回收站里已经能查到，稍后刷新即消失。
- 大目录/深层目录未加分页与递归：`listFiles` 一次返回；`cloud189_list` 的 `path` 逐级解析，层数多时较慢。

## 安全边界

- 会话文件含登录态：`.gitignore` 已排除 `*.session.json`、`.c189_session.json`、`verify/`；不要提交、不要上云。
- 不发遥测；只访问 `cloud.189.cn` / `api.cloud.189.cn` / `download.cloud.189.cn` / `upload.cloud.189.cn`。
- 上传同名产生副本而不是覆盖（云盘侧行为）。

## License

MIT，见 `LICENSE`。
