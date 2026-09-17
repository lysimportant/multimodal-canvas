# 图片多参考图编辑

## 范围与基线

- P1：让图片节点主动添加的多张参考图进入同一次图片编辑请求，保留“新节点默认只引用当前结果”的行为。
- 分支 `codex/generate-to-new-node`，起点 `1896fd8`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0，使用仓库已有依赖；根目录无 README、AGENTS.md，采用会话规则与既有检查点。
- Provider 基线 344 项通过；Domain/API 能力相关基线分别 49、16 项通过。
- `docs/resource-input-compatibility.md` 是任务前已有用户修改，不覆盖、不纳入提交。
- 验收：多图按顺序上传、相同资产版本去重、不同版本保留、超限及任一非法图片在 POST 前失败；单图仍沿用原请求字段。
- 移动端、蒙版、真实供应商收费调用及生产部署不在本轮范围。

## 合同与兼容

依据 [OpenAI Images edits API](https://developers.openai.com/api/reference/resources/images/methods/edit) 和 [图像生成指南](https://developers.openai.com/api/docs/guides/image-generation)，GPT Image 编辑支持最多 16 张输入图，多图使用重复的 multipart `image[]` 文件字段。保留单图 `image` 字段；输出数量 `n` 仍为 1，与参考图数量分别处理。

模型目录可在 `capabilities.imageEdit` 中声明 `maxImages`（兼容 `max_images`），取该限制与 16 的较小值；未声明数量时，`gpt-image-*` 和 `chatgpt-image-latest` 默认 16，其余别名默认 1。自定义别名须明确声明多图上限。明确禁用编辑或非法数量声明仍阻止运行，不静默回退默认值。

原图先按连线顺序，再按提示词提及顺序排列，以资产 ID 和实际读取的冻结版本去重；未知版本不能凭相同 URL 或字节猜测合并。请求记录只保存最终发送的资源身份、版本与顺序，不保存图片字节。

可选冻结字段 `maxImages` 随运行快照保存，旧快照可继续读取；没有数据库迁移、新依赖或用户画布改写，不需要数据备份操作。API、Worker 和共享包应使用同一构建版本。回滚前停止新提交并保留或完成在途任务，再回退本次提交；旧版恢复单图限制，多图草稿与资产保留，不删除用户数据。

## 检查点

- [x] 核对官方多图合同，确认当前拦截来自 Provider 固定的单图上限。
- [x] Provider 新增回归先复现 7 项失败；实现多图文件字段与冻结版本去重后，主测试文件 203 项通过。
- [x] 模型目录能力解析、有效上限冻结及非法配置边界完成。
- [x] 本地 HTTP / Worker 到真实 Provider 的多图隔离回归完成：API 文件 11 项、Worker 文件 31 项通过，涵盖连线与提及混合输入。
- [x] 桌面 Web 主动添加多图、保存刷新与新节点继承隔离验收完成，7 项浏览器用例通过，无页面异常或 console.error。
- [x] 分叉节点卸载后清理临时置顶定时器，卸载回归先失败后修复，画布组件 56 项通过。
- [x] lint、typecheck、test、build 与最终差异检查完成，两个独立只读审查均未发现阻断问题。

整合后 `pnpm lint`、`pnpm typecheck`、`WEB_PORT=5173 pnpm test`、`pnpm build` 已各通过一轮。Domain 117、Provider 354、Worker 253、API 766、Web 928 项通过，其余包和运行时检查通过；API 59、Worker 3 项条件测试跳过，不算对应基础设施或真实供应商验收。构建保留已有的大于 500 kB chunk 提醒。

首轮根级类型检查遇到新增 Worker 测试夹具缺少 `referenceImage` 联合类型，已补齐并通过。首轮全量测试暴露既有分叉置顶计时器在卸载后回调，已在画布卸载时清除所有计时器并清空登记表。新增测试最初的假时钟影响后续用例，改为观察真实计时器的清除行为后，完整画布组件 56 项通过。

中断恢复后重新核对会话规则、检查点、Git 状态和用户文档 SHA256，恢复 `http://127.0.0.1:5187` 预览服务；定时器修复后的浏览器 7 项再次通过，日志 `test-results/image-multi-recovered-browser.log`。该浏览器证据只代表 Web 提交与持久化边界。API/Worker 测试调用实际 NewApiProvider 并拦截 fetch，不产生真实供应商请求。

最终 `pnpm lint`、`pnpm typecheck`、`WEB_PORT=5173 pnpm test`、`pnpm build` 全部通过，Web 增至 929 项通过，其余包通过数及条件跳过数同上。门禁日志分别为 `test-results/image-multi-lint-complete.log`、`test-results/image-multi-typecheck-complete.log`、`test-results/image-multi-test-verified.log`、`test-results/image-multi-build-final.log`。差异中未发现真实凭据或调试输出，用户原有文档校验值保持不变。Provider 基线与失败复现日志为 `test-results/image-multi-provider-baseline.log`、`test-results/image-multi-provider-before.log`。

## 复现与交付

```powershell
pnpm lint
pnpm typecheck
$env:WEB_PORT='5173'
pnpm test
pnpm build
$env:WEB_BASE_URL='http://127.0.0.1:5187'
pnpm --filter @multimodal-canvas/web exec playwright test e2e/node-generation-batch.spec.ts --workers=1
```

本任务涉及运行快照和 Provider 合同，按大改动交付：提交到 `codex/generate-to-new-node`，创建中文 annotated Tag `v2026.09.18-image-multi-reference`，推送 `origin` 同名上游与 Tag，并通过远端引用核验。实际提交 ID 和推送结果以交付消息为准；任务前已有的 `docs/resource-input-compatibility.md` 修改与本地验收产物不纳入提交。
