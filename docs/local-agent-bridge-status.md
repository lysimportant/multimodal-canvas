# 方案 B「本地 Agent 聊天侧栏」完成情况汇报

日期：2026-10-31。对照计划：`C:\Users\Sui\.claude\plans\ancient-riding-prism.md`。

已定的产品决策：

- 画布工具调用一律自动放行，画布以外的操作（执行命令、改文件）也全部自动允许。
- 桥接程序由画布服务器自带下载（`GET /v1/agent-bridge/download`）。
- 本机 Agent 在每个项目专用的空文件夹 `~/.canvas-agent/<projectId>` 里工作。

## 一、当前状态

除「真实 Agent 全链路联调」与「Docker 镜像构建」外全部完成，改动已分三批提交（见第四节）。

| 模块                                               | 状态            | 说明                                                                                                                              |
| -------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 桥接 CLI `packages/bridge/`                        | ✅ 已重写并构建 | 基于 `@agentclientprotocol/sdk` 2.2.0 真实 API，产物 `dist/index.js` 237.7 KB，`--help` / 缺参退出码正确                          |
| API 中继路由 `apps/api/src/agent-bridge-routes.ts` | ✅              | 7 个接口：connect（NDJSON 长连接、20 秒心跳）、创建会话、发送提示词、取消、SSE 事件流、桥接事件回传、匿名下载                     |
| 下载默认路径                                       | ✅              | 改为 `import.meta.dirname`（ESM 产物）+ 存在性探测；API 构建时由 `scripts/copy-bridge.mjs` 复制到 `apps/api/dist/bridge/index.js` |
| API 测试                                           | ✅              | `agent-bridge-routes.test.ts` 7 个用例；`agent-bridge-e2e.test.ts` 5 个进程级用例                                                 |
| 侧栏 `LocalAgentChatPanel.tsx` / `.css`            | ✅              | 启动命令、下载、连接、发送、流式显示、停止、断开                                                                                  |
| `App.tsx` 接入                                     | ✅              | 桌面与移动端「本地 Agent」入口；切换项目或账户时重置状态；抽屉 `open={open && !closed}` 修正                                      |
| `AgentConnectionPanel` 的 Canvas Bridge 标签       | ✅              | 下载按钮、启动命令、复制按钮                                                                                                      |
| E2E                                                | ✅              | `local-agent-chat` 3 个宽度通过、`agent-canvas` 10 个通过（合计 13 passed）                                                       |
| 格式化 / 类型检查                                  | ✅              | 改动与新增文件 Prettier 干净；`pnpm typecheck` 17/17 通过                                                                         |
| 文档                                               | ✅              | 本文与 `docs/canvas-agent-mcp.md`                                                                                                 |

## 二、本轮修了什么

### 1. 桥接程序重写（原问题 1 的 a～k）

计划里写的 `ClientSideConnection` / `ndJsonStream` 旧 API 在 SDK 2.2.0 中已不存在，实际可用的是 `client()` → `connect(ndJsonStream(...))` → `connection.agent.buildSession(...)` → `ActiveSession`。重写后逐项对应：

| 原问题                                           | 处理                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| a 手写 JSON-RPC、缺 `jsonrpc`、从不 `initialize` | 改用 SDK；连接后显式 `request(methods.agent.initialize, …)`，再 `session/new`                        |
| b 不保存 ACP `sessionId`                         | 由 `ActiveSession` 持有，`Map<bridgeSessionId, { acp, queue }>` 复用并串行化                         |
| c 权限回复格式错误                               | 回 `{ outcome: { outcome: 'selected', optionId } }`，优先 `allow_always` → `allow_once` → 第一个选项 |
| d 事件双重编码                                   | `TaskSink` 只序列化一次，按序批量 POST NDJSON                                                        |
| e `taskId` 闭包捕获错任务                        | 按 `Map<acpSessionId, currentTaskId>` 动态取当前任务                                                 |
| f 不发送 `done`                                  | prompt 正常结束发 `done`；异常发 `agent_error` + `done`                                              |
| g `setTimeout` 代替 `await`                      | 全部改为 `await` / promise 链，`done` 保证最后                                                       |
| h 断线不重连                                     | 指数退避 1→2→4…30 秒重连，收到 `ready` 后重置                                                        |
| i 取消杀进程                                     | 改发 `session/cancel` 通知，会话保留可继续                                                           |
| j 从令牌截取 `projectId`                         | `--project` 改为必填；面板启动命令同步补 `--project <projectId>`                                     |
| k `--agent-args` 未传给 `spawn`                  | 与内置参数拼接后传入；另加 `--agent-cmd` 便于替换可执行文件                                          |

