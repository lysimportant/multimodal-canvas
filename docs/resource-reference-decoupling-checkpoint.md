# 节点参考资料与正文解耦检查点

2026-10-07，P1。起点 `main @ ae42743`，上游 `origin/main`，开始时工作区干净。Node `v24.12.0`、pnpm `11.19.0`，使用已有本地依赖。

## 验收范围

- 进入添加参考资料模式立即显示 Message，退出与目标切换清理提示。
- 资料独立保留；编辑正文或移除某处引用标记不移除资料，资料卡片的 × 才移除该节点引用。
- 同资产同版本复用名称与资料；新资料追加末尾，不由正文位置改变排序。
- 画布添加模式只添加资料，不写入正文名称。
- 选中文字保持普通文字，引用缩略图插在选区后面；不自动匹配同名文字。
- 正文引用有常显缩略图，支持光标、中文输入、粘贴、撤销重做、保存刷新与完整编辑器。
- 无正文名称时，已添加资料仍按授权和冻结版本进入生成输入；沿用各模型已有能力限制。

## 实现与兼容

- `PromptMention.inline?: true` 表示独立内联引用，`renderPromptDocument` 不把其名称写入正文。缺省值保持旧提及语义；编辑器打开旧提及时，将旧名称保留为普通文字，再放入独立缩略图。
- `NodeResourceRef.attached?: boolean` 表示独立资料池。正文编辑、删除某处缩略图及普通文字撤销不缩减资料池；资料卡片 × 显式移除该节点引用，支持撤销恢复与重做移除，不删除源素材。
- `InlinePromptInput` 用原生选区和不可编辑的单字符原子排版，缩略图常显。内部 `U+FFFC` 只用于编辑位置，不写入保存正文；粘贴采用纯文本。保留中文组合输入、换行、复制剪切、光标和撤销重做。
- 同资产同版本复用资料与别名。按资料池顺序恢复并在末尾添加新身份，不按正文位置排序。选区后的插入保留整个选区及其首尾空白，不自动绑定同名普通文字。
- API 的授权校验、估算和运行快照复用 `getExecutionPromptDocument`，仅把缺少正文标记的独立资料投影到执行文档；不改保存正文。Provider 按保存顺序及冻结身份去重，保留首尾帧等特殊角色与现有能力限制。
- 旧画布只有正文引用、只有连线别名或尚无资料池的情况保留兼容。改名明确区分资产版本，不借目录最新版补旧版本；未知连线版本不提前转换来源身份。重复使用已有资料不提升视频模式或剪掉帧连线。

没有数据库迁移、依赖升级或用户数据覆盖。发布前后均保留带 `inline` / `attached` 标记的画布 JSON；如需回滚代码，先备份这些画布，再回退本任务提交。旧代码不理解独立资料的执行语义，因此不能把旧代码读取新画布当作无损回滚。并行任务 `a7d39d3`（视频素材 HTTPS 签名链接）是当前基线，本任务未覆盖它。

## 验证与恢复

验证使用已有依赖、合成项目和 API Mock。日志及失败产物保存在忽略目录 `.local-tests/reference-decoupling/`，不纳入提交。没有付费 Provider 请求、真实项目写入、数据库迁移或生产部署。

- 最终补丁后 `pnpm typecheck`、`pnpm lint`、`pnpm build` 再次通过；构建仍有既有大 chunk 提醒。`git diff --check` 通过。
- 运行产物测试 8/8；Domain 406/406；Credential Crypto 13/13；Observability 21/21；UI 16/16；Execution 43/43；Providers 786/786。
- API 1211 项通过、108 项设施/真实服务相关跳过、5 项 pending 未执行；Worker 817 项通过、28 项设施相关跳过。API 的 5 项位于未启用的嵌套设施组（Redis 1、MinIO 1、独立 API/Worker 的 text/image/audio 恢复 3），JSON 报告确认 `numTodoTests=0`。跳过及 pending 不算隔离集成或真实 Provider 通过。
- 首次默认 `pnpm test` 因 Windows 系统临时目录 `EPERM mkdir` 失败。恢复为项目内隔离 `TEMP` / `TMP`，各包限制 worker 后执行完整测试；未更改项目测试配置，不能声称原默认命令全绿。
- Web 四 worker 全量曾有 2461 项通过、1 项未改动的 Skill 工作台测试超过默认 5 秒时限。该文件单 worker、原默认时限复核 28/28 通过；两 worker、15 秒时限恢复全 Web 后，134 个文件、2462/2462 通过。没有修改 Skill 工作台代码、断言或项目默认超时配置。
- 专项 App 与节点资料动作 124/124、App 引用同步 20/20、完整文本编辑器引用同步 8/8，通过；后续 Web 全量包含这些用例及完整画布保存测试。
- 最终只读审查补齐了独立编辑器的纯资料池删除历史：先删最后一处正文原子，再点资料 ×，撤销只恢复资料卡片而不恢复正文原子。新增用例先跑红，修复后编辑器五文件 99/99；实际独立调用方 Skill 工作台单 worker、原默认时限 28/28 通过。普通文字撤销仍保留池，只有残留连线的重复 × 不生成空历史。证据为 `editor-pool-history-{red,green,workbench}.log`。

