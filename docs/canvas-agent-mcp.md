# 外部 Agent 控制画布

第一阶段提供内外共用的画布操作服务和标准 MCP Streamable HTTP 接口。本地 Codex、DeepSeek Harness（DSH）等客户端可以直接连接，无需填写令牌。外部 Agent 负责规划；画布 API 负责权限、结构和版本校验；现有 Run/Worker 执行生成。不要求新增模型供应商。

画布也内置了「本地 Agent」聊天侧栏：在本机运行桥接程序（`canvas-bridge --local`）后，侧栏直连本机桥接并自动把当前项目的 MCP 地址注入给 Agent，不需要手工配置。本节面向希望用自己的 Codex、DSH 等客户端直接控制画布的场景，两者共用同一套 MCP 工具与连接凭据。本地 Agent 的启动与排查见 `docs/local-agent-bridge-status.md`。

## 连接

1. 启动画布 API/Web，或打开服务器部署的画布，登录并打开项目。此功能使用已有 `API_JWT_SECRET` 和会话存储；无需数据库迁移或新增部署密钥。匿名开发模式不能启用连接。
2. 点击工具栏的 **Agent**；手机端先打开画布菜单。入口会先保存当前编辑，冲突时先处理草稿。
3. 点击「启用连接」。面板直接使用服务器连接地址，不探测本机监听，也无需选择有效期。新连接默认拥有当前项目已提供的全部画布工具权限，可以创建节点、连线、调参、发起生成、查询和取消任务，无需勾选生成权限。历史受限连接保留原权限，停止后重新启用即可使用新默认。
4. 选择 Codex 或 DeepSeek Harness 并复制配置，无需另填令牌或环境变量。重新打开面板可选择已有连接并再次复制配置；关闭面板后连接继续可用。
5. 按下面的方法加载配置一次，然后让 Agent 调用 `get_canvas` 确认项目。连接长期有效，不再需要时点击「停止」。

服务器连接使用画布已配置的 API 地址，形如 `https://canvas.example/api/v1/projects/PROJECT_ID/mcp?connection=CONNECTION_ID.SIGNATURE`，可由本机 Codex、DSH 直接访问，不需要在本机启动画布 API。地址已包含当前项目的连接凭据，应妥善保管；无需另配 Authorization 头。API 只在该项目的 MCP 入口接受此凭据，拒绝浏览器来源，不会开放其他项目、账号管理或服务器命令执行权限。公网部署使用 HTTPS。项目自带的 Caddy 未启用请求访问日志，API 自身日志和遥测也不记录查询参数；如果自行添加代理访问日志，应隐藏 MCP 请求查询参数。

连接键由连接 ID 和 `API_JWT_SECRET` 派生签名，并对照持久会话存储校验，API 进程内不保存连接注册表。因此 API 重启、重新部署或多副本部署后原地址继续可用，Agent 配置无需更新；更换 `API_JWT_SECRET` 会使全部连接地址失效。连接在点击「停止」、账号禁用或撤销全部会话后立即失效。每个项目最多 20 个连接。

兼容旧客户端：创建接口仍接受显式 `expiresInHours`（1–24），此类限时连接受当前登录授权期限约束，面板显示到期时间。后端保留的本机回环连接接口（`local-agent-connections`）不再由面板使用，API 关闭时会释放其端口。

### Codex

将面板复制的 TOML 配置加入受信任项目的 `.codex/config.toml`，或在 Codex 的 MCP 设置中打开配置文件后加入。已有同名 `canvas` 配置时更新该项，不重复添加。重新加载 MCP 或重启客户端后即可使用；把配置粘贴到聊天框不会安装 MCP。项目不会自动修改本机或全局配置。

```toml
[mcp_servers.canvas]
url = "https://canvas.example/api/v1/projects/PROJECT_ID/mcp?connection=CONNECTION_ID.SIGNATURE"
```

以上仅为示例，直接使用面板给出的完整地址。连接后可以发：

> 读取 canvas MCP 的当前画布和可用模型，告诉我有哪些节点，先不要生成。

### DeepSeek Harness

