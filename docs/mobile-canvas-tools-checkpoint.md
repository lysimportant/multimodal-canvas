# 手机底部胶囊检查点

- P2：宽度不超过 600px 时默认仅显示文字、图片、音频、视频四个入口和一个向上箭头；其余原操作在上方弹层内展示。桌面不变。
- 起点：`codex/generate-to-new-node @ c1d8b21`，上游 `origin/codex/generate-to-new-node`；Node v24.12.0 / pnpm 11.19.0，依赖齐全。
- 已读取汇总 TODO、上一轮手机检查点及现有组件；未发现本地 AGENTS.md 或根 README，遵循会话规则。
- 用户预存改动：`index.css`、`CanvasNodeToolbar.test.tsx`、删除的 `docs/resource-input-compatibility.md`，保留且不纳入提交。
- 基线：CanvasNodeToolbar 3 项和 responsive-ux 16 项测试全部通过。
- 实施：复用原动作回调及禁用状态，手机点击箭头向上展开；支持外部点击、Escape、断点切换和普通动作后关闭，保留嵌套外观/清空菜单。
- 当前状态：实现与专项验收已完成，只提交本次胶囊组件、独立 CSS、新单测、新 E2E 和本检查点；并行视频再创作功能的改动不纳入本次提交。
- 无 API、数据格式、依赖、资源删除或迁移变化；回退本次提交即可恢复旧胶囊。

## 最终验证

- 37/37 项针对性单测通过：手机胶囊 4、原胶囊 3、清空菜单 9、外观 5、响应式 16。
- 6/6 项 Playwright 专项通过：320×640、390×844 默认五按钮、上方菜单范围、嵌套外观/清空选项、整理/撤销/重做、外部点击和 Escape、桌面及跨断点切换。未执行清空或付费生成。
- 已目视检查手机初始及展开截图，修复首次发现的菜单左侧越界；所有剩余按钮保留原禁用条件。
- Web lint、typecheck、build 和差异空白检查通过，保留既有大 chunk 警告。构建过程仅为当前进程设置 TEMP/TMP 为仓库 `.local-tests/mobile-canvas-tools-build-temp`，未修改系统配置或依赖。
- 主代理首次复验误复用了已有 5188 服务，API origin 不匹配被 mock 拒绝，未接触真实服务；改为 CI 独立 5199 同源服务后全套通过。
- 最后成功浏览器命令如下；截图与 trace 位于 `apps/web/test-results/mobile-canvas-tools-verified/`。

```powershell
$env:WEB_BASE_URL = $null
$env:WEB_PORT = '5199'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:5199'
$env:CI = 'true'
pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts mobile-canvas-tools.spec.ts --workers=1 --reporter=line --trace=on --output=test-results/mobile-canvas-tools-verified
```

- 本次为局部低风险展示调整，提交并推送当前已配置上游，不发布版本 Tag；未部署生产环境。用户预存和并行工作改动仍留在工作区。