Web 恢复命令（在仓库根目录执行）：

```powershell
$env:TEMP = Join-Path (Get-Location) '.local-tests/reference-decoupling/vitest-temp'
$env:TMP = $env:TEMP
$env:WEB_PORT = '5173'
$env:VITE_API_BASE_URL = 'http://localhost:3000'
pnpm --filter @multimodal-canvas/web test --maxWorkers=2 --testTimeout=15000
```

其他包分别调用其原 `test` 脚本，追加 `--maxWorkers=1` 或 `--maxWorkers=2`；`pnpm test:runtime` 保留原命令。设施类环境未配置，仍按对应测试显式跳过，不连接用户设施。

## PC 浏览器验证

相关场景 27/27 通过，覆盖快捷编辑器（1600 宽）、完整编辑器（1024 宽）的七项需求、撤销重做、保存刷新、显式删除、节点尺寸、控制台与不自动生成。还覆盖 Chromium CDP 中文组合输入、换行、纯文本粘贴，以及四类节点/素材节点的拍照、版本冻结、原素材保留、嵌套相机和刷新。已实际查看两张最新 PC 截图，引用常显且没有撑大节点。

资料池历史最终补丁后，又按 `--grep 'PC 引用解耦|PC 内联引用'` 重跑三个核心 PC 用例，3/3 通过（`browser-submit.log`）；没有重复执行未受影响的拍照与扩展场景。原生 copy/cut 和组合输入期间权威外部替换未单独做浏览器验证，不能据纯文本粘贴通过扩大结论。

```powershell
$env:WEB_PORT = '5197'
$env:VITE_API_BASE_URL = 'http://localhost:3000'
pnpm --filter @multimodal-canvas/web exec playwright test e2e/resource-mention-picker.spec.ts --workers=1 --grep-invert '资源分类在五种主题|资源预览由库模态|组件库菜单和外观标签|节点输入区数量样式统一|Skill 优化预览'
```

## 既有扩展 E2E 边界

以下五项在本轮当前代码和隔离旧提交 `a7d39d3` 的原始测试中逐项同因失败；旧提交工作区起止均干净，使用合成数据和 API Mock。它们仍归入 [P2-08](../TODO-CONSOLIDATED.md#--p2-08-节点交互扩展-e2e-存量失败定位)，不能标为通过或用相关 27 项替代完整扩展验收：

1. 主题资源分类等待旧“图片（9）”选项。
2. 资源预览读取空目标的 `getBoundingClientRect`。
3. 提示词模态遮罩拦截菜单“导出”。
4. Skill 数量布局找不到旧“生成数量：1份” combobox。
5. Skill 配置找不到“优化预览”分组。

旧提交隔离工作树和 5198 服务已清理，原工作区与依赖存储保留。证据见本地 `baseline-e2e-checkpoint.md`、`baseline-browser.log/json`；当前对应 `browser-final.log/json`，相关用例最终结果为 `browser-scope-final.log`。

## 收尾状态

七项实现、相关 PC 验收、全 Web 恢复测试、最终资料池历史回归及构建检查已完成；任务文件经过差异与敏感内容检查。提交及上游推送由主代理在验证完成后执行，具体提交和 Tag 以 Git 记录及交付回复为准。设施/真实 Provider/生产部署未验收，五项既有扩展 E2E 保持待办。