将面板中的 Harness 配置加入 DSH 配置档的 `cordis.patch.yml`，例如 Windows 桌面版的 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，然后重启 DSH。配置档里已有 `id: canvas-mcp` 时只替换其中的 `url`，不要重复添加。地址长期有效，加入一次即可。它使用相同的 MCP 地址，不限于 Codex。

```yaml
- insert:
    - id: canvas-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: canvas
        transport: streamable-http
        url: https://canvas.example/api/v1/projects/PROJECT_ID/mcp?connection=CONNECTION_ID.SIGNATURE
```

临时使用时也可保存为 `canvas-mcp.cordis.yml`，再用 `--patch` 加载：

```sh
dsh web --patch ./canvas-mcp.cordis.yml
```

DSH 报 `server is disconnected` 时，通常是配置档中仍是已停止或旧版限时连接的地址；在面板重新启用连接并替换 `url` 即可。

其他支持 Streamable HTTP 的本地 MCP 客户端也可连接。同一接口不绑定 Codex、Harness 或具体模型。Agent 的规划使用其自身模型；调用 `run_node` 时使用画布中已配置的模型、参数和现有执行链。第一阶段从外部 Agent 发指令，画布显示过程；将外部 Agent 的聊天嵌入网页需要后续 SDK/运行器集成。

原有受令牌保护的 `/v1/projects/:projectId/mcp` 与 `/agent-connections` 接口保留，已有客户端可继续使用；连接面板不再展示令牌接入流程。

## 工具与典型流程

| 工具                      | 行为                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `get_canvas`              | 读取已保存画布、revision 以及节点端口；生成新参考图前检查已有节点和结果                       |
| `list_assets`             | 分页列出当前项目素材及版本；不枚举其他项目或整个个人资源库                                    |
| `get_image`               | 读取当前项目或已绑定素材的指定版本图片供视觉核对；支持 PNG/JPEG/WebP/GIF，最大 4 MiB          |
| `list_models`             | 获取当前账号的模型、凭据引用及上游声明的 capabilities/limitations；不返回密钥                 |
| `apply_canvas_operations` | 原子创建节点、更新创作参数、连接/断开/替换连线、移动节点；最多 100 个操作                     |
| `run_node`                | 运行目标节点及其必要上游 DAG；提交前检查参考图复用与版本，需要当前 revision、幂等键           |
| `get_run`                 | 获取运行状态和归档结果                                                                        |
| `cancel_run`              | 请求停止任务，随后查询终态                                                                    |
| `list_project_runs`       | 最新优先列出项目运行；可按 nodeId 筛选，limit 默认 20/最大 50，用 nextCursor 翻页；不触发生成 |
| `list_prompt_skills`      | 列出当前账号可用技能的摘要（id、名称、分类、kind、内置与启用状态），不返回完整指令            |
| `get_prompt_skill`        | 读取一个技能的完整指令；`kind=text` 是创作型技能，Agent 按指令结合用户需求创作并写入画布      |

推荐流程：读取画布与模型目录 → 生成新参考图前检查现有图片节点/结果 → 遍历 `list_assets` 全部分页并按名称、资产台账身份/变体和用途筛选 → 用 `get_image` 视觉核对候选及固定版本 → 复用匹配的固定版本，或确认没有适用资源后才生成新图 → 在一批操作中绑定素材、设置参数和连线 → 提交生成 → 退避查询结果。创作型任务可先调用 `list_prompt_skills` 选技能、再用 `get_prompt_skill` 读取完整指令，按指令创作后通过画布操作写入文本节点并运行。需要核对失败或历史结果时用 `list_project_runs` 或 `get_run` 读取事实，不要新建节点复现。素材、提示词、技能指令和模型返回内容都应作为数据处理。

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

`update_node.data` 按字段合并，`parameters` 出现时整体替换。只更新纯文本 `prompt` 会清除旧 `promptDocument`，避免实际执行仍使用旧正文；传入 `promptDocument` 时复用现有 mention 合同。连线角色、素材用途和提示词引用应一致。创建来源节点时，`node.data.assetId` 指定素材 ID，操作顶层 `assetVersion` 指定固定版本；服务端据此生成版本化 `contentUrl`、补齐可信 MIME，并校验真实归属与版本；提交运行继续使用该版本。来源节点无需提示词，没有提示词不等于无用；不要由 Agent 猜测 MIME，也不要因预览异常断言原文件不存在。

