# 节点输入与资源引用交互修复

日期：2026-10-03。P1，PC Web 核心流程。

## 基线与范围

- 分支 `codex/generate-to-new-node`，起点 `0caa024`，上游 `origin/codex/generate-to-new-node`。
- Node `v24.12.0`、pnpm `11.19.0`，沿用本地依赖及锁文件，没有新增依赖。根目录没有 README.md 或 AGENTS.md，按用户提供的指导执行。
- 用户原有 `apps/web/src/index.css`、`apps/web/src/workspace/CanvasNodeToolbar.test.tsx` 改动及 `docs/resource-input-compatibility.md` 删除均保留，不纳入本任务提交。
- 收尾时另出现未跟踪的 `docs/prompt-skills-toolkits.md` 和 `docs/prompt-skills-toolkits-checkpoint.md`，不属于本轮，同样保留且不暂存。
- 修改前定向基线 158 项通过。验收范围为单滚动条、长文反复拖选及行尾点击、底部操作右对齐、连续添加资源与编号排序、`@` 搜索分域和布局。
- 不改节点持久尺寸、素材文件、供应商合同或数据库，不触发真实生成，不扩展移动端。浏览器可写验收全部使用合成项目及 API Mock。

## 修复结果

1. 快速编辑器和完整 Dialog 都只让原生 textarea 滚动；高亮层裁切并跟随输入层，不再产生第二根滚动条。
2. 高亮层原先独立出现滚动条，会再次扣减正文宽度，导致文字与原生选区换行不一致；统一宽度，并同步 `text-rendering`。直接验证画布内连续鼠标拖选和“方。”点击，不以 Dialog 绕过问题。
3. 只将底部 Skill、生成数量和生成按钮右对齐，不移动顶部模型、模式等设置。
4. 上传 `+` 与添加参考图入口位于资源条前部。添加模式固定目标，可连续点击画布资源，原子写入引用及连线；重复点击不重复添加。Esc、再次点击入口或“完成添加”退出。资源显示连续序号，可拖拽或用 Alt＋左右键排序，刷新后保留。
5. `@` 默认搜索节点正文提及及连线资源；切换项目资源后，空关键词最多展示 10 项并提示输入关键词，不显示分页；有关键词时调用现有认证接口搜索整个项目并按实际结果分页，不限制为默认 10 项或左侧已加载的 50 条。类型筛选为带 tooltip 和无障碍名称的图标，与两个范围 Tab 同行；面板最大 520×480，受视口约束。查询支持取消、过期响应隔离、加载状态、失败重试和分页；不把接口错误降级为缓存结果。

## 数据兼容与业务边界

- 复用已有 `resourceRefs`，不新增数据库字段或迁移。身份以 `assetId + assetVersion` 精确匹配，同资产不同版本不合并，未知版本不替换为目录最新版。
- 只有用户明确拖拽或用键盘排序后才给引用 ID 添加 `ordered:` 标记。历史 `resourceRefs` 仅记录别名，不能因为非空就改变原执行顺序。未排序节点保持原行为；未列资源稳定追加。
- 来源引用 ID 为 `connected:source:<编码后的节点ID>:<编码后的资产ID>`，排序只在外层包装一次 `ordered:`。版本单独保存在 `assetVersion`。collector 按本来源绑定、来源精确版本、明确旧连线 ID、无歧义普通旧引用的顺序解析；歧义时明确拒绝，不串绑同资产的其它版本。
- 添加或排序前先保留旧纯文本别名的结构化投影，不能因冻结引用而丢失正文 mention。排序不移动正文或 mention 身份，不改边的角色、首尾帧槽位、`blockOrder`、`sortOrder` 或已有任务快照。
- Provider 只对已存在的运行输入按明确版本排序，不凭资源条新增原图，不用显示绑定覆盖运行输入版本。来源节点后来改变时，连线仍沿既有执行引擎在创建任务时冻结；本轮不承诺所有后续连线任务永远使用资源条旧版本，也不修改执行引擎。
- 图片原图、视频参考媒体、请求说明与报价媒体共享最终排序；Wan 时长数组同序。本地模拟验证不代表真实供应商验收。
- 单次添加先验证再作为一次可撤销历史变更提交；失败保留图和添加模式。拒绝自身、循环、无资源、未知版本、引用数量超限或非法端口。
- 已存在首尾帧输入的视频节点不能通过此入口静默转为全能参考；视频文字资源提及尚无 Provider 映射，明确提示使用提示词连线。原帧连线、模式和提示词不会被失败操作改变。
- 项目搜索复用 `GET /v1/assets` 的 `projectId`、`query`、`mediaType`、`status=ready` 和每页 50 条合同。旧仅返回完整 `assets` 的协议才本地过滤/切页。API 仍负责权限，取消或登录身份变化后不回传迟到数据。
- 已冻结 mention 不因分页目录尚未加载而被判失效；保留精确版本 URL，不伪造 ready/MIME 元数据。已有归档、forbidden 或 placeholder 状态仍禁用。

