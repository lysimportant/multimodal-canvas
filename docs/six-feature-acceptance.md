# 六项需求验收记录

更新时间：2026-09-17。验收对象：[next.md](../next.md) 第 3～8 节。

**最新代码缺口已补齐，本地验收通过；真实供应商整体验收仍未通过。** 最新交付与证据见第 7 节。第 1～6 节保留上一轮 `56739d1` 的审计记录，里面的“未实现”不代表当前代码状态。没有操作生产数据。

## 1. 环境与范围

| 项目       | 结果                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| 工作目录   | `G:\multimodal-canvas`，Git worktree                                                                            |
| 分支与起点 | `codex/generate-to-new-node @ d02930e50c1d5aeeeec8abfcceee235cd5ba7b41`                                         |
| 起始工作区 | 干净                                                                                                            |
| 上游       | `origin/codex/generate-to-new-node`，GitHub `lysimportant/multimodal-canvas`                                    |
| 环境       | Windows PowerShell 7.6.5、Node v24.12.0、pnpm 11.19.0、Docker 29.7.2                                            |
| 依赖       | 使用现有项目依赖，未安装或升级                                                                                  |
| 任务级别   | P1 验收；修复涉及 API 兼容和 Worker 恢复，按大改动交付                                                          |
| 隔离设施   | Compose 项目 `mc-acceptance-test-next-20260917`；PostgreSQL 19432、Redis 19379、MinIO 19900/19901，均为回环端口 |

保留已有开发容器、生产服务和数据库。复杂手机适配、性能优化、供应商新合同及付费生成不在本轮范围。现有窄屏设置回归中的遮挡仅作局部修复。

## 2. 六项结论

| 需求       | 已取得证据                                                                                                       | 未满足或未证明的条件                                                                                                                   | 结论     |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 真实提示词 | Provider 发送前记录及失败阻断；Worker 原请求身份恢复、归档后补绑定；长文本、双复制、Esc 回焦、明暗主题           | 缺少整体摘要创建/编辑；前端按最新 run 读取，未按当前资产版本定位；历史版本、手动覆盖、删除节点后资产入口不完整；内存运行模式无记录写入 | 不通过   |
| 节点耗时   | 服务端节点时间持久化、单调合并；共享时钟；终态 12.4 s 展示及刷新恢复                                             | 运行中使用浏览器时钟，未接服务端偏移；旧结果版本与新任务时间的全部组合、离线重连未取得完整浏览器证据                                   | 部分通过 |
| 设置       | 宽版分类、四类默认表单、项目配置保存；独立 Key 不激活全局；三种 PC 视口和明暗主题                                | 新建节点仍优先选上一个同类节点/浏览器偏好/目录首项，没有接入项目及全局类型默认值                                                       | 不通过   |
| 连线       | 五种路径、六种特效共 30 种组合单测；浏览器独立切换及刷新；多图和混合参考连线可见                                 | 缺少固定节点/连线规模下的改动前后性能比较，不能关闭第 6 节全部验收                                                                     | 部分通过 |
| 分组       | 连续移动、外框缩放、一次撤销、保存刷新、整组复制重建 ID；Memory/File/Prisma 往返和旧客户端保护；组不进入运行 DAG | 组内分叉的新节点未继承/扩展来源组；25%/100%/200% 下全部分组组合未逐项验收                                                              | 部分通过 |
| 清空       | hover 菜单、候选数、取消；保留已填提示词、资产、有效输入和运行节点的规则；空模板删除与一次撤销                   | 全量清空确认缺少在途任务数量及继续执行提示；确认期间状态变化和迟到事件组合覆盖不完整                                                   | 部分通过 |

代码依据：`apps/web/src/App.tsx` 的 `openRequestPrompt`、`createOperationNode`、`commitForkGraph`、`clearCanvas`、`clearEmptyNodes`；`NodeDurationBadge.tsx` 的 `useSharedNodeClock`；`RequestPromptDialog.tsx` 仅显示已有 `record.summary`。不能把测试夹具预置的摘要当成摘要生成能力。