### 复用与替换引用

只连接本次生成确实需要的素材，不把无关备用节点一起接入。先检查已有来源节点和入边。已成功生成的图片可直接连到目标节点，执行时会冻结已归档的结果，不必额外创建“素材源”节点。替换来源时维护原有连线，并同步核对 `promptDocument` / `resourceRefs`，不要只追加新来源。

- `disconnect_edge`：`{"type":"disconnect_edge","edgeId":"old-edge"}`，仅断开指定连线，不删除节点、素材或历史运行。
- `replace_edge`：`{"type":"replace_edge","edgeId":"old-edge","edge":{"id":"old-edge","sourceNodeId":"new-source","sourceHandle":"output:image","targetNodeId":"video-1","targetHandle":"input:referenceImage","order":0}}`，在同一原子批次中替换指定连线；旧边不存在时失败。
- `connect_nodes` 对相同来源/目标节点、端口及顺序重复添加时幂等；不同用途或顺序不会被误合并。相同边 ID 被其它连线占用仍会报错。
- 批次仍须使用最新 revision，任何操作无效则整批不保存。替换时同步核对 `promptDocument` / `resourceRefs` 的素材、固定版本、用途和顺序。
- `enabled:false` 的来源不参与连线输入。有效媒体按 `assetId + 固定 assetVersion + role` 去重；不同版本、不同用途保留，未知版本不猜测合并。连线总数不等于实际发送素材数。
- 参考素材数量及是否接受由上游决定，画布不按模型目录中的数量上限拦截；Agent 不得为了凑上限擅自删减引用。目录中的 `maxImages`、`maxVideos`、`maxAudios` 或 `maxTotal` 等数量声明不能作为画布数量硬拦截或擅自删减的依据。
- 提交前继续校验固定版本和文件可读性，并保留去重和实际发送素材清单；发现坏引用时修复指定来源，不静默丢弃引用继续生成。上游拒绝时如实报告返回错误，不能凭引用数量推断失败原因。

绑定素材时，「提示词引用」和「画布连线」必须双写，不能只写一边：

- 在 `promptDocument` 中用 mention（或 `resourceRefs`）引用素材时，必须同时用 `connect_nodes` 把持有该素材的来源节点连到目标节点的对应输入口：图片参考 `input:referenceImage`、人物 `input:character`、风格 `input:style`、首帧 `input:firstFrame`、尾帧 `input:lastFrame`、文本 `input:prompt`。
- 连线角色、素材用途（mention 的 `semanticRole` / `binding`）与提示词引用必须表达同一用途；`edge.order` 按期望的参考顺序设置。
- 只写 mention 不连线时生成仍可能成功，但画布上不会显示素材关系，后续人工调整和 Agent 接手都会误判节点之间的输入关系。
- 运行时会按 `assetId + assetVersion + role` 去重，同一素材通过 mention 和连线重复绑定不会重复发送素材。

`create_node` 省略 `width` / `height` 时，服务端按 `data.parameters.aspectRatio` 推导画布卡片尺寸（如 9:16 → 236×420、16:9 → 520×293）；未声明可用比例时才回退图片/视频 400×266、文字/音频 320×200。显示尺寸写在 `node.width` / `node.height`，不要放进 `data`；不要再显式传 230×216 之类的正方形默认值。

`run_node` 返回任务而不阻塞等待视频完成。同一次提交重试复用同一 `idempotencyKey`；修改配置后发起新生成需用新键。第一版没有跨多个独立提交的预算计费上限，连接在停止前可继续提交生成，仍受现有队列和账号额度约束。

排查指定节点时调用 `list_project_runs({"nodeId":"video-1","limit":20})`。结果按创建时间、ID 降序排列；`hasMore:true` 时将 `nextCursor` 作为下一次的 `cursor`，并保持相同 `nodeId`。游标绑定项目和筛选范围，不能跨项目或改筛选后复用。HTTP 项目运行列表不带参数时仍保留旧全量响应，MCP 始终使用分页。

