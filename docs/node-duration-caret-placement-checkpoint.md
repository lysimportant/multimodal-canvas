# 节点时长浮层、光标与边界交互检查点

更新时间：2026-09-27。任务等级 P1，仅 PC Web 节点编辑交互。

## 基线与范围

- 分支 `codex/generate-to-new-node`，恢复起点 `3f8c5dd`；该提交已推送，不重写历史。
- Node `v24.12.0`、pnpm `11.19.0`，依赖已安装，不增依赖。
- 原有用户修改 `docs/resource-input-compatibility.md` 不编辑、不提交。
- 不改 Provider 合同、模型默认值、数据库、资源内容；不执行付费生成。
- 仓库根目录无 README/AGENTS 文件；已读取用户提供的 AGENTS 规则、TODO-CONSOLIDATED 和现有节点编辑/Docker 文档。

## 验收结论

- [x] 秒数在 hover 卡片内展示 5/10/15/30 与自定义输入；支持键盘、连续输入、旧值回显，受模型限制的值不可绕过校验。
- [x] 节点文字光标实际可见地加宽；保留选区、中文组合输入、换行、滚动和缩放。
- [x] 输入面板触边后，节点继续移动自身对应轴尺寸 25% 才换边；途中不缩成不可用尺寸，反向移动需对侧再次触边后才允许回切，避免抖动。
- [x] 专项及低并发 Web 全量测试、lint、typecheck、build、真实 PC 浏览器冒烟完成。
- [x] Docker Web 已重建，保留所有数据卷/后台服务；项目与 6 项资源、4 个节点正常回显。
- [x] 审查 diff、创建补充提交及 Tag、核验 upstream 推送。

## 实现记录

### 视频时长

- `VideoDurationControl` 使用 Ant Design `Popover`；纯 hover 展开，点击或键盘打开后固定，Escape 只关闭时长卡片。
- 卡片快捷项固定为 5、10、15、30；模型合同/目录枚举会禁用不支持项，不把快捷项写入 Provider 合同之外。
- 自定义输入与快捷项同卡片展示，支持清空、中间值、连续键入、IME/Tab；旧节点非快捷值回显为“自定义 · N 秒”。
- 未改变视频默认时长、自动时长 `-1` 和已有参数持久化语义。

### 光标

- 浏览器实测 `CSS.supports('caret-width', '2px') === false`，因此移除无效 CSS 属性。
- 新增 `PromptCaret` 测量层，仅在节点编辑器内绘制 2 屏幕像素光标；原生 textarea 继续负责输入、选区和 IME，选择文字或组合输入时交回原生光标。
- 隔离真实组件页面测得光标宽度约 `1.994px`；完整编辑器选择全部文字后增强光标隐藏，原生选区保持 `[0, 29]`。

### 贴边换位

- 新增纯布局模块 `quick-editor-layout.ts`，按面板实际外边缘触边，触边后超过节点对应轴尺寸 25% 才换边。
- 等待换边时只钳制位置，不把面板压成 1px；自然内容高度变化会重新测量。
- 换边后的反向移动不会按累计路径长度立即回切；只有对侧重新触边并超过 25% 才回切。

## 验证记录

- 专项回归：7 个 Web 测试文件、289/289 通过；其中 NodeQuickEditor 141/141、WorkflowCanvas + quick-editor-layout 63/63、PromptCaret 8/8、ResourceMentionEditor + TextPromptEditor 61/61。
- Web 全量：87 个文件、1302/1302 通过；串行命令 `pnpm --filter @multimodal-canvas/web exec vitest run --passWithNoTests --testTimeout=15000 --maxWorkers=1 --minWorkers=1 --reporter=dot`。
- `pnpm lint`：9/9 package 通过。
- `pnpm --filter @multimodal-canvas/web typecheck`：通过。
- `pnpm --filter @multimodal-canvas/web build`：通过；保留既有大 chunk 警告，主 JS 约 1.90 MB。
- `pnpm test:runtime`：8/8 通过。
- Docker Build 首次因启动环境未注入 `MC_NEW_API_ISSUER` 失败；未改代码、未删除卷。随后从已有 `.env` 仅在当前进程恢复 `MC_NEW_API_*` 配置并执行 `-Action Start -NoBrowser`，API/Web/Worker/Postgres/Redis/MinIO 均 healthy。
- HTTP `/health` 与项目页均返回 200；Docker 页面实际回显 `全部资源（6）`、4 个节点和原有图片结果。
- Docker 页面实际打开时长卡片，看到 5/10/15/30 与自定义输入；当前 `minimax-h3` 合同下 30 秒正确禁用。真实节点输入框测得增强光标 `1.994px`。
- 全部验证均未触发 Provider 请求或付费生成。

## 交付边界

- `docs/resource-input-compatibility.md` 是用户已有修改，本轮保持原样，不纳入提交。
- 本轮不交付真实 Provider 合同或生产外部验收；仅交付 PC Web UI、专项测试与本地 Docker 冒烟证据。