另外未完成：设置独立 Key → 生成 → 摘要/全文/耗时 → 分组 → 清空 → 撤销 → 刷新的单条联合流程。当前各专项通过不能证明这条完整链路已通过。`negativeText` 只有未发送时不记录的证据；参考资源版本仅在冻结快照携带时记录。

## 3. 本轮修复

1. Worker 在发送前持久化请求身份，在结果绑定前保存已归档结果。绑定写入失败后恢复原请求记录，不再次调用 Provider 或归档；异步任务续查保留原身份，校验 run、node、attempt，防止 Provider 元数据覆盖身份。
2. Memory/File/Prisma 保存已有组的画布时，省略 `groups` 返回 `409 incompatible_canvas`，避免旧客户端静默丢组。显式 `groups: []` 仍表示解除全部分组；旧工作流导入显式传空数组，OpenAPI 同步说明。
3. 整组复制传入真实组数据，粘贴重建成员与组 ID；组移动改为逐次位移，并同步 refs，避免连续事件反复累加总位移。
4. 生成提示词复用共享 Radix Dialog，修复嵌套弹层不可点击、层级和关闭回焦；保留节点信息面板作为焦点返回位置。修复深色正文和设置文本可读性。
5. 清空菜单恢复指针交互与展开层级；分组、React Flow 空白层和节点共用层叠上下文，分组标题不再挡住节点工具栏。
6. 节点不再根据图片/视频自然尺寸重写外框，生成结果与刷新均沿用画布保存的尺寸；显式拖动缩放继续有效。视频模式/模型变化后调用 React Flow 端口重新测量，补齐已有连线显示。
7. 窄窗口设置改为导航、滚动正文、底部三个网格行，避免导航被正文遮挡。更新过期浏览器选择器、当前默认参数和动画断言，保留真实操作及尺寸/保存/连线检查。
8. HTTPS 子进程夹具显式清空 JWT 配置，防止 Prisma 自动读取根 `.env` 污染隔离认证测试。Prisma 专项接受明确确认隔离的 `TEST_DATABASE_URL`，未配置时不构造无效 datasource。

## 4. 验证结果

### 4.1 最终门禁

```powershell
pnpm lint
pnpm typecheck
$env:WEB_PORT = '5173'
pnpm test
pnpm build
$env:WEB_PORT = '5183'
pnpm --filter @multimodal-canvas/web test:e2e --output=../../test-results/next-e2e-verified --reporter=line
```

| 检查         | 最终结果                                                 |
| ------------ | -------------------------------------------------------- |
| lint         | 8 个任务通过                                             |
| typecheck    | 13 个任务通过                                            |
| test         | 13 个任务通过；运行时测试 8 项通过                       |
| build        | 8 个任务通过；Vite 仍提示单块大于 500 kB，未进行拆包优化 |
| 浏览器全量   | 79 通过、2 跳过、0 失败，约 2.3 分钟                     |
| 新增六项专项 | 11 项通过，包含在全量中                                  |

普通测试包结果：Domain 65、Providers 310、Worker 236 通过/3 跳过、API 665 通过/58 跳过、Web 826、UI 3、Observability 21、Credential Crypto 7。普通测试的跳过项目不计入对应真实集成验收。

浏览器跳过的是 `image-edit-capability.spec.ts` 和 `image-edit-live.spec.ts`，需要真实账户配置，后者还需明确费用授权。本轮未提供这些配置，不把跳过算通过。

最终日志位于忽略目录 `test-results/next-verified-{lint,typecheck,tests,build}.log`、`test-results/next-e2e-verified.log`。中途失败日志保留用于追溯；最终结论只引用修复后的结果。

### 4.2 隔离基础设施

```powershell
pwsh -NoProfile -File scripts/verify-isolated.ps1 -Action Start -Project mc-acceptance-test-next-20260917
pwsh -NoProfile -File scripts/verify-isolated.ps1 -Action Test -Project mc-acceptance-test-next-20260917
```

18 个迁移应用完成，无 schema 漂移；API 集成 38 项、跨进程 Redis 9 项、隔离 HTTPS 22 项通过，均零跳过。证据：`test-results/next-final-integration.log`。覆盖数据库/队列接管、冻结输入、对象存储归档和分组存储恢复，不等同于生产部署或真实供应商验收。