生成提示词弹窗会优先读取当前产物版本的请求记录；失败且无产物时读取该节点最新运行的记录。请求素材清单来自最终请求体，显示媒体数量、用途、固定版本和发送状态，不保存临时 URL、签名或媒体字节。无法对应到授权输入的额外媒体保留类型和用途，不编造素材身份。`pending` / `unknown` 不能视为已确认发送；历史缺记录时明确显示“请求记录缺失”，不能拿当前提示词或连线数补造历史请求。

`get_run.snapshot.inputCount` 仅代表冻结的连线输入数；公开接口中的 `inputs:[null,...]` 是主动脱敏，不代表空素材或损坏文件。额外提示词引用、去重和最终请求体合并都可能改变发送数量，最终数量以请求记录为准。

## 行为边界

画布是用户的创作资产，不是验证或测试环境：

- 不要为验证工具链、渠道、参数或 Agent 自身行为而创建节点、运行生成，也不要创建「探针」「测试」「诊断」用途的节点。
- `create_node`、`update_node`、`run_node` 只在用户明确提出的创作任务需要时使用；修改已有节点优先 `update_node`，不要重复建节点。
- 失败排查用 `get_run`、`list_project_runs` 或 `get_canvas` 读取事实并如实汇报，不得靠新建节点复现失败。
- 连接令牌没有删除节点/素材的能力；不要为「清理」或「验证」创建额外节点。

## 默认画风（服务器端提示词）

MCP 服务器初始化指令与 `apply_canvas_operations` 工具说明中固定以下创作默认，Agent 写入人物、场景、角色图或视频提示词时必须遵守：

- 用户未指定画风、且项目没有已定画风时，默认采用**适度风格化的 3D CG / 2.5D CG 渲染**：人物造型比例协调、面部特征清晰；PBR 物理材质、SSS 次表面散射皮肤、高精度发丝与织物物理解算、体积光与全局光照、电影级色彩分级。
- **禁止**默认退回手绘平涂、二维插画感、低模卡通、廉价游戏建模或过度磨皮蜡像感。
- 用户明确指定画风、项目已有已定画风、或用户要求待定/比较候选时，优先服从用户/项目；默认只在未指定时兜底，并注明「来源：体系默认」。
- 画幅、时长、模型档位仍按用户要求或模型能力处理；该默认只约束画风，不改变这些规则，也不追溯改写历史节点。

所有视频引擎及画布 MCP 使用同一提示词拦截：图片、视频的创作提示词不得含照片化人物目标词，包括中文、明确英文同义写法及否定句。命中时拒绝本次写入或运行，提示改写为正向 3D CG / 2.5D CG 描述；错误不回显触发的原句。拦截覆盖有效 `prompt`、`promptDocument`、已附加资源名称及 `parameters` 中的文本；图片节点没有显式提示词时还检查可能成为回退提示词的标题。纯布局编辑和旧节点读取不受影响。此检查不核验模型参数档位，也不设置素材数量门槛。

视频节点可以先保存静态文本草稿；运行前必须有固定版本图片 mention / 已附加图片，或连接启用的图片来源/生成节点。缺少人物或场景参考图时，先用图片节点生成，成功后将其连接到视频节点，并在结构化提示词中引用相同素材；已有角色和场景跨 EP 复用参考图，仅新增角色、场景或明确变体时另建。纯文字视频运行会被 MCP 拒绝。固定版本、归属和文件可读性仍由现有业务路径检查。

## 人物参考图规范（服务器端提示词）

MCP 服务器初始化指令与 `apply_canvas_operations` 工具说明中固定以下人物参考图默认，Agent 生成人物定妆图、人物参考图或角色设定图时必须遵守：

