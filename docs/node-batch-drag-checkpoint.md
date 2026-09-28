# 折叠图片批次拖动跟随占位修复

## 范围与基线

- P1：修复 PC Web 拖动图片生成节点时后方空卡滞后跟随；保留批次折叠/展开和原有数据。
- 分支 `codex/generate-to-new-node`，起点 `2140ba4`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0；依赖已安装，无新增或升级。根目录没有 README/AGENTS.md，采用会话规则，已读取 `next.md`、`TODO-CONSOLIDATED.md` 与批次交互文档。
- 用户原有 `docs/resource-input-compatibility.md` 删除保持不动，不纳入本次提交。
- 定向基线：AssetNode、WorkflowCanvas、generation-batch-view 三文件 90/90 项通过。初查六个 Docker 服务均 healthy。

## 定位与验收

现场根节点有图片、第二个批次成员为空，两者宽高相同。后卡是既有真实成员，投影在根节点右下方 10px，不是拖动时新建的节点。现有拖动规则只取消 React Flow 本地 `.dragging` 节点的 220ms 位移动画；不可独立拖动的后卡不会获得该类，因此仍有延迟。

- [x] 只读检查用户页面及现有实现，不发生成请求，不保存用户节点变更。
- [x] 记录分支、用户改动、版本、依赖和定向测试基线。
- [x] 用“有图片根节点 + 空成员”浏览器回归复现拖动中的后卡位移动画。
- [x] 仅展示层同步批次拖动样式；停止后恢复展开/收起动画，不影响无关批次。
- [x] 验证连续拖动、松手、展开、保存刷新、尺寸和布局保持；运行 lint/typecheck/test/build。
- [x] 更新本地 Web，复查浏览器、控制台及服务健康；完成提交前差异检查。

范围外：不删除空成员、不修改生成/API/Provider 行为、不迁移画布结构、不更改节点尺寸、不做手机适配。测试使用合成项目和仓库位图，不调用收费供应商。若需要回滚，只恢复本轮 Web 代码或旧 Web 镜像，不改数据卷。

旧 Docker Web 在 1920/1366 两个宽度均复现后卡 `transition-duration: 0.22s`，根节点已为 `0s`；同步登录 Mock 后重跑 1366，仍精确命中相同失败。证据在 `.local-tests/node-batch-drag-before-clean.json` 与 `test-results/node-batch-drag-before-clean/`。

新增展示状态回归后定向单测 11/11 通过，无跳过，覆盖停止清理、展开独立和批次隔离。E2E 独立严格 TypeScript 检查通过。首轮开发浏览器 6/7 通过，首例在 Vite 冷启动“正在加载工作区”阶段超过原 5 秒准备时限，未执行拖动断言；现已显式等待工作区可见，后续位移与动画断言未放宽。

开发浏览器最终 7/7 通过（零重试、跳过和 flaky），覆盖 1920/1366 两个桌面宽度的空成员连续拖动、恢复过渡、展开与保存刷新，及既有多结果交互和两份生成成功/400/断网回归。批次场景没有页面异常、console error 或未声明请求；生成失败场景只允许预期的合成网络错误。证据在 `.local-tests/node-batch-drag-browser-dev-final.json`，截图在 `test-results/node-batch-drag-dev-final/`。

`pnpm lint`、`pnpm typecheck`、`pnpm build` 及 E2E 独立严格 TypeScript 检查均通过；构建保留既有约 1.90 MB 主包警告，不在本轮拆包。生产源码 SHA-256 已记录，后续复查不会把运行中的代码与测试版本混用。

已保留回滚镜像 `multimodal-canvas-web:before-node-batch-drag-20260928`，镜像、运行容器的入口文件、JS、CSS 与 Caddyfile 校验和一致。Docker 使用 OCI index ID 与容器配置 digest 两种标识，不能直接用容器配置 digest 作为可标记的镜像 ID。部署基线在 `.local-tests/node-batch-drag-deploy-baseline.json`；只计划替换 Web，不重启 API、Worker 或数据服务。

## 最终验证与本地交付

- Web 全量 87 个文件、1313/1313 项通过，零失败、跳过和 todo，耗时 371.56 秒；JSON 证据 `.local-tests/node-batch-drag-web-full.json`。
- `pnpm test:runtime` 8/8 通过，零跳过；`pnpm lint`、`pnpm typecheck`、`pnpm build` 及 E2E 严格类型检查通过。未变更 API/Worker/Provider，不把上一任务的后端测试记作本轮新执行。
- `docker compose build web` 与 `docker compose up -d --no-deps --wait --wait-timeout 120 web` 完成；只替换 Web，其他五个服务容器 ID 未变、六服务均 healthy。健康检查与用户项目 SPA 均 HTTP 200。
- 运行容器的入口文件、JS、CSS、Caddyfile 与待部署镜像校验和一致。当前镜像 OCI index ID 为 `sha256:3facf7b8b1d48fb668ac05425bef39a0c3aa477078fa8a1c7536313089ff726f`；回滚镜像和数据卷保留。
- 部署后同样 7/7 浏览器回归通过，零重试、跳过和 flaky，耗时 25.1 秒。报告 `.local-tests/node-batch-drag-browser-deployed.json`，截图 `test-results/node-batch-drag-deployed/`。实际用户项目刷新后正常恢复，浏览器无 console error；没有保存或移动用户节点。
- 完整任务差异、敏感字面量与 `git diff --check` 检查通过；测试前后两处生产源码 SHA-256 未变。临时验证均使用合成数据，不发收费创建请求，不删除历史任务或节点。

本轮是小型局部展示修复，按现有上游 `origin/codex/generate-to-new-node` 提交推送，不创建新版本 Tag。Git 提交及远端一致性以交接时的引用核验为准；原有文档删除不纳入提交。最近成功命令为部署后浏览器回归，上述实现和本地验收均已完成。
