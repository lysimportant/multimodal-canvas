# 节点画布优化执行检查点

## 基线

- 2026-09-12，`main @ 3d085fe`，上游 `origin/main`；Node v24.12.0、pnpm 11.19.0。
- 起始已跟踪文件干净；保留 5 个用户未跟踪文件：三个 `.codex-patch*.py`、`compose-config.yaml`、`compose.yaml.full`。
- 目标与验收见[原画布优化计划](https://github.com/lysimportant/multimodal-canvas/blob/c750763925a2fd63988c8a84402dc982a6ec460a/%E8%8A%82%E7%82%B9%E7%94%BB%E5%B8%83_%E4%BC%98%E5%8C%96%E6%8F%90%E7%A4%BA%E8%AF%8D_v2.md)。不操作生产、不发起收费 Provider 请求。

## 阶段

- [x] 修订执行计划：签名地址取证、历史尺寸、手动输出持久化、返回来源独立、衍生预览和边界验收。
- [x] P0 回显请求复现与修复：Mock 签名响应相对地址被请求到 Web 5193，修正为 API 3000 后 Chromium 专项通过；图片尺寸未改变。签名失败显式错误，不预下载完整媒体。
- [x] P1 节点外壳、新建尺寸、参数交互。
- [x] P1 手动上传、文本编辑、下游与保存契约、资源归档。
- [x] P2 资源页预览、来源项目与返回入口。
- [x] 全量验证、浏览器冒烟、diff 检查和 Git 交付。

## 当前状态

Web 基线 47 文件 532 tests 通过；最终 Web 单元测试 544 passed。Domain 25、API 619、Worker 专项 48 tests 通过，根级 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过。Playwright 全量 57 passed，包含手动输出、上传竞态、资源衍生预览、导航保存、六主题与响应式冒烟。未发起真实 Provider 请求；构建仅提示主包超过 500 kB，后续可按需拆分动态模块。

## 复核修正（2026-09-12）

对照 [原画布优化计划](https://github.com/lysimportant/multimodal-canvas/blob/c750763925a2fd63988c8a84402dc982a6ec460a/%E8%8A%82%E7%82%B9%E7%94%BB%E5%B8%83_%E4%BC%98%E5%8C%96%E6%8F%90%E7%A4%BA%E8%AF%8D_v2.md) 与后续登录/资源/永久删除改动做了逐项复核。已修正：

- 节点悬停/选中不再使用 2px/3px 光晕或 `0 8px 22px` 重阴影；选中只改边框色。
- `index.css` 残留的旧白卡片描边、生成节点 min-height 和 28×28 音频预览限制。
- 账户菜单新标签会先保存画布，保存失败关闭空白标签并留在原画布。

## 兼容性与回滚

不修改数据库结构；若添加可选手动输出字段，旧画布缺省行为保持原样。手动内容保存成独立资源，不覆盖旧资产。回滚代码前应导出包含手动输出的画布并保留资产引用；旧代码不识别手动输出优先级，不能声称降级后显示完全一致。最终以实现及测试更新此节。