- 默认采用**左侧全高唯一大正脸 + 右侧肩线以下穿着三视图**版式：左侧 40% 放平视正脸并纵向铺满全高；右侧 60% 全高均分正面、90°侧面、背面三栏，不另设材质球或服饰样本带。每栏上边界横切肩线/衣料肩线，画面从肩线以下开始，头脸、颈部与发型留在画框之外；放大展示肩线以下身体服装至鞋底，三栏比例自然一致、鞋底对齐。
- 三栏人物保持自然成人体态比例：肩髋协调，肘部约腰线，手掌至大腿中段，双腿自然长于上身；手脚、四肢与鞋履尺度合理，不拉伸、不出现等长肢体。服装用自然正向语言描述款式、剪裁、层次、面料、配色和装饰；颜色清晰有层次，可按设计加入适度刺绣、花饰、珠饰、滚边或飘带。提示词必须明确分区、肩线取景与人体比例，不能只写“整体上移”或套用含头全身三视图。需要展示服装工艺时另做独立细节参考图。
- 背景**硬性统一为纯白纯色（#FFFFFF）**：平涂纯白、无渐变、无纹理、无明暗过渡；不得出现任何场景、云海、建筑、天空、光斑、渐变花纹、装饰性背景、其他人物、文字或水印；不得用浅灰、米白或灰色渐变代替，用户当次明确指定其他单色时除外。
- 只有用户明确要求单幅剧情插画时才输出带场景单图；默认不为人物参考图生成花哨背景或环境氛围。
- 用户当次明确指定其他版式时按其要求；该规范只约束人物参考图的版式与背景，不改变视频画幅或模型参数。

## 视频提示词统一格式与素材编号（服务器端提示词）

MCP 服务器初始化指令与 `apply_canvas_operations` 工具说明复用同一份画布结构化引用合同。画布保存的是素材身份和引用位置，不保存某个引擎的最终编号：

- 【固定资产】新写入默认只保存「图片 mention＋一个空格＋姓名」：先放图片 mention 块，再接以一个空格开头的姓名 text 块。mention 必须 `inline:true`，不设 `executionOnly`；姓名已由相邻 text 块写出时不再设置 `entityName`。兼容既有「姓名＋一个空格＋图片 mention」相邻结构，更新时可原位保留，不为调换顺序重复插入姓名；名字与 mention 之间不写字面 `@`，正文也不手写 `图 1`、`Image 1`、`<Picture 1>` 或 `<Subject 1>`。
- 素材身份、固定版本、用途与 `connect_nodes` 连线双写，mention 顺序与连线/挂载顺序一致。旧写法的 `executionOnly` mention 会渲染为空串；重复写 `entityName` 会把姓名再附加到编号后，这两种写法都不用于新编辑。
- 镜头正文里人物、场景首次出现处也按同样结构挂图片 mention；同一镜内同一素材只挂一次，跨镜可各自再挂。台词行、`声音：<…>`、`环境：…`、`【镜头】`、`【时间】`、`【防穿帮约束】` 各行列不挂 mention，`（）`、`“”`、`【】` 内部不挂。
- 有人物或场景参考图时，参考图已经承载脸型、发型、服饰等静态外观，【固定资产】和镜头正文不再复述这些外观。镜头正文仍须写清本镜动作、可见表情、持物、起始状态和末态，不能因为有参考图而删掉动态表演信息。

预览与提交按**实际渠道冻结契约**和真实发送顺序渲染编号，模型名称只是无渠道合同场景下的回退线索，不能单独保证编号语法。当前带 `videoReferences` 契约的 `minimax-h3-1` 使用通用 `Image N`，不能仅因名称含 H3 就保证 `<Picture N>`；渠道不支持内联编号时，以「查看真实提示词」中的真实降级结果为准。

Seedance 的 `图 N`、Wan 的 `图N` 与 H3 的 `<Picture N>` 属于**预览、提交或外部裸文本的输出语法**，画布编辑态不手写；显式 `<Subject N>` 定义属于外部裸文本协议。当前画布不会自动把图片或人物外观转换成 `<Subject N>` 定义，也不会自动生成 Subject 的保留强度或创作意图。不要在画布内容或能力说明中宣称、模拟或依赖这种自动转换。

批量写入或修订后必须逐节点打开「查看真实提示词」，分别核对姓名、实际编号、固定版本和引用顺序。历史 `executionOnly` / 重复 `entityName` 写法与缺失素材逐节点单列，不能只抽查一个样例后宣称整批通过，也不能用当前正常节点替代历史缺失证据。

