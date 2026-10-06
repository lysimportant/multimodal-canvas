# 画布页面倍率与手机胶囊检查点

## 本轮范围（2026-10-06）

- P1：画布挂载时阻止浏览器页面缩放，保留 React Flow 内部双指、滚轮及按钮缩放；手机胶囊居中并稍微下移。
- 起点：干净的 main @ 10daabc，上游 origin/main；Node v24.12.0、pnpm 11.19.0，项目依赖齐全。
- 验收：320/390px 触屏手势不改变页面倍率，画布倍率可以改变；资源抽屉单指滚动和输入聚焦可用；320/390/600px 胶囊无水平偏移、无控件重叠，桌面保持原布局。
- 不做：SEO 后续扩展、节点数据/尺寸、API、Provider、依赖升级、真实用户数据写入或生产部署。
- 无公开接口、数据格式或迁移变更。回退本轮提交可恢复之前交互，不需数据库操作。

## 原因与实现

- 原先只有 React onWheelCapture 取消 Ctrl 滚轮的逻辑，未覆盖页面双指、Safari gesture 或浏览器缩放快捷键；原测试只断言调用 preventDefault，未断言事件实际取消。
- 新增画布挂载期 hook：使用原生非被动捕获监听取消页面默认缩放，但不停止传播，让 React Flow 继续处理缩放；卸载时恢复原 viewport、根类名并移除监听。
- 根元素只在画布期间禁用原生 pinch，保留单指平移；触屏输入最小 16px，避免小字号聚焦导致页面放大。首页与分享页不修改静态 viewport。
- 手机工作区使用 100dvh 和可收缩的画布容器，消除旧 560/700px 最小高度造成的工具栏越界；胶囊使用真实画布底边定位。
- 明确启用 React Flow zoomOnPinch。所有监听一次注册，没有新增节点状态订阅或拖动渲染广播。
- 胶囊位置与测量记录见 mobile-canvas-tools-checkpoint.md。

## 当前检查点

- 基线：原手机胶囊与响应式单测 20/20 通过。
- 缩放 hook 单测 8/8、WorkflowCanvas 单测 93/93 通过；包含 StrictMode 挂载/清理、单指/多指区别、事件传播和快捷键边界。
- 初轮 Chromium 原生手势通过 320/390 双指缩放、胶囊上双指不放大、缩放按钮与桌面 Ctrl 滚轮；页面 scale 均为 1。资源滚动测试的输入速度过快，同帧触点被合并；改为每步 30ms 原生手势后两尺寸均通过，没有为通过测试改动产品逻辑。
- 完成：相关 Web 单测 281/281、运行产物测试 8/8；Chromium 33/33（缩放 5、手机工作区 18、胶囊 10）。主代理已目视复核 320/390 手机与 1440 桌面截图，三档手机胶囊中心偏差为 0、底距 10px、与缩放控件重叠面积为 0。
- pnpm lint、pnpm typecheck、pnpm build 分别 9/9、15/15、9/9 任务成功；本轮变更的 Web 均实际执行，未变更包有 Turbo 缓存命中。保留原大 chunk 构建警告。未重跑无关后端设施测试或全部历史 E2E。
- 提交前检查：本轮仅前端交互、样式、回归与检查点，无依赖/配置/密钥改动。按跨页面输入处理及手机布局的影响范围保守采用附注 Tag 交付；推送 main 到 origin，上线仍需单独部署。
- 证据：.local-tests/canvas-viewport-20261006/。测试使用独立本地端口与拒绝未声明请求的内存夹具，不请求真实生成服务。

复验命令（PowerShell，仓库根目录）：

```powershell
$env:WEB_BASE_URL = $null
$env:WEB_PORT = '5200'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:5200'
$env:CI = 'true'
pnpm --filter @multimodal-canvas/web exec playwright test canvas-page-zoom.spec.ts mobile-workspace-chrome.spec.ts mobile-canvas-tools.spec.ts --workers=1 --reporter=line --output=../../.local-tests/canvas-viewport-20261006/recheck
```

## 验收边界

- 当前为 Chromium 触屏模拟与桌面验证，不等同于 iOS Safari、Android QQ 内置浏览器真机验收。
- 网页不能控制用户从浏览器菜单或操作系统辅助功能强制放大；这里限制的是画布页内常规手势与快捷键，不修改用户浏览器设置。