额外发现并修复：

- `build.mjs` 的 banner shebang 与源码首行 shebang 重复，构建产物 `node dist/index.js` 直接 `SyntaxError`；已删源码 shebang。
- `packages/bridge` 缺 `@types/node` 导致 `typecheck` 失败；已补 devDependency（离线安装）。
- 面板命令原缺 `--project`，而 `connect` 路由强制要求 `projectId`，连上也会 400/401。

### 2. 构建与打包（原问题 2）

- `pnpm --filter ./packages/bridge build` 生成 `packages/bridge/dist/index.js`。
- 新增 `scripts/copy-bridge.mjs`；`apps/api` 的 build 改为 `tsc -p tsconfig.json && node ../../scripts/copy-bridge.mjs`。
- `apps/api` devDependencies 增加 `@multimodal-canvas/bridge: workspace:*`，借 turbo `build.dependsOn: ["^build"]` 保证先构建桥接。
- `Dockerfile` 安装层补 `COPY packages/bridge/package.json`，构建层补 `COPY scripts/copy-bridge.mjs`。
- `pnpm-lock.yaml` / `pnpm-workspace.yaml` 已同步（含 SDK 2.2.0 的 `minimumReleaseAgeExclude`）。

另修复一个只在生产 ESM 产物里才会炸的 bug：`agent-bridge-routes.ts` 下载默认路径原为 `join(dirname(__dirname), 'bridge', 'index.js')`。`apps/api` 是 `"type": "module"`，ESM 下 `__dirname` 不存在（vitest 会注入所以测试掩盖了它），且拼出的目录比产物少一层。现改为：

```ts
function defaultBridgeFilePath(): string {
  const candidates = [
    join(import.meta.dirname, 'bridge', 'index.js'),
    resolvePath(import.meta.dirname, '..', '..', '..', 'packages', 'bridge', 'dist', 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
```

第二个候选兼容从 `src` 直接运行。下载接口已在端到端用例中验证返回 200、`application/javascript`、`attachment; filename="canvas-bridge.js"`。

### 3. E2E（原问题 3）

- `apps/web/e2e/local-agent-chat.spec.ts` 的夹具补 `GET /v1/account/newapi` 与 `POST /v1/account/newapi/sync`。
- 另发现侧栏 Drawer 用 `open={!closed}` 忽略父组件 `open`，页面一加载抽屉就打开并挡住点击；已改为 `open={open && !closed}`。
- `apps/web/e2e/agent-canvas.spec.ts` 有同型缺失（页面装载请求 account 接口被隔离夹具记为未声明），已在该 spec 自己的夹具内补齐，未改共享 helper。

### 4. 格式化（原问题 4）

原问题列出的 4 个文件，加上本轮新增的 `agent-bridge-e2e.test.ts`、`fixtures/fake-acp-agent.mjs`，全部 `prettier --write` 后复检通过。

### 5. URL 连接长期有效审查（原问题 5）

三项重点全部核实（只读审查，未改代码）：

- **旧限时连接仍按原逻辑到期**：`agent-access.ts:223-245` 的 `resolveUrlKey` 仍校验 `session.expiresAt`，过期即拒。
- **吊销后 URL 密钥立即失效**：`revoke()`（`agent-access.ts:265-276`）写吊销记录并删缓存，无状态签名不会“复活”。
- **前端无残留「本地/服务器」模式**：`AgentConnectionPanel` 已去掉模式切换与有效期输入，无遗留调用与文案。

相关测试：API 73/73（canvas-agent-routes 43、agent-access 24、agent-url-connections 6），Web `AgentConnectionPanel` 37/37。

遗留风险（未修，供后续跟进）：

| 编号 | 级别   | 说明                                                                                                                                 |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1   | MEDIUM | `agent-access.ts:110-131` 每进程全局 100 连接上限；长期密钥不再释放条目，累计 100 个活连接后新建设全部 409。建议改为按用户维度限流。 |
| R3   | LOW    | 吊销记录（tombstone）只增不减。                                                                                                      |
| R4   | LOW    | `canvas-agent-routes.ts:150` 硬编码 `available: true`，面板的不可用分支成为死代码。                                                  |
| R5   | LOW    | 文档未提示 `MemoryAuthStore` 下重启后旧密钥失效；升级后旧格式密钥需重新创建。                                                        |
| R6   | LOW    | 缺少 HTTP 级过期用例（仅服务层单测覆盖）。                                                                                           |