通用稿及 Seedance、Wan3、H3 的默认画布稿和普通文本稿统一按三个顶层区块排列：`【固定资产】→【视频生成风格类型】→【分镜】`。【固定资产】首先逐项列出本段实际图片及人物、场景、关键道具用途，画布使用真实图片 mention，裸文本只写已核实的渠道编号；【视频生成风格类型】接着写已定 3D CG / 2.5D CG 画风、画幅、节奏、影调及“人物按照参考图生成”等正向要求；【分镜】再写连续时间轴、动作、原对白、声音和相接的首末态。全段声音要求放在风格类型内，局部声音放在对应分镜；不另加顶层剧情概述、段末补充或负向风格清单。H3 六字段仅在用户明确要求原生协议导出时使用，不是默认提示词格式。外部裸文本的引擎资料可参考 `docs/video-prompt-references.md` 与 `docs/video-prompt-skill-templates.md`，其中历史示例不能覆盖当前三段式、实际渠道冻结契约、真实发送顺序或上述画布结构化合同。

### 视频运行前逐段素材覆盖核对

人物参考图提示词中的版式固定为左侧 40% 大正脸、右侧 60% 肩线以下正/侧/背三视图；默认不设置右下材质球或细节带，服装结构需突出时另做独立细节图。角色身份、发型、年代、衣装材质/剪裁、配件按当前角色替换；左侧大正脸纵向铺满全高，右侧三视图从肩线以下取景并展示至鞋底；人体比例自然。

人物参考图提示词应直接复用上面的严格分区协议，不能退化成只写“人物整体上移”。角色身份、发型、年代、衣装材质/剪裁和配件按当前角色替换；保持左侧 40% 唯一正脸全高铺满、右侧 60% 全高三栏从肩线以下开始并展示至鞋底、自然人体比例，不强制加入材质球或细节样本。服装以自然正向语言描述，具体色彩和装饰按角色设计确定；需要服饰工艺特写时另做独立细节参考图。

发起每个视频节点前，Agent 都要按该段分镜逐项核对【固定资产】清单与实际图片输入：列出本段出现的人物、场景和剧情关键道具，并为每一项确认对应的图片素材、用途、固定版本及指向该视频节点的 mention / 连线。核对结果应能说明清单项目与实际图片的对应关系；不能因为提示词里写了名称或画布上存在素材节点就视为已绑定。

- 优先从项目资产台账复用已登记、已验收的角色定妆图和场景母版，继续使用其固定 `assetId` / `assetVersion`；同一角色或场景跨 EP 沿用同一来源，不按集重复生成。剧情确需新角色、新场景或明确变体时，才新增参考并登记与原资产的关系。
- 若清单中的人物、场景或关键道具缺少可复用参考图，先通过图片节点生成并验收所需参考图，登记资产及固定版本，再将真实图片引用和对应连线接入视频节点；缺图时不得运行纯文字视频。
- 逐项清单核对属于 Agent 的内容覆盖责任。现有 MCP 运行时只检查视频节点至少存在一个有效图片引用或上游图片节点，并由现有业务路径校验固定版本与文件可读性；它不会自动识别每个角色、场景或道具是否都已覆盖，也不会判断图片与提示词中的对象是否语义匹配。因此，“至少有一张图”不能推断整段素材齐全或对应正确，Agent 必须完成上述逐段核对后才可提交运行。

### 新参考图生成前检查项目素材库

生成任何新参考图片前，先调用 `get_canvas` 检查现有图片节点及其已绑定或已归档的生成结果，再用 `list_assets` 遍历当前项目的全部分页；当 `hasMore` 为 true 时继续翻页，直到确认已读完。删除画布节点或连线只改变画布结构，不代表项目素材库中的资产被删除；因此不能因角色图节点消失就直接重生成。

