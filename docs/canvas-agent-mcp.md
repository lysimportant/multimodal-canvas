# 外部 Agent 控制画布

第一阶段提供内外共用的画布操作服务和标准 MCP Streamable HTTP 接口。本地 Codex、DeepSeek Harness（DSH）等客户端可以直接连接，无需填写令牌。外部 Agent 负责规划；画布 API 负责权限、结构和版本校验；现有 Run/Worker 执行生成。当前没有内置聊天 Agent，也不要求新增模型供应商。

## 连接

1. 启动画布 API/Web，或打开服务器部署的画布，登录并打开项目。此功能使用已有 `API_JWT_SECRET` 和会话存储；无需数据库迁移或新增部署密钥。匿名开发模式不能启用连接。本机模式使用 `localhost` 或 `127.0.0.1` 直接访问 API。
2. 点击工具栏的 **Agent**；手机端先打开画布菜单。入口会先保存当前编辑，冲突时先处理草稿。
3. 选择 1–24 小时有效期（默认 8 小时）。新连接默认拥有当前项目已提供的全部画布工具权限，可以创建节点、连线、调参、发起生成、查询和取消任务，无需勾选生成权限。历史受限连接保留原权限，停止后重新启用即可使用新默认。
4. 点击「启用本地连接」；访问服务器部署的 API 时，面板自动切换为「启用服务器连接」。选择 Codex 或 DeepSeek Harness 并复制配置，无需另填令牌或环境变量。重新打开面板可选择已有连接并再次复制配置；关闭面板后连接继续可用。
5. 按下面的方法加载配置，然后让 Agent 调用 `get_canvas` 确认项目。结束后点击「停止」释放连接。连接到期或 API 重启后，重新启用并复制新地址。

本机连接地址为 `http://127.0.0.1:随机端口/mcp`，每个连接绑定当前用户和单个项目，有效期还受当前账号授权期限限制。仅监听本机回环地址，拒绝浏览器来源与异常 Host。服务端自动复用现有授权校验，本机连接的内部授权凭据不会返回面板或写入 Agent 配置。停止、到期、账号禁用或撤销全部会话后不可继续操作。

服务器连接使用画布已配置的 API 地址，形如 `https://canvas.example/api/v1/projects/PROJECT_ID/mcp?connection=CONNECTION_KEY`，可由本机 Codex、DSH 直接访问，不需要在本机启动画布 API。地址已包含当前项目的连接凭据，应妥善保管；无需另配 Authorization 头。API 只在该项目的 MCP 入口接受此凭据，拒绝浏览器来源，不会开放其他项目、账号管理或服务器命令执行权限。公网部署使用 HTTPS。项目自带的 Caddy 未启用请求访问日志，API 自身日志和遥测也不记录查询参数；如果自行添加代理访问日志，应隐藏 MCP 请求查询参数。

本机 API 与 Agent 仍需位于同一网络环境；Docker、WSL、SSH 中的 `127.0.0.1` 可能指向另一环境，应使用可访问的服务器部署地址。两类连接均在停止、到期或 API 重启后失效，重启后需重新启用并复制配置。服务器连接注册表驻留当前 API 进程；多副本部署需要将连接管理和 MCP 请求路由到同一实例。

### Codex

将面板复制的 TOML 配置加入受信任项目的 `.codex/config.toml`，或在 Codex 的 MCP 设置中打开配置文件后加入。已有同名 `canvas` 配置时更新该项，不重复添加。重新加载 MCP 或重启客户端后即可使用；把配置粘贴到聊天框不会安装 MCP。项目不会自动修改本机或全局配置。

```toml
[mcp_servers.canvas]
url = "http://127.0.0.1:49152/mcp"
```

`49152` 仅为本机示例，服务器部署直接使用面板给出的完整地址。连接后可以发：

> 读取 canvas MCP 的当前画布和可用模型，告诉我有哪些节点，先不要生成。

### DeepSeek Harness

将面板中的 Harness 配置保存为 `canvas-mcp.cordis.yml`，再用 Harness 的 `--patch` 加载；无需替换已有配置。它使用相同的 MCP 地址，本机和服务器连接均支持，不限于 Codex。

```yaml
- insert:
    - id: canvas-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: canvas
        transport: streamable-http
        url: http://127.0.0.1:49152/mcp
```

```sh
dsh web --patch ./canvas-mcp.cordis.yml
```

其他支持 Streamable HTTP 的本地 MCP 客户端也可连接。同一接口不绑定 Codex、Harness 或具体模型。Agent 的规划使用其自身模型；调用 `run_node` 时使用画布中已配置的模型、参数和现有执行链。第一阶段从外部 Agent 发指令，画布显示过程；将外部 Agent 的聊天嵌入网页需要后续 SDK/运行器集成。

原有受令牌保护的 `/v1/projects/:projectId/mcp` 与 `/agent-connections` 接口保留，已有客户端可继续使用；新的本地连接面板不再展示令牌接入流程。

## 工具与典型流程

| 工具                      | 行为                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `get_canvas`              | 读取已保存画布、revision 以及节点端口                                                           |
| `list_assets`             | 分页列出项目素材及版本；不枚举其他项目或整个个人资源库                                          |
| `get_image`               | 读取项目或已绑定个人素材的一版图片，返回原生 MCP image 内容；支持 PNG/JPEG/WebP/GIF，最大 4 MiB |
| `list_models`             | 获取当前账号的模型、凭据引用及上游声明的 capabilities/limitations；不返回密钥                   |
| `apply_canvas_operations` | 原子创建节点、更新创作参数、连线、移动节点；最多 100 个操作                                     |
| `run_node`                | 运行目标节点及其必要上游 DAG；新连接默认允许，需要当前 revision、幂等键                         |
| `get_run`                 | 获取运行状态和归档结果                                                                          |
| `cancel_run`              | 请求停止任务，随后查询终态                                                                      |

