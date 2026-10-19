# 外部 Agent 控制画布

第一阶段提供内外共用的画布操作服务和标准 MCP Streamable HTTP 接口。外部 Agent 负责规划；画布 API 负责权限、结构和版本校验；现有 Run/Worker 执行生成。当前没有内置聊天 Agent，也不要求新增模型供应商。

## 连接

1. 启动现有 API/Web，登录并打开项目。此功能使用已有 `API_JWT_SECRET` 和持久会话存储；无需数据库迁移或新增部署密钥。匿名开发模式不签发连接令牌。
2. 点击工具栏的 **Agent**；手机端先打开画布菜单。入口会先保存当前编辑，冲突时先处理草稿。
3. 选择 1–24 小时有效期（默认 8 小时）。需要生成时勾选「允许发起生成」；未勾选仍可读取和编辑当前项目、取消该项目的任务。
4. 创建连接，复制 MCP 地址和令牌。令牌仅本次显示，关闭面板后不能再次读取；可撤销旧连接并重新创建。
5. 在外部 Agent 的启动环境中设置 `CANVAS_AGENT_TOKEN`，然后使用面板生成的配置。不要将令牌提交到仓库、写进聊天或配置模板。

令牌绑定当前用户、单个项目和生成权限，有效期还受当前账号授权期限限制。服务端仅保存用途隔离的令牌哈希；撤销、到期、账号禁用或撤销全部会话后失效。MCP 令牌不能登录、修改账号/凭据或签发其他连接。浏览器登录刷新不会轮换 MCP 连接。

### Codex

下面仅为配置形状，实际地址使用面板提供的值。配置可放在受信任项目的 `.codex/config.toml`；项目不会自动修改本机或全局配置。

```toml
[mcp_servers.canvas]
url = "https://api.example.test/v1/projects/PROJECT_ID/mcp"
bearer_token_env_var = "CANVAS_AGENT_TOKEN"
```

### DeepSeek Harness

将下列内容保存为单独 Cordis patch，再用 Harness 的 `--patch` 加载；无需替换已有配置。

```yaml
- insert:
    - id: canvas-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: canvas
        transport: streamable-http
        url: https://api.example.test/v1/projects/PROJECT_ID/mcp
        headers:
          Authorization: !!js '`Bearer ${process.env.CANVAS_AGENT_TOKEN}`'
```

```sh
dsh web --patch ./canvas-mcp.cordis.yml
```

其他支持 Streamable HTTP 与 Bearer 认证的 MCP 客户端也可连接。同一接口不绑定 Codex、Harness 或具体模型。第一阶段从外部 Agent 发指令，画布显示过程；将外部 Agent 的聊天嵌入网页需要后续 SDK/运行器集成。

## 工具与典型流程

| 工具                      | 行为                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `get_canvas`              | 读取已保存画布、revision 以及节点端口                                                           |
| `list_assets`             | 分页列出项目素材及版本；不枚举其他项目或整个个人资源库                                          |
| `get_image`               | 读取项目或已绑定个人素材的一版图片，返回原生 MCP image 内容；支持 PNG/JPEG/WebP/GIF，最大 4 MiB |
| `list_models`             | 获取当前账号的模型、凭据引用及上游声明的 capabilities/limitations；不返回密钥                   |
| `apply_canvas_operations` | 原子创建节点、更新创作参数、连线、移动节点；最多 100 个操作                                     |
| `run_node`                | 运行目标节点及其必要上游 DAG；需要生成授权、当前 revision、幂等键                               |
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

`run_node` 返回任务而不阻塞等待视频完成。同一次提交重试复用同一 `idempotencyKey`；修改配置后发起新生成需用新键。第一版没有跨多个独立提交的预算计费上限，生成权限会允许连接有效期内继续提交，仍受现有队列和账号额度约束。

## 人机协作与兼容性

- 新增 `POST /v1/projects/:projectId/canvas/operations`，现有全画布 PATCH 保留。操作以 revision 做存储层 CAS，旧版本或任一非法操作均不部分落盘。
- 现有节点运行请求新增可选 `canvasRevision`，旧客户端可以不传；MCP 提交必须传且匹配，否则 409。项目令牌仅可提交 `projectId`、`canvasRevision`、`idempotencyKey`，不可借运行请求覆盖提示词或素材；配置变更必须先通过画布操作校验并保存。
- SSE 新增 `canvas.updated`，仅广播项目 ID 和 revision。前端收到后拉取文档，并以 15 秒轮询/窗口恢复焦点兜底；`run.updated` 保持兼容。
- 无本地编辑时自动更新画布；存在草稿、保存请求或内容编辑时暂停自动保存并提示冲突。用户可下载草稿，或先保留独立本地备份再加载远端；恢复副本继续保留冲突保护，合并需要人工决定。
- 当前只有创建、配置、连线和移动工具，没有删除节点/素材、任意 HTTP 请求或文件执行工具。
- MCP 端点无状态，不要求 MCP session ID；GET/DELETE 返回 405，长任务以业务 runId 管理。浏览器 Origin 必须匹配配置来源，授权 CLI 可不带 Origin。
- 内置 Agent 可直接复用 `canvas-agent-tools.ts` 的 schema 和执行入口，再接现有模型池的工具调用循环。

## 验证与资料

自动测试使用合成账号、Memory Store、模拟生成器和随机本机端口。官方 MCP SDK Client 验证协议及工具链，浏览器验收使用拦截 API 的合成 fixture；不会用生产数据或调用付费生成模型。真实 Codex/Harness 会话需配置连接后进行现场验证。

- [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)
- [DeepSeek Harness MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [DeepSeek Harness Cordis 配置示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md)
