# 节点输入面板与 Skill 模型辅助升级

更新时间：2026-09-26。P1：PC Web 输入与 Skill 编辑。

## 基线与范围

- 分支 `codex/generate-to-new-node`，起点 `d8b87fe2475ee75e713fa7bd206300ae9e3c8dee`；上游 `origin/codex/generate-to-new-node`。Node `v24.12.0`、pnpm `11.19.0`，沿用本地依赖及锁文件。
- 无根 README 或项目内 AGENTS；遵守用户的全局规则，并读取既有 Skill、资源引用和画布交互检查点。
- 用户已有 `docs/resource-input-compatibility.md` 修改，SHA256 `56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`，不得覆盖或纳入提交。
- 修改前 Web 四组件基线：`WEB_PORT=5173` 下执行 `pnpm --filter @multimodal-canvas/web exec vitest run src/workspace/WorkflowCanvas.test.tsx src/workspace/NodeQuickEditor.test.tsx src/TextPromptEditor.test.tsx src/workspace/SkillWorkbench.test.tsx --maxWorkers=2 --minWorkers=1 --reporter=dot`，193/193 通过，日志 `.data/editor-skill-upgrade-baseline.log`。

## 验收目标

- [x] 空间允许时，节点输入面板显示宽度为节点的两倍；继续跟随画布缩放、手动节点调宽和边界避让，不改变节点外框。
- [x] 资源条删除动作只解除引用，所有原文字保留为普通文本，其余引用不变；键盘主动删除最后一处引用名字时，仍自动清理绑定。
- [x] Skill 工作台提供升级要求、文字模型选择、生成进度和可编辑预览，只有显式采用才更新草稿，保存才更新 Skill；内置技能通过复制创建自定义版本。
- [x] 未知请求保留原幂等身份，可恢复而不重新计费；源草稿变化、关闭重开和账号切换不能覆盖错误草稿。
- [x] 相关单测、lint、typecheck、test、build、PC 浏览器与 Docker 服务冒烟通过；检查最终 diff、原有修改和 Git 交付。

## 影响与回滚

- 不恢复历史丢图，不处理旧 unknown，不调整并发或账号权限，不做移动端改版，不修改真实画布、现有 Skill 或发起付费 Provider 验收。
- 沿用现有 Ant Design 与项目 UI 包，不引入组件库或其它依赖。新增一个内置“Skill 升级助手”，复用既有提示词优化 Run、文本模型、凭据、幂等、预览与持久化合同，不新建数据库表或迁移。
- 模型输出只进入预览，采用后仍是现有 instruction 字段；回滚应用版本不会删除自定义 Skill。旧版本不认识新增内置 Skill ID，回滚后需要重新选择有效技能；不删除历史 Run 或数据卷。
- 部署前读取在途队列并保留旧镜像，只更新必要应用服务；数据库、Redis、MinIO 不重建。

## 分工与检查点

- 子代理 1：WorkflowCanvas 输入面板几何与回归。
- 子代理 2：ResourceMentionEditor 解除绑定与保留文字回归。
- 子代理 3：domain 内置 Skill 升级助手及专项回归。
- 主代理：工作台 UI 与优化面板复用、应用接线、集成回归、文档及 Git 交付。各方写入文件互不重叠。
- 当前：三项源码、专项回归、PC 浏览器和 Docker 冒烟已完成；尚待最终 diff 审查、提交和推送。

## 实现阶段验证

- 双倍宽度代理：目标显示宽度改为节点边界宽度的两倍；保持画布 zoom、边界避让和节点外框不变，WorkflowCanvas 41/41 通过。
- 解除引用代理：资源条按 assetId 一次移除全部别名绑定，不剪除文字；同一次撤销恢复全部绑定。聚焦 11/11、相关四组件 213/213 通过。
- domain 新增内置 Skill 升级助手，不改原有 16 项定义或版本。专项 20/20、domain 全量 182/182 通过；本地 domain build 完成。
- 工作台复用原提示词优化面板的模型身份、幂等、待确认请求与恢复逻辑，新增内联呈现。模型输出先入可编辑预览，采用只改草稿，保存才写库；内置项采用后为未保存副本。
- Web 三组件合并回归 90/90 通过，日志 `.data/skill-authoring-web-regression.log`。两个初次 Modal 可见性断言改为等待可见后通过，新增停用助手不可提交回归；生产代码未为测试改变可见性。
- Node v24.12.0、pnpm 11.19.0，未增依赖。Vite 测试入口 http://127.0.0.1:5173，启动命令 `pnpm --filter @multimodal-canvas/web dev --host 127.0.0.1 --port 5173 --strictPort`。Docker 六服务已复核为 running/healthy。
- 所有 E2E 使用严格 Mock，不触发付费生成。

## 最终验证

更新时间：2026-09-26。

- `pnpm lint`：9/9 package 通过。
- `pnpm typecheck`：15/15 task 通过。
- `pnpm build`：9/9 package 构建通过；Vite 仅保留既有大 chunk 警告。
- `pnpm test:runtime`：8/8 通过。
- Web 全量单测：85 个文件、1257/1257 通过，使用 `--testTimeout=15000 --maxWorkers=2 --minWorkers=1`。
- API 全量单测：59 个文件、838 通过、85 跳过；Worker 全量单测：19 个文件、745 通过、26 跳过；均在受控超时下通过。
- PC Web E2E：3 个相关规格、串行 41/41 通过；并行初跑出现 4 个共享启动/状态竞争失败，4 个失败用例随后以单 worker 全部通过，最终串行全量 41/41 通过。
- Docker 六服务：api、web、worker、postgres、redis、minio 均为 `running/healthy`。
- 未进行真实 Provider 或付费模型验收；E2E 全部使用 Mock，不产生真实扣费。

## 交付注意

- `docs/resource-input-compatibility.md` 是用户已有修改，本轮保持原样，SHA256 仍为 `56B2C9D2BFB09DCC56720769B9CE12AED4877A29090DEDFBADD2F1FC5B3AA2A7`，不纳入本轮提交。
- 根目录 `pnpm test` 的并行默认超时在本机资源竞争时出现过误报；API、Worker、Web 已分别使用受控超时和串行/低并发方式复核通过，未发现本轮功能回归。
