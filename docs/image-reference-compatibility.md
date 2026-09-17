# 图片引用与编辑兼容

2026-09-17，P1：图片生成根据输入选择接口，取消缺少自定义能力声明时的拦截。

后续兼容：声明缺省放行已扩展至其他节点，文字节点同时接通图片连线，见 [资源输入兼容](resource-input-compatibility.md)。本文保留图片专项的范围和验收记录。

## 基线与范围

- 起点：`codex/generate-to-new-node @ 213e9f8`，工作区干净；上游为 `origin/codex/generate-to-new-node`。
- 环境：Windows、Node v24.12.0、pnpm 11.19.0，使用已有锁文件和本地依赖。
- 修改前基线：API 图片编辑/资源提及预检 12 项、Provider 主测试文件 160 项通过。
- 验收：无声明的图片引用可以提交并发送 `edits`；明确不支持、无效图片、不可访问资产或版本仍拒绝；纯文生图保持 `generations`；失败不自动重发、不降级忽略图片。
- 仅调整图片生成和编辑。文字、音频、视频资源提及、多图编辑、蒙版与真实供应商新调用不在本次范围。

## 当前接口行为

图片生成节点没有图片输入时发送 `/v1/images/generations`；有一张不同的图片输入时发送 multipart `/v1/images/edits`。图片来源可以是原图连线，也可以是提示词中的图片资源引用。提示词引用保留资产 ID 和冻结版本，Worker 按该版本读取，Provider 将实际图片文件写入 `image` 字段。

本地内存运行模式同样在执行前读取冻结图片，使用项目与用户作用域重新检查资产权限和版本；不会获取任意外部 URL。取消、归档或版本不可用时停止发送。前端缓存图片已解码时直接结束加载状态，避免引用缩略图被加载遮罩长期覆盖。

模型目录中的 `mentionMediaTypes` 和 `imageEdit` 是可选信息。未声明时允许图片兼容路径；明确不支持、已声明的格式/参数/数量等限制仍校验。后续任务同样取消了其他节点缺少声明时的拦截；尚未接通的媒体输入仍按适配边界拒绝，不能把引用当作纯文字丢弃。

相同资产同一版本重复引用只上传一次；不同资产或不同版本仍是不同输入。本适配器维持一次最多一张不同原图，超出时明确失败。不能确定旧连线版本时，不猜测它与资源提及是同一版本。

供应商返回的拒绝或网络错误沿现有错误链路展示，不增加自动重发或回退文生图。源文件的内容不会写入持久化任务或请求说明，只保存来源身份和最终提示词。

## 兼容与回滚

没有数据库迁移、依赖变更或用户数据覆盖。运行快照增加可选 `nodeImageEditCapabilities`，分别保存各执行节点的已声明编辑限制；旧快照继续可读。旧的 `imageEditCapability` 仅作为原目标节点的兼容字段，不再传给其他模型。

前端、API 和 Worker 应一起更新。回滚时先停止新任务提交，等待或妥善保留在途任务，再回退本次代码提交；旧实现不支持图片资源提及，回滚后该入口会恢复旧限制。保留任务和资产数据，不需要回滚数据库。

## 执行检查点

- [x] 读取根目录计划、已有图片编辑文档和实现；确认错误发生在本地预检。
- [x] Provider 图片引用映射、API 缺声明兼容、每节点能力冻结和前端入口已实现。
- [x] 前端与 Worker 联合回归：引用固定版本、上传真实文件字节、任务存储不含二进制内容。
- [x] 最终 `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 通过。
- [x] API 711 项、Web 864 项、Provider 334 项、Worker 237 项、Domain 65 项通过；其余包与运行时测试通过。API 59 项、Worker 3 项因基础设施或外部条件跳过，不计作对应集成通过。
- [x] 浏览器 `smoke.spec.ts` 52 项通过，引用与原图缩略图均已解码，无页面或 console 错误。
- [x] API 本地内存执行到 NewApiProvider 的 10 项隔离 HTTP 测试通过：单次 multipart 请求、精确版本字节、个人资源权限、归档/删除/缺版本/撤销/取消零请求、400 不重发。网络由合成 fetch 接管，没有真实供应商调用。
- [x] 最终差异与敏感信息检查完成；本任务按当前上游 `origin/codex/generate-to-new-node` 交付，annotated Tag 为 `v2026.09.17-image-reference-compatibility`。提交 ID 与远端核验结果在最终交接中报告。

本记录仅用于本地与隔离验收；既有供应商图片编辑成功记录见 [图片编辑历史验收](image-edit-node-flow-plan.md)，不将其冒充本次新链路的真实生成证据。

最近完成的浏览器命令：`WEB_PORT=5186 pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts e2e/smoke.spec.ts --output=../../test-results/image-reference-browser --reporter=line`。浏览器日志为 `test-results/image-reference-browser.log`，四项门禁日志为 `test-results/image-reference-{lint,typecheck,test,build}.log`。

本地 `http://127.0.0.1:5184` 页面与 `http://127.0.0.1:19301/health` 均返回 200。现有 19301 是内存 Mock 预览实例，本次没有重启以免丢失当前画布；真实 API/Worker 部署需加载本次版本。
