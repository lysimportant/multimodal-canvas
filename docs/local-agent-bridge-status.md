# 本地 Agent 聊天侧栏：直连本地 Agent 改造

日期：2026-11-01。本文替代前两版记录（方案 B 服务端中继）。改动尚未提交，见第六节。

## 一、背景与结论

前两版实现的是「浏览器 → 画布 API 中继 → 本机桥接 → Agent」的中继模式：用户必须先在 Agent 连接面板创建服务器连接、把连接密钥贴进启动命令，Agent 事件经画布 API 的 SSE 转回浏览器。

需求方明确要求改成 `github.com/basketikun/infinite-canvas` 那样的**直连本地 Agent**：本机跑一个守在 `127.0.0.1` 的小服务，画布侧栏直接连它，聊天数据不经过画布服务器。本轮因此做了两件事：

1. `packages/bridge` 增加 `--local` 直连模式：本机启动 HTTP + SSE 服务，默认 `127.0.0.1:17871`，启动时打印 `Local URL` 与 `Connect token`。
2. `LocalAgentChatPanel` 从「贴启动命令连服务器」改为「填本地地址 + 连接令牌直连本机服务」，聊天事件流直接读本机 SSE。

服务端中继模式（`--api/--token/--project`）**保留**作为备选：CLI 和 API 中继路由、它的测试都还在，只是 UI 默认不再使用。若以后要做「浏览器在 A 机器、Agent 在 B 机器」，再接回来。

## 二、当前架构

```
浏览器画布 (侧栏)  ──HTTP+SSE(Bearer token)──▶  canvas-bridge --local (127.0.0.1:17871)  ──ACP(stdio)──▶  Agent CLI (claude/codex/…)
        │                                                     │
        └── 画布 API：创建/读取 URL 连接，渲染画布同步、MCP 工具调用 ──┘
```

- 聊天消息、流式输出、取消、断开全部走本机 `127.0.0.1`，不经画布服务器。
- Agent 仍然需要画布 MCP 才能改画布：画布页面在建立会话时把自己的 MCP 地址（带连接密钥的 `mcpPath`）下发给本机桥接，桥接用 `withMcpServer({ type: 'http', … })` 注入。这样桥接不需要预先知道项目 ID，连接密钥也能在画布侧吊销。
- 若项目还没有可用的 URL 连接，侧栏会自动创建一个（同 Agent 连接面板的行为）。

### 本机接口协议（`packages/bridge` 的 `LocalAgentServer`）

| 方法   | 路径                   | 说明                                                                  |
| ------ | ---------------------- | --------------------------------------------------------------------- |
| GET    | `/health`              | 免令牌；返回 `{ ok, name, version, agent }`，侧栏用它判断服务是否在跑 |
| POST   | `/sessions`            | `{ projectId?, mcpUrl? }` → 201 `{ sessionId }`；按会话复用 ACP 会话  |
| GET    | `/sessions/:id/events` | SSE：`data: <事件 JSON>`，20 秒 `: ping` 心跳                         |
| POST   | `/sessions/:id/prompt` | `{ messages }` → 202 `{ taskId }`；并发发送 409 `prompt_in_progress`  |
| POST   | `/sessions/:id/cancel` | 204；当前没有任务时 409 `no_active_task`                              |
| DELETE | `/sessions/:id`        | 204，侧栏断开时通知桥接释放 ACP 会话                                  |

- 除 `/health` 外都要求 `Authorization: Bearer <Connect token>`。
- 令牌持久化在 `~/.canvas-agent/local-agent.json`（权限 0600），首次启动自动生成；可用 `--local-token` 覆盖。
- 仅监听回环地址；CORS 回显 `Origin`、允许 `authorization`/`content-type`、带 `access-control-allow-private-network: true`（Chrome 私有网络访问要求）。
- 事件类型与旧中继模式一致（`agent_message_chunk` / `tool_call` / `usage_update` / `done` / `agent_error`），侧栏渲染逻辑不变。
- 权限请求仍然全部自动放行：优先 `allow_always`，其次 `allow_once`，再退第一个选项。

