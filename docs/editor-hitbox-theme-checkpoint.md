# 参数选项、引用按钮与设置表格修复检查点

## 范围与基线

- 日期：2026-10-04；P1，修复用户明确指出的三处 PC UI，不扩展功能。
- 基线：`main @ d79650a`，上游 `origin/main`，工作区初始干净；Node `v24.12.0`、pnpm `11.19.0`，本地依赖已安装。
- 需求澄清：上传引用、添加参考资料、拍照三个功能按钮均只能点到自身才触发；包含“添加引用”，不能整行点击触发，也不能向父级冒泡误触发。
- 4K 要与 1K/2K/3K 等宽或四项同排；项目内设置分组表头、正文和代码文字适配现有主题，不改变表格布局与账号逻辑。
- 不做：不改 Provider/API/数据库/参数存储协议，不新增依赖，不修改已有 Skill，不触及真实项目数据、不请求付费模型，不默认部署。
- 影响与回滚：仅前端布局/DOM语义/主题样式和对应测试；撤销本次提交即可回滚，无数据迁移。各文件按模块分工，主代理整合与提交；按跨模块变更保守附中文 annotated Tag。

## 根因与阶段

- [x] 阅读 AGENTS、TODO、现有节点与设置模块、测试和此前引用功能检查点。
- [x] 点击根因：`NodeQuickEditor` 的提示词复合区被 `label` 包裹，其中包含上传/资料/相机多个按钮；浏览器原生 label activation 将空白点击转发给首个可标记控件，资源条已有 stopPropagation 也无法取消此默认动作。改为无关联容器并保留 textarea 的 aria-label。
- [x] 4K 初步原因：短枚举 flex-grow 为 1，三列换行后剩余单项扩张整行。设置配色初步原因：公共表格规则仍使用浅色硬编码，独立设置页已有主题覆盖但项目弹窗未覆盖。
- [x] 修改前定向单测与红灯回归；三个模块的最小补丁。
- [x] lint/typecheck/test/build 与本轮 PC 隔离浏览器、截图、控制台检查；额外旧键盘用例失败单列如下。
- [x] 完整 diff、敏感内容与 Git 状态检查；提交、Tag 与远端引用按下方交付方式核验。

证据目录：`.data/editor-hitbox-theme-20261004/`。测试使用目录内临时文件夹，`WEB_PORT=5173`、`VITE_API_BASE_URL=http://localhost:3000`，不读取用户真实配置。

## 本轮恢复与按钮红绿回归

- 已重新读取 AGENTS、检查点、Git 状态；两个子代理恢复原文件分工，没有扩大到旧 Skill 任务。
- 修改前：三个编辑器测试文件共 277 项通过；证据为 `baseline-editor.log`。
- 新增快捷/完整编辑器空白点击用例先失败：点击行空白与提示词容器会调用文件选择器两次；证据为 `hitbox-red.log`。
- 将提示词区域外层 `label` 改为 `div`，保留 class、textarea 的 aria-label 和资源条已有事件隔离；不改三个功能的业务处理。
- 修改后新增两项通过，并覆盖上传、拍照、添加资料各自触发及无生成；证据为 `hitbox-green.log`。
- 节点/共享编辑器、App 和画布定向回归 433 项通过；三个补丁已合并，使用本轮构建产物完成隔离浏览器验证。

## 最终代码与验证

- `NodeQuickEditor.tsx`：复合提示词容器改用 `div`，保留输入框名称、引用条事件隔离、上传/参考资料/相机业务处理。
- `node-quick-editor.css`：短枚举选项的 flex-grow 改为 0，4K 换行后仍与其他三档等宽；视频短枚举、长比例及模型名保留原规则。
- `index.css`：公共分组表格的底色、表头、正文、code 与边框使用既有主题变量；项目弹窗和独立设置页一致，不改布局或账号逻辑。
- 主题新增回归修改前 3 失败、6 通过，修复后 9 项通过；设置组件及参数样式一起运行共 17 项通过。证据：`settings-red.log`、`layout-green.log`。
- `pnpm lint`、`pnpm typecheck`、`pnpm build` 均通过；本次 Web 重新检查与构建，未变化共享包有 Turbo 缓存命中，不把这些缓存描述为重新执行。
- 全仓测试按包顺序调用本地 Vitest，均限制 2 worker、1 minWorker，以避免 Windows 高并发争抢；等价覆盖根 test 的 runtime 和九个包，证据 `all-tests.log`：
  - `node --test scripts/build-runtime.test.mjs`：8 项通过。
  - Web：125 文件、2312 项通过。
  - API：67 文件通过、8 文件跳过；Worker：21 文件通过、6 文件跳过。外部设施跳过不作为集成验收。
  - credential-crypto、domain、execution、observability、providers、ui 六包全部通过。
  - 各包运行命令：在包目录执行 `node ./node_modules/vitest/vitest.mjs run --maxWorkers=2 --minWorkers=1 --passWithNoTests`；无缓存复用、无新增依赖。
- 浏览器使用本轮 `web-dist` 冻结构建，隔离地址 `http://127.0.0.1:5198`、单 worker、合成账号/项目/相机、全部业务接口 Mock，不碰真实数据或设备，不请求生成：
  - `browser-initial.log`：6 项通过。1440/1366 PC，快捷/完整图片四档等宽及保存 4K；快捷/完整编辑器两个按钮间隙、行尾空白和三个功能按钮分别验收。
  - `browser-regression.log`：15 项通过。视频时长、短清晰度、长比例/模型名称；连续参考、四媒体节点相机引用、source 节点、嵌套窗口关闭/轨道释放、照片版本保存与重载。
  - `browser-settings.log`：新增 10 项主题回归通过。五主题分别覆盖项目弹窗和独立设置页，实际 computed style 与主题 token 一致、无写请求、无控制台或页面异常。
  - 已实际查看 4K、完整编辑器、dark/eye-care 项目表格和 dark 独立页面截图；节点外框尺寸未变化。

## 未扩大修复的存量事项

- 同时执行 `settings-page-layout.spec.ts` 时，原有 1440/1024/390 三项键盘导航用例在 `ArrowRight` 后期望“节点默认”获焦处失败。新增十项主题用例没有失败。
- 当前 `SettingsPanel` 直接使用 Ant Design `Tabs`，`tabPlacement="start"` 为纵向；已安装组件实现要求 `ArrowDown` 移焦后 `Enter`/`Space` 激活。旧用例仍假设右方向键直接切换内容。
- `git show c113fd9` 证实此前组件迁移替换了旧导航而未更新该文件的键盘断言；基线 `d79650a` 的原测试对应步骤与本轮完全相同。本轮未改 Tabs、SettingsPanel 或依赖锁文件。未将这三项计为通过，也不为本次配色需求扩展键盘实现。
- 存量 Vite 大 chunk 警告保留；真实 Provider、生产部署、外部设施集成不属于本次验收。
- 未重启或部署用户正在使用的正式站点。隔离预览仅用于本次验证。

## 交付检查

- 三处生产改动和对应测试已检查；敏感模式扫描未发现新增密钥、私钥或 debug 日志；无用户原有改动、依赖变化或数据迁移。
- 推送前远端 `origin/main` 为基线 `d79650a`，与本地上游一致。按当前上游只推 GitHub origin，不擅自推无关远端。
- 最后验证点：全仓包测试成功、31 项本轮浏览器验收通过，旧键盘失败已单列。交付使用中文提交与 annotated Tag `v2026.10.04-editor-hitbox-theme`，提交/推送的实际结果以 Git 引用核验及最终回报为准，不以本文代替远端证据。
