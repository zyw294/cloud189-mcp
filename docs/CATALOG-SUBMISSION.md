# 收录对齐与提交流程（dsh-plugin-catalog / awesome-dsh-plugin）

本轮只做开发与本地验证，**未发布、未提交**。下面是把两个包送进 DSH 插件市场/社区目录所需的硬条件与步骤，依据是 2026-11-26 查到的公开说明。

## 一、收录的硬条件（各市场基本一致）

| 条件 | 适用对象 | 当前状态 |
|---|---|---|
| `package.json` 里有 `dsh-plugin` keyword | DSH 插件（`plugin/`） | ✅ 已有 |
| `package.json` 里有 `dsh.bundle` 字段，指向 `cordis.patch.yml` | DSH 插件 | ✅ 已有（`./cordis.patch.yml`） |
| 开源 License | 两个包 | ✅ MIT（`LICENSE`） |
| 公开 GitHub 仓库 + `repository` 字段 | 两个包 | ❌ 缺（尚未建仓） |
| 已发布到 npm | 两个包 | ❌ 未发布（等你确认包名与账号） |
| 仓库打 `dsh-plugin` GitHub topic | DSH 插件 | ❌ 待建仓后加 |

来源：DSH Plugin Shop 的收录说明（“把 `dsh-plugin` 加进 keywords、package.json 里要有 `dsh.bundle`、再加 license 与 source repository，然后 publish 到 npm，每日构建才能发现”）— https://dedupedai.com/use-cases/livxue-dsh-plugin-shop/list-plugin-in-catalog （2026-10-20）；dshmarketplace.dev 提交页（“给仓库打 topic，下一轮同步就会发现”）— https://dshmarketplace.dev/zh/submit 。

## 二、四条提交路径（可叠加，不冲突）

1. **自动发现（最省事）**：GitHub 仓库打上 `dsh-plugin` topic，多个市场（含 DSH 自带市场与 dshmarketplace.dev）会自动揃取。来源：https://dshmarketplace.dev/zh/submit 、https://deepseekharnessplugins.com/submit （2026-11-20）。
2. **awesome-dsh-plugin 的 PR（要 Curated 标）**：向 `cccakeee/awesome-dsh-plugins` 提 PR。社区目录的本质是一份可读的 `index.json`，条目指向的安装物得真实存在。来源：https://deepseekharnessplugins.com/submit 、https://github.com/cheng200606/dsh-plugin-codemap/blob/HEAD/docs/publishing.md （2026-11-01）。
3. **dsh-plugin.org 提交表单**：公开仓库 + topic + 填写描述、安装命令、许可证与兼容信息，人工审核后生成条目并定期刷新。来源：https://dsh-plugin.org/zh/submit 。
4. **自托管索引**：市场默认 `indexes: []`，也可以自己搭一个 `index.json` 让别人添加源。来源：https://github.com/cheng200606/dsh-plugin-codemap/blob/HEAD/docs/publishing.md 。

## 三、发布前要做的事（按顺序）

1. **建仓库并补元数据**：两个包各建一个公开仓库（或一个 monorepo 两个 `package.json`）；把 `repository` / `homepage` / `bugs` 写进 `package.json`；仓库描述写成“它能干什么”而不是实现细节。
2. **定包名**：`cloud189-mcp` 与 `dsh-cloud189-mcp` 是否可用未查（npm 上可能已有同名/近似包），发布前需先 `npm view <name> version` 确认，再定最终名字。
3. **npm 登录与发布**：`npm login` 用你自己的账号，两个包分开发：
   ```bash
   cd F:/Ai/Deepseek/_cloud189-mcp && npm publish --access public
   cd plugin && npm publish --access public
   ```
   发布前把 `package.json` 的 `version`、`repository` 补齐，并确认 `files` 里没漏 `src`/`lib`。
4. **打 topic + 提 PR**：仓库加 `dsh-plugin` topic；同时给 `cccakeee/awesome-dsh-plugins` 提一条 PR（entry 指向 npm 包名与仓库）。
5. **装后自检（沿用你定下的口径）**：先备份 profile 四件套（`package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` / `pnpm-workspace.yaml`），`dsh plugin --profile desktop add dsh-cloud189-mcp@<ver>`，重启后核：进程常驼、会话数不变、无新增 `crash-*.log`、`node_modules` 顶层目录数变化在预期内。

## 四、最终形态：单包 `cloud189-mcp`（2026-11-26 拍定）

按用户指定的包名，只发**一个**包 `cloud189-mcp`，同时承担两个角色：

- 对普通 MCP 宿主：`bin.cloud189-mcp` → `src/index.js`（stdio server）；
- 对 DSH：`dsh.bundle.patch` → `cordis.patch.yml` → `lib/index.js`，用 `ctx.tools.register` 注册全部工具，且**自己 spawn 包内的 `src/index.js`**，不依赖 PATH 或全局安装。

所以 keywords 里带 `dsh-plugin`、`package.json` 里带 `dsh.bundle` 是对的：这个包确实是 DSH 插件（同时也能被非 DSH 的 MCP 宿主直接当 server 用）。之前的 `dsh-cloud189-mcp` 外壳包已取消，避免两份代码。

装法二选一（发布后）：

```bash
dsh plugin --profile desktop add cloud189-mcp@0.2.0     # DSH 插件形态
npx -y cloud189-mcp --session <会话文件>              # 任意 MCP 宿主
```