另以 `TEST_DATABASE_CONFIRMED_ISOLATED=true`、本轮隔离 PostgreSQL 的 `TEST_DATABASE_URL`、空 `DATABASE_URL` 及 `WORKER_PROVIDER=mock` 执行：

```powershell
pnpm --filter @multimodal-canvas/worker exec vitest run --reporter=dot
pnpm --filter @multimodal-canvas/api exec vitest run src/run-persistence.test.ts src/projects.test.ts src/run-canvas-groups.test.ts src/canvas-group-import.test.ts src/app.test.ts src/workflow-import.test.ts --reporter=dot
```

分别为 Worker 14 文件/239 项、API 6 文件/104 项通过，零跳过。上述数字与普通测试重叠，不相加当作唯一用例总数。

### 4.3 浏览器与视觉

三个 PC 视口为 1366×768、1440×900、1920×1080，均覆盖明亮与深色；画布、设置和长提示词共 18 张截图。专项断言包含正文对比度至少 4.5:1、Dialog 视口约束、复制、焦点返回及控制台/pageerror 无错误。已检查截图，并对最终回归的深色设置、长提示词和宽屏画布复核。

截图目录：`test-results/next-e2e-verified/next-acceptance-视觉：*/`。这些截图证明所列状态，不能扩大为所有缩放比例、节点组合或移动端完整验收。首页性能测试通过也不能替代画布性能比较。

## 5. 兼容与回滚

本轮没有新增数据库迁移、依赖或凭据配置。新恢复元数据是可选请求身份列表，不含提示词全文或 Key；只有本次新增检查点保存过的身份可以恢复，历史缺失数据无法补造。

API 行为变化：有组的画布禁止省略 `groups` 保存，客户端须完整读回并提交；无组旧画布继续兼容。降级后端会失去防丢组保护，不能让不识别组的旧客户端重新保存现有分组画布。

回滚时先暂停相关写入并备份项目/运行数据，保留归档资产、请求记录和恢复元数据；前端可单独回退。回退 Worker 会失去绑定失败补写能力，应先处理待恢复任务。生产迁移、批量覆盖和删除仍需独立授权，本轮未执行。

## 6. 交付与后续入口

本轮交付的是验收修复快照及缺口清单，不是六项功能全部验收完成。交付分支为 `codex/generate-to-new-node`，annotated Tag 为 `v2026.09.17-six-feature-acceptance-fixes`；提交推送到 `origin` 后，以远程分支及 Tag 解引用核验同一提交。推送结果在任务交接中报告。原有待办继续保留在 [TODO-CONSOLIDATED.md](../TODO-CONSOLIDATED.md)。

本地预览：`http://127.0.0.1:5184`，连接独立内存 Mock API `http://127.0.0.1:19301`。通过合成账户完成登录、文字节点编辑、创建分组、保存和刷新，最终恢复 5 个合成节点、2 个组，无页面运行时错误。启动与冒烟脚本及截图位于忽略目录 `test-results/next-preview*`、`test-results/start-next-preview.ps1`。预览数据只在当前内存进程存活期间保留；该冒烟没有执行生成或验证提示词记录。

下一阶段先补齐第 2 节的提示词版本查询、摘要编辑和类型默认继承，再补分叉入组、清空竞态/在途任务提示、计时偏移及联合流程与性能证据，最后重新评估阶段 G。真实供应商验收独立安排，必须明确 Provider、模型、输入和调用次数。

## 7. 功能补齐后的验收

起点 `56739d1`，分支和上游不变；P1 主目标为修复上一轮六项验收缺口。没有升级依赖或增加迁移。摘要选择手动创建、编辑和清空，真实文本只读；自动付费总结、生产部署与手机专项后置。

### 7.1 当前结果