## 三、本轮改动

### 1. 桥接程序 `packages/bridge`

- `src/index.ts` 重写为双模式（约 1350 行）：`--local` 直连服务 + 原有中继模式；公共的 `AgentHost` 负责 spawn Agent、ACP 会话复用/串行、权限自动放行、事件归一化。
- 新增 `--local`、`--host`、`--port`（允许 `0` 由系统分配，测试用）、`--local-token` 参数；本地模式不需要 `--api/--token/--project`，中继模式缺参时提示可改用 `--local`。
- 新增 `packages/bridge/test/local-agent.test.mjs`（`node --test`，9 个用例）与 `test/fixtures/fake-acp-agent.mjs`（合成 ACP Agent，支持正常流、权限请求、报错、取消分支，并记录收发报文）。
- 版本号 `0.2.0`；`package.json` 增加 `"test": "node ./build.mjs && node --test test/local-agent.test.mjs"`。
- 修掉一个重复推送问题：`session/update` 的 `tool_call` 与随后到达的权限请求都会推工具调用，现在用 `emittedToolCalls`（key 为 `acpSessionId:toolCallId`）去重。

### 2. 侧栏 `apps/web/src/workspace/LocalAgentChatPanel.tsx` / `.css`

- 未连接时显示：启动命令 `node canvas-bridge.js --local --agent claude`（可复制）、「下载桥接程序」按钮、「本地地址」（默认 `http://127.0.0.1:17871`）、「连接令牌」输入框、「连接」按钮。
- 地址与令牌存 `localStorage`（key `canvas-agent-local-connection`），刷新后回填。
- 连接顺序：校验令牌非空 → `GET /health` 探活 → 复用或创建画布 URL 连接拿 `mcpPath` → `POST /sessions`（带令牌与绝对 `mcpUrl`）→ 打开 SSE。
- 连接失败分别提示：服务没启动、令牌无效（401）、画布连接数已达上限（409）、无法创建画布连接。
- 断开时中止 SSE 并 `DELETE /sessions/:id`；切换项目或账户变化时重置。
- 保留 8 秒请求超时，避免服务无响应时按钮一直转圈。

### 3. 测试

- `LocalAgentChatPanel.test.tsx` 重写为 15 个用例：默认值/回填、令牌校验、连接流程（含 `mcpUrl` 与 `Authorization` 头断言）、自动创建画布连接、各种失败提示、发送前保存画布、SSE 渲染、工具调用、停止、断开、账户重置。
- `apps/web/e2e/local-agent-chat.spec.ts` 重写：mock 本机桥接 origin（含 CORS 预检、`/health`、`/sessions`、SSE、`DELETE`），1440 / 390 / 320 三个宽度验证启动命令、直连流程、`sessionCreates` 合同与面板不横向溢出；顶栏「连接 Agent」「本地 Agent」两个文字按钮继续校验文字不溢出按钮。
- `packages/bridge/test/local-agent.test.mjs` 覆盖：health 免令牌、令牌校验/未知会话 404、完整流（chunk、tool_call 去重、usage、`done` 最后）、取消后继续、忙时 409、无任务取消 409、Agent 报错、空提示词 400、只 initialize 一次。
- 原中继侧测试不受影响：`apps/api/src/agent-bridge-routes.test.ts`（7）与 `agent-bridge-e2e.test.ts`（5）全部通过，后者仍以真实 `packages/bridge/dist/index.js` 进程跑中继模式。

## 四、验证记录

```bash
pnpm --filter ./packages/bridge typecheck        # 通过
pnpm --filter ./packages/bridge test             # 9/9 通过（含 build）
pnpm --filter ./apps/api build                   # tsc + copy-bridge → apps/api/dist/bridge/index.js
pnpm --filter ./apps/api exec vitest run src/agent-bridge-routes.test.ts src/agent-bridge-e2e.test.ts  # 12/12
pnpm --filter ./apps/web typecheck               # 通过
pnpm --filter ./apps/web exec vitest run src/workspace/LocalAgentChatPanel.test.tsx                    # 15/15
pnpm --filter ./apps/web test:e2e -- e2e/local-agent-chat.spec.ts                                      # 3 passed（1440/390/320）
npx prettier --check <本轮改动与新增文件>        # 通过
```

