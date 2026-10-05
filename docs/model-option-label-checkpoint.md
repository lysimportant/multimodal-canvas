# 模型下拉框重复分组文案修复

## 范围与基线（2026-10-05）

- P2：仅修复共享节点编辑器模型列表的重复分组文字。组标题保留；选项只显示模型名和必要状态；收起后保留「模型名 · 分组」。
- 起点：`main` / `origin/main`，`6bfa030`；Node `24.12.0`、pnpm `11.19.0`。已有 Skill 相关修改不属于本任务，不覆盖、不提交。
- 不改变模型/凭据身份、可用性、生成行为或持久化格式；不调用真实 Provider，不部署或迁移。
- 初始专项测试未能启动：项目内 `vitest` 命令缺失。普通 frozen install 未恢复 Web 依赖链接，使用 `pnpm --filter @multimodal-canvas/web --config.optimistic-repeat-install=false install --frozen-lockfile` 后恢复；随后全工作区 frozen install 通过。未修改清单或锁文件，未升级依赖。

## 验收与恢复点

- 已补快捷/完整编辑器回归：分组标题唯一、选项无重复小字、无障碍名称不重复、同名模型仍回传正确凭据、不触发生成。
- 已补待审核、暂不可用模型的状态与禁用回归。
- 修复 `buildModelOptions` 的说明字段：正常模型不再把分组名当说明，异常模型只显示状态；列表不再单独渲染分组后缀，选中值和无障碍名称仍保留分组。模型/凭据组合值及回调未改动。

## 验证结果

本轮日志与截图保存在忽略目录 `.local-tests/model-option-label-20261005/`。初始基线因依赖缺失未运行成功，不声明已完成红绿对照。

| 检查                                                            | 结果               | 证据                      |
| --------------------------------------------------------------- | ------------------ | ------------------------- |
| `NodeQuickEditor.test.tsx`、`CompactSelect.test.tsx`，单 worker | 2 文件、216 项通过 | `unit.log`                |
| `pnpm typecheck --force`                                        | 15/15，无缓存复用  | `typecheck.log`           |
| `pnpm lint --force`                                             | 9/9，无缓存复用    | `lint-fresh.log`          |
| `pnpm build --force --env-mode=loose`，`VITE_API_BASE_URL` 为空 | 9/9，无缓存复用    | `build.log`               |
| `pnpm test:runtime`                                             | 8/8                | `runtime.log`             |
| 隔离 Chromium，`node-parameter-overlays.spec.ts -g '模型'`      | 3/3                | `browser.log`、`browser/` |

- 浏览器使用独立 `127.0.0.1:5187`，接口全部由内存夹具拦截。快捷/完整编辑器分组各显示一次，切换模型后收起值仍含分组，长名称正常换行，控制台无错误且没有生成 POST。已检查两种编辑器的 1440×900 截图。
- 构建仍有大于 500 kB 的 chunk 提醒，不属于此次文字展示修复范围。未运行全仓业务测试、真实 Provider 或生产设施验收；上述通过结果仅覆盖实际执行项目。
- 当前阶段已完成代码、回归和构建；交付前检查差异并仅提交本任务四个文件。运行中的 Web 服务未部署，现有 Skill 修改继续保留。