| 范围         | 已修复及证据                                                                                                     | 当前边界                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 提示词与摘要 | 精确资产版本 GET/PATCH；资源库历史入口；删除原节点、版本切换、手动覆盖、历史输入、晚到查询及摘要保存竞态均有回归 | 没有真实记录时明确说明，不回填或伪造；导出不新增说明或摘要   |
| 节点耗时     | API/SSE 服务端时间、单调推进；旧结果时间与当前执行分离，手动输出不继承旧耗时                                     | 缺记录显示未记录；内存数据随进程结束，持久化使用现有 Prisma  |
| 设置         | 项目/类型默认优先于旧节点与本机偏好，跨模型不复制旧参数；设置保存后刷新默认                                      | 普通用户全局默认由服务端执行时解析，前端不读取管理员凭据接口 |
| 连线         | 30 组合回归，固定规模性能对照                                                                                    | 无性能提升承诺，自动化大组拖动耗时待拆分测量                 |
| 分组         | 分叉继承/扩边；25%/100%/200% 移动、缩放、撤销、保存刷新                                                          | 保持绝对坐标、布局组不进入 DAG，不新增生成调用               |
| 清空         | 状态变化重新确认；在途数量及继续执行提示；清理弹窗、晚到事件不复活、原子撤销                                     | 清空只移除画布引用，资源和运行记录保留                       |

新增修复：历史预览遮罩不再挡住关闭按钮，返回后保留未保存摘要草稿；新任务失败时继续显示旧结果，同时显示失败原因与最新运行图标；内存请求明确拒绝和发送不确定状态与 Worker 保持同一分类。

### 7.2 验证

| 检查                      | 结果                                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`               | 8 个任务通过                                                                                                                        |
| `pnpm typecheck`          | 13 个任务通过                                                                                                                       |
| `WEB_PORT=5173 pnpm test` | 13 个任务通过，运行时 8 项通过；Web 861、API 680、Providers 310、Worker 236、Domain 65、UI 3、Observability 21、Credential Crypto 7 |
| 普通测试跳过              | API 59、Worker 3，均不计入对应设施验收                                                                                              |
| `pnpm build`              | 8 个任务通过，仍有 Vite 单块大于 500 kB 提示                                                                                        |
| 隔离 PostgreSQL 专项      | 5 文件、116 项通过，零跳过；资产版本读取、摘要更新、内存请求捕获与执行合同                                                          |
| 主画布回归                | 49 项通过，新增清空确认竞态、迟到结果及倒序恢复                                                                                     |
| 浏览器                    | 全量 84 项通过、3 项跳过、0 失败，3.6 分钟；包含六项专项 16 项                                                                      |
| 本地 API 冒烟             | 浏览器真实 HTTP 连接 19301 的内存 Mock，生成后查说明、改摘要、分组、保存刷新和资源历史通过，零页面错误                              |

普通测试与专项数量存在重叠，不能累加当成唯一用例总数。隔离命令配置 `TEST_DATABASE_CONFIRMED_ISOLATED=true`、本轮 PostgreSQL 的 `TEST_DATABASE_URL`、空 `DATABASE_URL`、`WORKER_PROVIDER=mock`，运行 `request-prompt-routes.test.ts`、`runs.test.ts`、`run-persistence.test.ts`、`app.test.ts` 和 `newapi-run-executor.test.ts`。沿用本轮专用 Compose 设施；没有写入生产数据库。

浏览器最终命令：`WEB_PORT=5185 pnpm --filter @multimodal-canvas/web test:e2e --workers=1 --output=../../test-results/next-completion-e2e --reporter=line`。三种 PC 尺寸 × 两种主题 × 画布/设置/长提示词，共 18 张截图；另有资源历史预览、恢复和三个分组缩放截图。正文对比度及控制台检查由专项断言覆盖，截图目录为 `test-results/next-completion-e2e/`。

跳过项是两个未配置的真实图像验收及需独立运行的性能比较；性能已按第 7.3 节单独完成，不把跳过算通过。已检查 18 张截图及实际本地 API 的摘要/刷新截图，未见文字溢出或弹层遮挡。门禁日志为 `test-results/next-completion-{lint,typecheck,tests,build,postgres,e2e}.log`。

### 7.3 性能证据

同机开发模式、同脚本，固定 100 节点、99 连线、100 成员组、24000 字符提示词及一个活动计时器。基线使用独立工作树 `56739d1`，每种操作 5 个样本，帧间隔 119 个样本；命令使用 `PERFORMANCE_LABEL` 显式启用 `next-performance.spec.ts`。

| 测量                 | 基线中位数 / P95     | 当前中位数 / P95     |
| -------------------- | -------------------- | -------------------- |
| 动画帧间隔           | 16.7 / 33.3 ms       | 16.7 / 33.4 ms       |
| 大组 12 步拖动总耗时 | 2983.19 / 3098.33 ms | 2883.49 / 3018.16 ms |
| 长提示词打开总耗时   | 467.29 / 552.29 ms   | 454.87 / 476.04 ms   |
| 活动计时器帧间隔     | 16.7 / 33.3 ms       | 16.7 / 33.4 ms       |

数据包含 Playwright 操作及等待，不等同于每次输入延迟。没有观察到明显帧时间回退，也不足以宣称优化；后续应以生产构建和重复独立采样定位大组性能瓶颈。原始 JSON 在 `test-results/next-performance-{baseline,current}-verified/`，未做无依据优化。

### 7.4 真实供应商

用户明确授权三个模型各最多一次，不自动重发。使用 `https://api.lolicon.beer/v1`；头为 `Content-Type: application/json`、`Authorization: Bearer [redacted]`。密钥只在临时进程内读取，未写入源码、配置或证据。

