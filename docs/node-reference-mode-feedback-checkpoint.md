# 添加参考资料模式与资源搜索反馈

日期：2026-10-06。P1，PC Web 局部交互调整。

## 基线与验收范围

- 起点 `main @ 8e42fee`，上游 `origin/main`，工作区干净；Node `v24.12.0`、pnpm `11.19.0`，本地依赖齐全。
- 修改前 `pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/WorkflowCanvas.test.tsx`：93/93 通过。
- 验收：进入添加模式显示画布蒙版；单击空白弹出可继续或退出的 Message；平移不误弹；引用成功有提示；退出、Esc、目标切换后清理浮层；无节点引用时 `@` 默认项目资源，搜索面板收窄。
- 范围仅限 Web 展示与交互，沿用现有原子引用动作和持久化合同，不修改节点尺寸、数据库或供应商请求，不新增依赖。浏览器验收使用合成项目及 API Mock。

## 当前实现与恢复位置

- `WorkflowCanvas.tsx` 和 `node-reference-pick.css` 添加不接收指针的蒙版，以及 Ant Design Message。空白单击沿用 React Flow 排除平移后的 `onPaneClick`；连续选择仍锁定原目标。
- 常驻选择提示使用固定 key，成功/失败使用自动 key，并限制同时展示一条；每次添加结果重新计时，常驻选择不继承上一条消息的倒计时。退出和目标切换清理本组件消息。
- `ResourceMentionEditor.tsx` 按完整节点引用池选择默认 Tab，不把筛选无结果误判为没有引用。搜索弹层从 400px 收为 380px，搜索输入行居中并在两侧各缩进 10px。
- 定向回归覆盖连续成功及重新计时、失败保留目标、重复空白点击、继续添加、退出、Esc 和目标切换。Web 全量完成，首轮两项测试已修正后补验，结果如下。
- 本轮功能与验收已完成，交付为 Web 局部小改动，提交并推送 `origin/main`；不涉及迁移或版本发布。验证日志和截图写入 `.local-tests/reference-mode/`，不纳入 Git。

## 验证结果

已完成：模式专项 10/10、资源编辑器 89/89、运行产物 8/8；非 Web 全量 13 个任务、lint 9 个任务、typecheck 15 个任务、build 9 个任务均重新执行并通过，构建保留既有 chunk 体积提示。

非 Web 测试：API 1196 通过、101 skip、5 TODO；Worker 784 通过、28 skip；Provider 768、domain 379、execution 43、observability 21、UI 16、credential 7 通过。设施跳过与 TODO 不算验收通过。

首次非 Web Vitest 无法在系统 TEMP 创建目录（EPERM），改用 `.local-tests/reference-mode/tmp` 的进程级 TEMP/TMP 后重跑通过，未改系统或用户配置。API 默认环境显式 `WEB_PORT=5173`，Web 单测显式 `VITE_API_BASE_URL=http://localhost:3000`。

Web 全量执行 132 文件、2434 项，首轮 2432 通过、2 失败：`canvas-editor.test.tsx` 零引用场景的旧默认节点断言，以及新消息计时用例混合虚拟时钟与 RAF 导致的时序失败。已将前者改为项目默认，后者改为真实计时并验证重新倒计时及自动关闭；画布组件完整重跑 96/96，资源保存用例定向重跑 1/1 通过。没有把首轮结果写成全量零失败，也未重复执行已通过的 130 个文件。

PC 浏览器最终 4/4 通过，命令如下，测试使用独立 Vite 端口 5187，结束后关闭：

```powershell
$env:WEB_PORT='5187'
pnpm --filter @multimodal-canvas/web exec playwright test e2e/resource-mention-picker.spec.ts --grep "1440 PC 节点 picker|1024 PC 放大 Dialog|PC 连续添加参考|零引用默认项目资源" --workers=1
```

覆盖 380px 快捷/Dialog 搜索弹层、360px 居中搜索行、默认范围、真实 pane 平移不弹提示、继续添加、成功后空白点击、退出和 Esc 清理，以及原引用排序/保存/重载。所有用例检查控制台错误为空且未提交真实生成请求。主代理目视检查模式提醒、添加成功和搜索面板截图，无遮挡或溢出；截图另存 `.local-tests/reference-mode/reference-pick-mode-guidance.png`、`reference-pick-added.png`、`reference-picker-combined.png`。

浏览器初轮曾受并行编辑的 HMR 导航和消息离场动画重复 DOM 影响，已冻结文件，并等待当前可见消息收敛为一条后断言；最终 4 项合并运行全部通过。最终差异、格式及新增调试/密钥内容检查通过。Mock 不代表真实供应商或生产环境验收。