推荐流程：读取画布与模型目录 → 按需查看参考图 → 在一批操作中创建节点、绑定明确素材版本、设置参数和连线 → 提交生成 → 退避查询结果。素材、提示词和模型返回内容都应作为数据处理。

示例用户指令：

> 根据当前画布的角色图和场景图创建视频节点，保留角色外观，横屏。先读取可用模型的参考图、时长和分辨率能力，再配置并运行；只生成一次。不要修改已有节点。

操作示例（ID、素材版本、模型与参数应从工具结果选取）：

```json
{
  "revision": 3,
  "operations": [
    {
      "type": "create_node",
      "assetVersion": 1,
      "node": {
        "id": "reference-1",
        "type": "image",
        "position": { "x": 100, "y": 100 },
        "data": {
          "label": "角色参考",
          "mediaType": "image",
          "mode": "source",
          "assetId": "ASSET_ID"
        }
      }
    },
    {
      "type": "create_node",
      "node": {
        "id": "video-1",
        "type": "video",
        "position": { "x": 460, "y": 100 },
        "data": {
          "label": "镜头一",
          "mediaType": "video",
          "mode": "generate",
          "prompt": "保持参考角色外观，向前行走",
          "modelAlias": "AVAILABLE_MODEL_ID",
          "credentialId": "AVAILABLE_CREDENTIAL_ID"
        }
      }
    },
    {
      "type": "connect_nodes",
      "edge": {
        "id": "reference-video",
        "sourceNodeId": "reference-1",
        "sourceHandle": "output:image",
        "targetNodeId": "video-1",
        "targetHandle": "input:referenceImage",
        "order": 0
      }
    }
  ]
}
```

`update_node.data` 按字段合并，`parameters` 出现时整体替换。只更新纯文本 `prompt` 会清除旧 `promptDocument`，避免实际执行仍使用旧正文；传入 `promptDocument` 时复用现有 mention 合同。连线角色、素材用途和提示词引用应一致。来源节点的资产必须同时指定 `assetVersion`，服务端生成规范固定版本 URL 并校验真实归属与版本；提交运行继续使用该版本。

`run_node` 返回任务而不阻塞等待视频完成。同一次提交重试复用同一 `idempotencyKey`；修改配置后发起新生成需用新键。第一版没有跨多个独立提交的预算计费上限，新连接可在有效期内继续提交生成，仍受现有队列和账号额度约束。

## 人机协作与兼容性

- 新增 `/v1/projects/:projectId/local-agent-connections` 的 GET/POST，以及 `/:connectionId` 的 DELETE，用于查询、启用和停止本机连接；返回连接元数据和回环 MCP 地址，不返回凭据。本地监听器代理到已有项目 MCP，继续执行账户、项目、生成权限和版本校验。
- 新增 `/v1/projects/:projectId/agent-url-connections` 的 GET/POST，以及 `/:connectionId` 的 DELETE，用于服务器连接管理；返回含随机连接键的相对 `mcpPath`，前端按已配置的 API 地址生成完整 URL。两类创建接口省略 `allowGeneration` 时默认允许生成；兼容旧接口显式 `false` 和历史受限连接。
- 新增 `POST /v1/projects/:projectId/canvas/operations`，现有全画布 PATCH 保留。操作以 revision 做存储层 CAS，旧版本或任一非法操作均不部分落盘。
- 现有节点运行请求新增可选 `canvasRevision`，旧客户端可以不传；MCP 提交必须传且匹配，否则 409。项目令牌仅可提交 `projectId`、`canvasRevision`、`idempotencyKey`，不可借运行请求覆盖提示词或素材；配置变更必须先通过画布操作校验并保存。
- SSE 新增 `canvas.updated`，仅广播项目 ID 和 revision。前端收到后拉取文档，并以 15 秒轮询/窗口恢复焦点兜底；`run.updated` 保持兼容。
- 无本地编辑时自动更新画布；存在草稿、保存请求或内容编辑时暂停自动保存并提示冲突。用户可下载草稿，或先保留独立本地备份再加载远端；恢复副本继续保留冲突保护，合并需要人工决定。
- 当前只有创建、配置、连线和移动工具，没有删除节点/素材、任意 HTTP 请求或文件执行工具。
- MCP 端点无状态，不要求 MCP session ID；GET/DELETE 返回 405，长任务以业务 runId 管理。原 bearer 接入要求浏览器 Origin 匹配配置来源；本机免令牌与服务器连接地址均拒绝浏览器 Origin，供 MCP 客户端直接连接。
- 内置 Agent 可直接复用 `canvas-agent-tools.ts` 的 schema 和执行入口，再接现有模型池的工具调用循环。

## 验证与资料

自动测试使用合成账号、Memory Store、模拟生成器和随机本机端口。官方 MCP SDK Client 验证协议及工具链，浏览器验收使用拦截 API 的合成 fixture；不会用生产数据或调用付费生成模型。真实 Codex/Harness 会话需配置连接后进行现场验证。

- [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)
- [DeepSeek Harness MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [DeepSeek Harness Cordis 配置示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md)