| 类型 | 实际请求与结果                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文字 | POST `/chat/completions`，`{"model":"glm-5.3-flash","messages":[{"role":"user","content":"Reply with ACCEPTANCE_OK only."}]}`；HTTP 524，`bad_response_status_code` / `openai_error`                                                                                    |
| 图片 | POST `/images/generations`，`{"size":"1024x1024","response_format":"b64_json","model":"gpt-image-2","prompt":"A single red cube centered on a plain white background. Clean studio lighting. No text.","n":1}`；HTTP 200，PNG 859469 字节，已人工检查白底红立方体       |
| 视频 | POST `/videos`，`{"model":"grok-imagine-video-1.5","prompt":"A single red cube slowly rotates on a plain white background. Static camera. No text."}`；HTTP 400，`seconds or duration is required for per-second billing`。验收脚本绕过 UI 漏传时长，未获得平台 task ID |

图片归档 `asset_bce6f440-d76c-4ef7-9d4a-7927f548bdef@v1`，请求记录与实际 prompt 相同，版本查询 HTTP 200；执行耗时 29.340 s。SHA256：`4caa70305546decc2917b5fa54dabe10dbb224e5b63b90392cbc3d876d24cc34`，供应商请求 ID `05d79fc0-d1bb-4df7-ad6d-c89d13b6f5f9`。

脱敏证据为 `test-results/next-live-provider.json` 和 `next-live-image.png`。三个创建 POST 已用完，无自动重发。文字 524 保留发送结果不确定语义；视频明确 400 在代码修复后会分类为 failed，历史证据文件保持原始结果不改写。补充脚本已离线捕获并核对视频体增加 `duration: 4`、`seconds: "4"`，文件为 `next-live-supplement.mts` 和 `next-live-supplement-dry-run.json`；live 模式没有执行，等待额外额度。模型目录没有音频模型，因此音频只有本地合同证据。

### 7.5 交付与剩余条件

本轮代码可交付，阶段 B/G 的真实供应商条件仍未关闭。剩余：获追加额度后文字/视频成功取证；有精确音频模型后补音频；生产部署及供应商恢复合同沿用现有 TODO，不凭本地测试销项。

无新增迁移、依赖或生产配置。增量 API 为资产版本说明 GET 与摘要 PATCH，正文不可修改；先备份项目/运行/请求记录即可回退代码，保留资产版本及已写摘要。版本导出沿用旧格式，不输出新查询记录，导入不会重建未被导出的生成说明。

交付分支 `codex/generate-to-new-node`，上游 `origin`，annotated Tag `v2026.09.17-six-feature-completion`。提交正文包含修复范围、验证结果和上述外部限制。预览 `http://127.0.0.1:5184`，合成账号 `preview@example.test`，密码 `Synthetic-Preview-2026!`；仅连接本任务内存 Mock API，不使用真实供应商凭据。