## 恢复与验证记录

首次整合曾通过 Web 1929 项和部署包核心 16 项；审查随后发现全项目检索、旧别名排序、来源版本绑定及旧正文投影缺口，因此这些旧结果不作为最终代码验收。

子代理额度中断后，用户两次要求继续，均恢复原独占分工并核对工作区，没有覆盖用户改动或重复真实生成：

- 项目查询子代理：查询模块及测试，111/111 通过。
- 资源动作/Provider 子代理：actions 32/32，collector/投影联测 87/87，Provider 全量 768/768。
- 来源版本子代理：collector 与新来源绑定测试；主代理同步精确对象断言后 collector/投影/编辑器联合 61/61 通过。
- 主代理六个 UI 定向文件 186/186 通过；源码冻结清单为 `.local-tests/reference-interactions/frozen-code-hashes.json`。

### 最终检查（收尾补丁冻结后）

证据目录：`.local-tests/reference-interactions/`。Windows 的 TEMP/TMP 指向该目录下的 `tmp`；API 默认测试显式 `WEB_PORT=5173`，Turbo 测试使用 `--env-mode=loose`。

| 检查                                                 | 最终结果                                     | 日志                                                                 |
| ---------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm test:runtime`                                  | 8/8 通过                                     | `test-runtime-delivery-final.log`                                    |
| Web 全量 Vitest（2 workers，15s 用例超时）           | 114 文件、2094/2094 通过，无 skip            | `web-delivery-final.log`                                             |
| 非 Web Turbo 测试（单并发）                          | 13/13 任务成功；相同输入命中缓存             | `nonweb-delivery-final.log`                                          |
| Provider                                             | 768/768 通过                                 | 同上及 `nonweb-recovered-final.log`                                  |
| API                                                  | 1082 通过、92 跳过、5 个既有 TODO            | 同上                                                                 |
| Worker                                               | 779 通过、28 跳过                            | 同上                                                                 |
| Domain / credential / observability / UI / execution | 266 / 7 / 21 / 16 / 43 项通过                | 同上                                                                 |
| `pnpm lint`                                          | 9/9 任务成功                                 | `lint-acceptance-final.log`                                          |
| `pnpm typecheck`                                     | 15/15 任务成功                               | `typecheck-acceptance-final.log`                                     |
| `pnpm build`                                         | 9/9 任务成功；保留既有大 chunk 提示          | `build-delivery-final.log`                                           |
| Docker 三应用构建及最后 Web 元数据补丁构建           | 成功                                         | `docker-build-verified-final.log`、`docker-build-metadata-final.log` |
| 部署包核心 10 场景，两轮零重试                       | 20/20 通过，无 flaky、无 skip                | `acceptance-e2e.log`、`acceptance-e2e.json`                          |
| 新增目录外元数据浏览器回归                           | 已改为真实键盘移动；独立两轮及核心两轮均通过 | `frozen-mention-caret-20261003-round3.log` 及上述核心结果            |
| 最终真实项目只读冒烟                                 | 通过，无新增控制台错误，提示词逐字未变       | `real-project-final-smoke.json`                                      |

跳过的基础设施、外部供应商用例及 TODO 不算验收通过。本轮不调用真实收费创建接口。

### 既有扩展 E2E 失败

`resource-mention-picker.spec.ts` 的五项旧流程在本次实现和部署前旧包 `/assets/index-BpNNpCXT.js` 都出现对应失败。旧包对照单 worker、零重试；证据在 `.local-tests/reference-baseline-8080/summary.md`、JSON 报告及 traces：

- 五主题用例等待旧的“图片（9）”计数文本，当前实际选项没有计数。
- 资源预览可见断言通过后，几何查询目标为空；不能据此认定图片加载失败。
- 菜单键盘用例的“生成提示词”模态仍开着，拦截“导出”点击。
- Skill 优化用例的预期“优化预览”组未出现。
- 数量/Skill 用例第一档视口通过，但 Escape 已取消节点选择，第二档视口找不到数量框。

这些是待独立定位的存量失败或测试契约问题，已列入 `TODO-CONSOLIDATED.md` 的 P2-08，不宣称扩展 E2E 全量通过，也不扩展本轮范围。

## 本机部署与回滚

- 最终包已更新为 `/assets/index-DoVuVnvE.js`，项目页面 HTTP 200；API、Worker、Web healthy。三服务更新前查询活动 Run 为 0，随后元数据预览补丁仅重建 Web。
- 仅重建并更新 `web api worker`：`docker compose up -d --no-deps --wait --wait-timeout 180 api worker web`。不执行 migrate、不删卷、不重建数据库或素材存储。
- 原 Postgres `6ddf17691305`、Redis `dfa5e28b025c`、MinIO `67c15a724cda` 容器必须保持不变。
- 最终真实项目只读检查：textarea/高亮宽 751px、高 180px、scrollHeight 1077px；高亮 hidden，底部 flex-end；搜索 520×480，图标/Tab 同行；默认节点 3 项，项目空词 10 项且无分页；搜索已有 56.png 命中 1 项，清空恢复 10 项。1157 字符提示词逐字未变。最终刷新后的操作新增 console error 为 0；旧包的缺 MIME 错误仍保留在历史日志，不计为新错误。证据 `real-project-final-smoke.json`。
- API、Worker 部署前镜像留有 `before-reference-interactions-20261003` 标签；元信息见 `docker-before.json`、`services-before.txt`。
- 最初运行中的旧 Web 镜像已不在本地 image store，保存的 Web 标签不保证等于实际旧包。精确旧 `/usr/share/caddy` 与 Caddy 配置在 `web-before/`，需要时据此恢复，而不是假设标签等价。
- 回滚无需数据库操作；回退代码和应用镜像前仍须确认没有在途任务，保留素材及任务数据，不覆盖三处用户差异。

### 最终全量首轮发现的收尾项

- 3 个项目资源用例在切换 Tab 后同步查找远程结果，改为等待异步选项，不缩短延迟或跳过断言。
- 1 个旧别名兼容用例揭示明确 `connected:<assetId>` 权威引用被误判多版本歧义；保留旧测试契约，collector 已修复，既有 App 两个分支及 collector/绑定/投影 63 项通过，另补 8 项兼容回归；最终全量 2094/2094 通过。

### 真实页面补充发现

- 核心 18 项两轮通过后，真实项目只读移动光标经过目录外冻结 mention 时触发悬停预览，暴露缺失 MIME 的引用被当作完整 Asset 的运行错误（mimeType.split）。提示词比对仍一致，未生成或改动素材。
- 将所有预览入口统一门控为有 MIME 才渲染 AssetPreview，未知元数据只显示类型图标；不伪造状态或MIME。补光标预览/详情回归，两个编辑器测试文件 76/76 通过，并重建 Web、补浏览器场景、重新运行全量。

### 用户追加的输入框搜索要求

- 只调整输入框 @ 搜索的项目资源范围：空词前 10 项，输入关键词后检索完整项目；节点资源、顶部搜索和左侧资源栏不变。
- 三个相关测试文件 186/186 通过；补充清空查询恢复预览、节点资源不截断和关键词结果超过十项的回归。部署包的十项预览、跨页检索和完整关键词匹配已通过两轮。
- 新要求发生在全量检查期间，之前结果不冒充追加需求后的最终验收；已再次冻结并完成全量。

## 收尾检查点

- [x] 完成五项实现及审查兼容补丁。
- [x] 定向、非 Web、runtime、lint/typecheck/build 检查。
- [x] Web 最终全量 2094/2094 通过；核验 27 个源码和测试文件哈希，最后仅更新已验收的浏览器测试冻结值，业务源码无漂移。
- [x] 最终构建部署、核心浏览器两轮 20/20 及真实项目只读冒烟；浏览器临时视口已恢复。
- [x] 29 个任务文件范围已确定；真实密钥模式扫描无命中，不纳入用户原有三处差异。

交付目标为 `origin/codex/generate-to-new-node`，annotated Tag 为 `v2026.10.03-node-reference-interactions`。提交前检查完整暂存差异，推送后用 `git ls-remote` 核对分支和 Tag 的提交值；核验结果保存在本机 `.local-tests/reference-interactions/git-delivery-verification.json`，不提交测试日志或真实项目截图。

最后成功的浏览器命令：

```powershell
$env:WEB_BASE_URL = 'http://localhost:8080'
pnpm --filter @multimodal-canvas/web exec playwright test node-editor-text-alignment.spec.ts resource-mention-picker.spec.ts --grep '倍长中文引用连续拖选|完整 Dialog 使用相同|1440 PC 节点 picker|1024 PC 放大 Dialog|PC 连续添加参考|项目资源搜索跨越首页|PC 目录外冻结引用' --workers=1 --retries=0 --repeat-each=2 '--reporter=list,json'
```

## 搜索框宽度反馈（2026-10-03）

P2，仅输入框 `@` 资源面板的视觉微调；不改搜索、分页、引用、节点尺寸或并行 Skill 工作。

- 基线：`codex/generate-to-new-node @ 3d72fa2`，Node `v24.12.0`、pnpm `11.19.0`，依赖已安装；节点输入布局原有 10/10 单测通过。
- 面板宽度从 520px 收至 400px，高度仍为 480px，并保留视口边界。第二行图标和 Tab 的组内间隔均为 6px，两组之间至少 16px，保留左右分组。
- 只修改专用资源控件样式；不碰共享 `index.css`。浏览器测试验证 1440px 画布与 1024px Dialog 的宽度、按钮间隔、焦点与项目默认十项。
- 本轮证据：`.local-tests/reference-picker-width/`。修改前浏览器 2/2；相关四文件单测 197/197；全仓 lint 9/9、typecheck 15/15、build 9/9 成功；新增几何契约定稿后目标文件 Prettier 与 diff 检查通过。
- 新包五个相关浏览器场景连续两轮 10/10，零重试、零 skip、零 flaky；覆盖画布与 Dialog 的 400×480px、按钮同行与留白、默认十项、完整项目分页、连续添加排序及未知 MIME 预览。1440px 与 1024px 截图均已目视检查。
- 已仅更新本机 Web，`8080` 部署后同一几何契约冒烟 2/2 通过，入口 `/assets/index-0MixlCjA.js`；API、Worker、数据库和素材存储未由本轮重建。未刷新或编辑用户正在打开的真实项目提示词，浏览器写操作只使用合成项目和 API Mock。
- 精确运行前 Web 镜像已保留为 `multimodal-canvas-web:before-picker-width-20261003`，需要时可重新标记为本机 Web 镜像并仅重建 Web，无数据库回滚。临时验证服务 8086 结束后停止。
- 本轮仅提交专用 CSS、现有 E2E 和本检查点三个文件。并行 Skill、移动端及用户原有改动不暂存；测试结果对应本轮已验证的构建快照，不代表持续变化中的其它任务已验收。提交并推送当前 origin 上游后，将远端核验写入本机 `git-delivery-verification.json`。
