# 图片新节点的参考图继承

## 范围与基线

- P1：修复图片节点从结果 B 继续生成到新节点时，自动携带父提示词中的旧参考图 A。
- 分支 `codex/generate-to-new-node`，起点 `1067a08`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0，依赖已安装，现有分叉工具单测 8 项通过。
- 接手时只有用户的 `docs/resource-input-compatibility.md` 修改，保留且不纳入提交。
- 验收：新节点默认仅引用当前结果 B，保留本次文字要求；父节点文档不变，原节点重生成和用户在子节点主动添加的引用不被全局过滤。
- 本轮是 Web 单一路径修复，不改变 API、数据格式或供应商能力，无依赖、数据库或数据迁移；回滚代码即可恢复原继承方式，无需备份或改写用户画布。
- 本轮不扩展多参考图或移动端；后续已单独接通[主动添加多参考图](image-multi-reference.md)，新节点继承规则保持不变。合成测试不发真实供应商请求。

## 检查点

- [x] 组件与浏览器均在修复前复现：子节点已冻结结果 B，但请求仍携带 A 的图片提及。
- [x] 图片「新节点」请求使用独立文档，移除继承的图片提及，保留文字与非图片提及；纯文本中的普通 `@` 不猜测为资源。
- [x] 清理后没有修改要求时先提示，不创建空要求的子节点或提交运行。
- [x] 主流程单测与分叉工具 66 项通过，lint、typecheck、build 通过。
- [x] 浏览器最终 6 项通过，截图及请求 JSON 核对通过，无页面异常或 console.error。
- [x] 任务差异、文档和敏感信息检查通过，用户原有文档修改未纳入交付范围。

本轮修复与验收完成。浏览器复用 `http://127.0.0.1:5187` Mock 验收服务。构建只有已有的大于 500 kB chunk 提醒。

复现日志：`test-results/image-fork-before-fix.log`、`test-results/image-fork-reference-before.log`。前者明确断言旧 `asset-reference` 提及仍在新节点请求；后者确认当前结果冻结与唯一父子连线正确，问题来自提示词继承。

## 验证命令

```powershell
pnpm --filter @multimodal-canvas/web exec vitest run src/canvas-editor.test.tsx src/workspace/fork-generate-node.test.ts --reporter=dot
pnpm lint
pnpm typecheck
pnpm build
$env:WEB_BASE_URL='http://127.0.0.1:5187'
pnpm --filter @multimodal-canvas/web exec playwright test e2e/node-generation-batch.spec.ts --workers=1
```

已通过的单测、lint、类型与构建日志分别为 `test-results/image-fork-tests.log`、`test-results/image-fork-lint.log`、`test-results/image-fork-typecheck.log`、`test-results/image-fork-build.log`。新增浏览器用例对用户后续主动添加的引用仅验证提交边界，不将 Mock 成功响应当作供应商多图能力验收。

最终浏览器日志为 `test-results/image-fork-reference-final.log`。同名输出目录中新用例的 `image-fork-request.json` 确认：父提示词含 1 个图片提及，子请求含 0 个图片提及，子 `imageEditSource.assetId` 等于最新结果 `result-1-generation-root`，文字要求保留。父节点初始没有输入边，仅通过 `@A` 引用旧参考图，避免重复输入干扰验收。

该修改限定 Web 图片分叉路径，按小改动提交并推送至 `origin/codex/generate-to-new-node`，不创建发布 Tag；最终提交 ID 与推送结果以交付消息和远端核验为准。