### 6. 端到端验证（第 6 步）

本机没有 `DATABASE_URL` / Postgres / Redis，起不了真实 API，因此端到端改为“真实桥接进程 + 内存 API 夹具 + 合成 ACP Agent”的进程级联调：

- 新增 `apps/api/src/fixtures/fake-acp-agent.mjs`：最小 ACP Agent（stdio NDJSON），按提示词返回 chunk、tool call、权限请求、usage，支持报错与取消分支，并记录收发的每一条消息。
- 新增 `apps/api/src/agent-bridge-e2e.test.ts`：`spawn` 真实 `packages/bridge/dist/index.js`，覆盖 5 个场景——提示词转发（chunk 拼接、tool_call、usage_update、`done` 最后）、`allow_always` 自动放行、取消后同一会话可继续、Agent 报错后仍可恢复、中继断线自动重连（ACP 会话复用、Agent 未重启），以及下载接口内容校验。

未做：真实 Claude Code / Codex Agent 的全链路手工联调、Docker 镜像构建。

### 7. 其他

- MCP 地址里的令牌仍放在查询参数（沿用面板生成的 `mcpPath`）。这是受 `app.ts:1634` 限制：`?connection=` 与 `Authorization` 头互斥，混用会 400。该令牌只会出现在本机 Agent 的配置/日志里，如需更严格可后续给下载接口加鉴权或做日志脱敏。
- `canvas-mcp.cordis.yml`（含连接令牌）已加入 `.gitignore`。
- `回声-爱情漫画-分镜脚本.md` 与本功能无关，未提交。

## 三、验证记录

```bash
pnpm typecheck                       # 17/17 成功，37.8s
pnpm --filter ./packages/bridge build # dist/index.js 237.7kb；--help 正常；缺参 exit 2
pnpm --filter ./apps/api build       # tsc + copy-bridge → apps/api/dist/bridge/index.js
pnpm --filter ./apps/api test        # 86 passed | 7 skipped（93 文件），1424 passed | 102 skipped（1526 用例），160s
pnpm --filter ./apps/web test:e2e -- e2e/local-agent-chat.spec.ts e2e/agent-canvas.spec.ts  # 13 passed，1.1m
npx prettier --check <本轮改动与新增文件>  # 全部通过
```

Web 单测全量：2884 passed / 35 failed（2919）。35 个失败全部是既有用例的 5 秒超时（分布在 App、canvas-editor、NodeQuickEditor、SkillWorkbench 等与本次改动无关的文件），满载并发下复现；抽样隔离重跑 `NodeQuickEditor` + `App` 两个套件 398/398 全部通过，判定为机器负载导致的既有 flaky，不是本次回归。本次相关的 `LocalAgentChatPanel`、`AgentConnectionPanel` 用例均通过。

## 四、提交

1. `f9ebbd6` feat(agent): URL 连接改为长期有效，重启后无需重新连接
2. `69fb7d9` feat(agent): 新增本地 Agent 桥接中继与 ACP 桥接 CLI（含构建脚本、Dockerfile、内存夹具端到端测试）
3. feat(web): 新增本地 Agent 聊天侧栏与 E2E（本文档随该提交）

未提交：`canvas-mcp.cordis.yml`（已被 .gitignore 忽略）、`回声-爱情漫画-分镜脚本.md`。

## 五、建议后续

1. 在有数据库的环境启动 API + Web，用真实 Agent 跑一遍：创建 URL 连接 → `node packages/bridge/dist/index.js --api http://localhost:8787 --token <urlKey> --project <projectId> --agent claude` → 发送「新建一个图片节点，提示词是一只橘猫，然后生成」→ 验证节点出现、侧栏流式、结束；再验证长任务停止后可继续、重启 API 自动重连。
2. 跑一次 Docker 镜像构建，确认镜像内存在 `dist/bridge/index.js` 且下载接口 200。
3. 按需处理 R1（连接上限按用户维度）、R3（tombstone 清理）、R4（`available` 真实状态）。