- 按名称、项目资产台账中的身份/变体和用途筛选素材候选，再用 `get_image` 读取候选的指定版本进行视觉核对，并确认固定版本可用。
- 候选匹配后继续复用完全相同的 `assetId@assetVersion`。已有绑定该版本的 source 节点时优先复用；没有节点时，通过 `create_node` 创建 source 节点：`node.data.assetId` 填候选素材 ID，操作顶层 `assetVersion` 填 `get_image` 已核实的版本。服务端据此生成对应固定版本 `contentUrl`；Agent 不直接写 `contentUrl`，也不可悄悄切换到最新版本。
- 只有确认所有项目素材分页中都没有适用候选后，才生成新参考图片。候选身份、用途或版本不明确时暂停并报告，由用户或项目台账澄清后再继续。
- 以上是 Agent 对名称、台账和图片内容的人工核对要求。MCP 提供分页资产列表和指定版本图片读取，但不自动完成图像语义匹配；节点/连线存在与否也不能作为资源库中素材是否存在的依据。

## 人机协作与兼容性

- 新增 `/v1/projects/:projectId/agent-url-connections` 的 GET/POST，以及 `/:connectionId` 的 DELETE，用于服务器连接管理，也是面板唯一使用的连接接口；返回含 `CONNECTION_ID.SIGNATURE` 连接键的相对 `mcpPath`，前端按已配置的 API 地址生成完整 URL。省略 `expiresInHours` 时连接长期有效，`expiresAt` 返回 `null`；连接键可在 API 重启后由持久会话重新校验。
- 保留 `/v1/projects/:projectId/local-agent-connections` 的 GET/POST，以及 `/:connectionId` 的 DELETE，仅为兼容旧客户端；返回连接元数据和回环 MCP 地址，不返回凭据。本地监听器代理到已有项目 MCP，继续执行账户、项目、生成权限和版本校验。两类创建接口省略 `allowGeneration` 时默认允许生成；兼容旧接口显式 `false` 和历史受限连接。
- 新增 `POST /v1/projects/:projectId/canvas/operations`，现有全画布 PATCH 保留。操作以 revision 做存储层 CAS，旧版本或任一非法操作均不部分落盘。
- 现有节点运行请求新增可选 `canvasRevision`，旧客户端可以不传；MCP 提交必须传且匹配，否则 409。项目令牌仅可提交 `projectId`、`canvasRevision`、`idempotencyKey`，不可借运行请求覆盖提示词或素材；配置变更必须先通过画布操作校验并保存。
- SSE 新增 `canvas.updated`，仅广播项目 ID 和 revision。前端收到后拉取文档，并以 15 秒轮询/窗口恢复焦点兜底；`run.updated` 携带与 REST 相同的公开运行记录（含摘要快照）。这样 Agent/MCP 触发、浏览器未提交过的运行也能实时回显进度与结果，只有画布内容才需要等 `canvas.updated` 拉取。
- 无本地编辑时自动更新画布；存在草稿、保存请求或内容编辑时暂停自动保存并提示冲突。用户可下载草稿，或先保留独立本地备份再加载远端；恢复副本继续保留冲突保护，合并需要人工决定。
- 当前只有创建、配置、连线和移动工具，没有删除节点/素材、任意 HTTP 请求或文件执行工具；技能目录是只读资源，连接令牌只能列出与读取技能，不能创建、修改或删除技能。Agent 不得把画布当测试环境：禁止为验证创建节点或运行生成，核对失败使用只读运行历史（`list_project_runs` / `get_run`）。
- MCP 端点无状态，不要求 MCP session ID；GET/DELETE 返回 405，长任务以业务 runId 管理。原 bearer 接入要求浏览器 Origin 匹配配置来源；本机免令牌与服务器连接地址均拒绝浏览器 Origin，供 MCP 客户端直接连接。
- 内置 Agent 可直接复用 `canvas-agent-tools.ts` 的 schema 和执行入口，再接现有模型池的工具调用循环。

## 验证与资料

自动测试使用合成账号、Memory Store、模拟生成器和随机本机端口。官方 MCP SDK Client 验证协议及工具链，浏览器验收使用拦截 API 的合成 fixture；不会用生产数据或调用付费生成模型。真实 Codex/Harness 会话的联调应在独立测试项目上进行，不得在用户项目里为验证创建探针节点或运行生成。

- [Codex MCP 官方文档](https://developers.openai.com/codex/mcp/)
- [DeepSeek Harness MCP Client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
- [DeepSeek Harness Cordis 配置示例](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md)
