# 手机底部胶囊检查点

## 2026-10-06 手机胶囊定位修复

- 目标：手机端胶囊相对画布水平居中，并从原 18px 底距下移至 `10px + safe-area-inset-bottom`；保留四个媒体入口、更多箭头、弹层内全部现有动作、主题和桌面布局。页面缩放锁与手机画布动态视口高度由主代理处理，本专项不修改 `index.css`。
- 根因：独立手机样式将 `.canvas-node-tools.is-mobile` 固定为 `left: 12px; transform: none`，导致宽度越大左偏越明显。320px 直接居中原 236px 胶囊还会与右下角缩放控件水平侵入约 3px，因此只在 `max-width: 340px` 将五个按钮从 40px 收至 38px，不删除功能。
- 实施：胶囊改为 `left: 50%` 和 `translateX(-50%)`；底距改为 `calc(10px + env(safe-area-inset-bottom, 0px))`；没有按测试分辨率增加 `max-height` 或额外 bottom 特例。主代理在 `canvas-page-zoom-lock.css` 的手机作用域让 `.app-shell` 使用 `100dvh`，并让 workspace/canvas 在剩余视口内收缩，消除了旧 560/700px 最小高度造成的短屏越界。
- 修前实测：320×640 胶囊 `(12,579)-(248,637)`、中心偏差 -30px；390×844 为 `(12,579)-(248,637)`、偏差 -65px；600×900 为 `(12,579)-(248,637)`、偏差 -170px。三档胶囊均为 236×58、画布底距 18px。
- 修后实测：320×640 画布 `(0,95)-(320,640)`，胶囊 `(47,574)-(273,630)`、226×56，缩放控件 `(275,539)-(305,625)`；390×844 胶囊 `(77,776)-(313,834)`；600×900 胶囊 `(182,832)-(418,890)`。三档中心偏差均为 0、画布底距均为 10px、胶囊与缩放控件重叠面积均为 0。
- E2E 增加 320/390/600 三档真实 DOMRect 断言：相对画布居中、画布底距 10px、胶囊底边处于实际视口内、与缩放控件不重叠；同时保存 `toolbar-geometry.json`、初始/展开截图和 trace。桌面断点改为按完整动作名称验证，包含现有“短视频复刻”；外部点击按 Popover 实际 bounds 选择画布外点。
- 证据目录：修前 `G:/multimodal-canvas/.local-tests/canvas-viewport-20261006/toolbar/before-measured/`；修后 `G:/multimodal-canvas/.local-tests/canvas-viewport-20261006/toolbar/after/`；最后两条契约修正的 trace 位于 `toolbar/targeted-after/`。所有输出均在仓库根 `.local-tests`，不在 Vite root 下。
- 本专项最终验证：`CanvasNodeToolbar.mobile.test.tsx` 4/4 通过；位置通过真实浏览器矩形覆盖，未保留仅镜像 CSS 字符串的重复单测。修正外部点击坐标和桌面动作清单假设后，完整手机工具 Playwright 10/10 通过，最终证据位于 `../toolbar-final/`（相对 toolbar 目录）。加上主代理缩放与工作区验收，共 281 项单测、33 项浏览器用例、8 项运行产物测试通过；lint/typecheck/build 均成功。
- 隔离边界：Web 使用未占用端口 5201，`WEB_PORT` 与 `VITE_API_BASE_URL` 同为 `http://127.0.0.1:5201`，沿用 isolated fixture；未连接真实 API、未发起生成或付费请求、未部署、未提交或推送。
- 未验收边界：本轮是 Chromium 模拟视口与 CDP/Playwright 证据，不等于真实 iPhone/Android、浏览器地址栏动态收放、横竖屏切换或设备 safe-area 的外部验收；真实设备仍需独立确认。

## 原胶囊功能历史记录

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