## 五、如何使用（本机手工联调）

1. 在画布侧栏「下载桥接程序」，或直接从仓库取 `packages/bridge/dist/index.js` 并 `pnpm --filter ./packages/bridge build`。
2. 本机运行：`node canvas-bridge.js --local --agent claude`（Agent 可换 `codex`/`gemini`/`opencode`/`qwen`；也可用 `--agent-cmd` 指定任意 ACP Agent 可执行文件）。首次运行会在 `~/.canvas-agent/local-agent.json` 生成令牌。
3. 记下终端打印的 `Local URL: http://127.0.0.1:17871` 与 `Connect token: …`。
4. 打开画布右侧「本地 Agent」面板，确认地址、粘贴令牌，点「连接」。之后发消息即可；Agent 用画布 MCP 直接改当前项目，聊天内容只在浏览器与本机进程之间传输。
5. 换端口用 `--port`，换 Agent 用 `--agent`；令牌可 `--local-token` 固定。诊断日志在 stderr（`[canvas-bridge …]`）。

## 六、提交

本轮改动尚未提交。工作区变更：

- 修改：`packages/bridge/src/index.ts`、`packages/bridge/package.json`、`apps/web/src/workspace/LocalAgentChatPanel.{tsx,css,test.tsx}`、`apps/web/e2e/local-agent-chat.spec.ts`
- 新增：`packages/bridge/test/local-agent.test.mjs`、`packages/bridge/test/fixtures/fake-acp-agent.mjs`、本文

历史提交（中继模式阶段）：

1. `f9ebbd6` feat(agent): URL 连接改为长期有效，重启后无需重新连接
2. `69fb7d9` feat(agent): 新增本地 Agent 桥接中继与 ACP 桥接 CLI
3. `e429445` feat(web): 新增本地 Agent 聊天侧栏与验收用例
4. `6eb5400` fix(web): 修复顶栏 Agent 与本地 Agent 按钮文字溢出
5. `4f6ee62` fix(web): 同源部署时桥接命令回退到页面来源地址

未提交无关文件：`回声-爱情漫画-分镜脚本.md`。

## 七、未完成与风险

1. **真实 Agent 全链路联调未做**：本机没有 Postgres/Redis 与画布数据库配置，API 只能用内存夹具；Agent 侧用合成 ACP Agent 验证。需要一台能起完整画布服务的机器手工跑一次 Claude Code / Codex。
2. **Docker 镜像未重建**：运行中的 `multimodal-canvas-web:local` 是 2026-10-26 构建，不含本地 Agent 功能；需 `pwsh -File scripts/docker.ps1 Start` 重新构建后验证下载接口与侧栏。
3. **安全边界**：本机服务只监听回环地址且需令牌，但令牌明文保存在 `~/.canvas-agent/local-agent.json`；恶意网页无法读取该文件，但仍可通过 127.0.0.1 发起请求（无令牌会被拒）。若需更严格，可增加「首次连接确认」或 Origin 白名单（参考 infinite-canvas 的做法）。
4. **画布连接上限**：`agent-access.ts:110-131` 仍是每进程全局 100 条 URL 连接上限，侧栏自动创建连接会加速消耗；建议改为按用户/项目维度限流（原 R1）。
5. **中继模式保留但 UI 未暴露**：CLI 仍可用，文档未写详细步骤；如果确定不再使用，可后续删除 `apps/api/src/agent-bridge-routes.ts` 与对应测试，减小维护面积。
6. **`--local` 端口冲突**：17871 被占用时启动会失败并打印错误，目前需手动 `--port` 换端口。
