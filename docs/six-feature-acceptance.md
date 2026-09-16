# 六项需求验收记录

更新时间：2026-09-17。验收对象：[next.md](../next.md) 第 3～8 节。

**整体暂不通过。** 本轮完成已有实现的验收、复现缺陷修复及本地回归；摘要、版本归属、默认值继承等需求仍未实现完整，阶段 G 保持未关闭。自动化检查通过不能代替功能完整性验收。本轮没有调用真实 Provider，也没有操作生产数据。

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
