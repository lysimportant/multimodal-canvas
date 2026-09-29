# 图片清晰度与节点参数修复检查点

## 基线与边界

本地时间 2026-09-30（Asia/Shanghai），P1：图片所选清晰度必须变成明确的输出像素尺寸，其他节点参数不能串到相邻节点或被静默忽略。

- 分支 `codex/generate-to-new-node`，起点 `b9f89f464e3c95d655cd389ce5147e6b35365d66`，上游 `origin/codex/generate-to-new-node`。
- Node v24.12.0、pnpm 11.19.0、Git 2.53.0.windows.1；沿用项目依赖和锁文件。
- 原有 `docs/resource-input-compatibility.md` 删除保持不动、不暂存。
- 根目录、祖先及模块未发现 AGENTS；无根 README，已读当前 TODO 和图片接口、资源参数、连线修复检查点。
- 修改前 Domain 182 项、Provider 530 项通过。六个本地服务均 healthy。
- 不重放历史任务，不触发真实收费生成，不回写旧 Run 或图片，不安装无关依赖。
- 按跨模块较大变更验证；无数据库迁移。回滚只替换应用镜像，不覆盖画布、Run 或资产。

## 已确认现场

- 精确模型 `gpt-image-2.5-sunburst`；本机同步目录声明 `openai-images`，没有额外尺寸限制。目录声明不能证明网关实际受理所有尺寸。
- 目标“修改 图片生成节点 8 2”的节点、历史运行和冻结快照均为 `quality: "4k"`、`aspectRatio: "21:9"`，不能误认为用户举例的 9:16 竖图。
- 请求记录为一次 `POST /images/edits#1`，一张冻结参考图，发送状态 sent。
- 归档元数据和原始 PNG IHDR（只读前 32 字节）均为 **1024×1024**，不是缩略图问题。
- 旧代码序列化 `quality: "4k"` 和 `aspect_ratio: "21:9"`，未产生 `size`。历史系统不保存完整原始 HTTP body，此判断来自冻结参数与对应代码，不冒充网络抓包。
- 初始 revision 594、14 节点、8 连线、26 Run、0 在途；脱敏基线保存在忽略的 `.local-tests/image-output-parameters/`。

## 已完成实现

- [x] Domain 共享解析器把清晰度与比例转成 `size`；4K 9:16 为 2160×3840、21:9 为 3840×1648，短边按 16 px 对齐。
- [x] 文生图 JSON 与图生图 multipart 共用转换，删除应用别名，原生 quality 独立保留；不自动缩小，不触发重复创建。
- [x] 已知精确模型按公开的边长、总像素和固定尺寸限制预检；未知别名不按名称前缀猜能力。编辑目录限制仍约束转换后的字段。
- [x] Web 显示“请求像素”，区分清晰度与生成质量；旧 K-quality 只读兼容，只有明确编辑时迁移。非法组合明确阻止生成。
- [x] API 创建前校验执行闭包，根提交参数覆盖保存值；Worker 上游只用自身冻结参数，保留 0/false，旧 Run 不重新冻结或改指纹。
- [x] 文字不再隐式补 high，别名冲突、多候选、流式输出明确拒绝；音频正文冲突和不支持音色提前提示。视频序列化合同未改，补参数边界回归。
- [x] 红绿回归、完整包级检查、隔离集成、两种桌面关键流程及截图检查。
- [x] 仅更新本机三应用，确认健康、镜像身份、数据服务未重建及历史 Run 未增加。

## 最终验证

| 检查                                                               | 结果                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Domain / Provider 全量                                             | 252 / 701 通过                                                    |
| API 全量                                                           | 928 通过、85 条条件测试跳过；隔离项另行实跑，不将跳过算通过       |
| Worker 全量，启用专用隔离 PostgreSQL/Redis                         | 794 通过，零跳过                                                  |
| Web 全量                                                           | 91 文件、1418 项通过                                              |
| credential-crypto / observability / UI / execution                 | 7 / 21 / 16 / 43 通过                                             |
| `verify-isolated.ps1 -Action Test`                                 | 迁移及 schema 一致；基础设施 55、跨进程限流 9、TLS 入口 22 项通过 |
| 1920×1080、1366×768 桌面 E2E                                       | 14/14 通过、零重试；所有业务网络 Mock 或拒绝，零控制台错误        |
| `pnpm lint` / `pnpm typecheck` / `pnpm build`                      | 通过                                                              |
| `pnpm build:runtime` / `pnpm test:runtime`                         | ESM 产物成功、8/8 通过                                            |
| E2E 单文件独立严格 TypeScript / 文档 Prettier / `git diff --check` | 通过                                                              |
| Docker API / Worker / Web 镜像构建及启动                           | 通过；与运行镜像 ID 一致，六服务 healthy，8080 健康页 HTTP 200    |

具体单包命令为 `pnpm --filter @multimodal-canvas/<包名> exec vitest run --maxWorkers=2 --minWorkers=1 --reporter=dot`。桌面命令为：

```powershell
$env:WEB_BASE_URL='http://127.0.0.1:5188'
pnpm --filter @multimodal-canvas/web exec playwright test e2e/node-parameter-submission.spec.ts --project=chromium --workers=1 --reporter=line --output=G:/multimodal-canvas/test-results/node-parameter-submission-final
```

测试日志位于忽略的 `.local-tests/image-output-parameters/`，最终截图位于 `test-results/node-parameter-submission-final/`。没有把 Mock 请求成功当作真实 4K 图片验收。

### 验证中恢复的问题

- 隔离 API 初次出现两条已有夹具失败：迁移清单漏掉 rotation，通用 updatedAt 检查与一次性完成合同不符。仅同步测试夹具，显式校验 createdAt/completedAt 的精度、默认值与可空性；schema 和生产迁移未改。
- Worker 并发夹具要求专用 URL 精确为 `redis://127.0.0.1:16389/0`；修正测试进程变量后全量通过，未放宽隔离门禁。数据库为本机 16390 的 `result_recovery_test`，DSN 不带 query。
- 关闭 Web 子代理后，其 5188 临时服务退出，复测遇到连接拒绝。主代理重新读取工作区/检查点并恢复服务至 HTTP 200，随后完整 14 项重跑通过。8080 业务服务未受这次临时服务退出影响。
- Vite 仍报告既有的大 chunk 提示；本轮没有做无关性能重构。

## 本机交付与数据检查

先从运行容器的 image ID 保留 API/Worker/Web 的 `rollback-image-parameters-20260930-b9f89f4` 标签，再执行：

```powershell
docker compose build api worker web
docker compose up -d --no-deps --no-build --wait --wait-timeout 180 api worker web
```

部署前全局非终态 Run、未发布 outbox 及队列 active/waiting/delayed/prioritized/waiting-children/paused 均为零。部署前后项目节点、连线、Run 的完整行摘要一致，revision 仍为 594；PostgreSQL/Redis/MinIO 容器 ID 未变，未运行生产迁移。

随后页面验收期间观察到现场 revision 升至 598，另一个“图片生成节点 9”的旧 `quality: 4k` 已转成 `resolution: 4k`，仍为 9:16。为避免覆盖现场编辑，没有回写旧画布。指定目标“修改 图片生成节点 8 2”仍保存旧 4K/21:9；历史 Run 内容摘要和数量 26 均未变化、无新增在途任务。浏览器控制台未发现 error/warn，临时桌面视口已恢复。

镜像回滚信息在忽略的 `rollback-images.json`；本机操作和 SQL 只读摘要保留在同一日志目录。需要回滚时先停止新提交、确认在途任务，再用保留镜像替换三应用，不回退数据库、画布或资产，也不重放历史请求。回退旧 Provider 会重新带回旧尺寸映射缺陷。

## 交付与剩余边界

本轮按当前 upstream 创建任务级中文提交和附注 Tag `v2026.09.30-image-output-parameters`；最终提交号与远端核验结果见任务交付记录，不提前把待执行推送记作成功。用户原有文档删除不纳入提交。

真实网关对新 `size` 的受理及实际原图像素仍待明确费用范围后的单次验收，已记入 TODO P2-03。历史 1024×1024 图片不会自动变为 4K；本轮没有重新生成或本地放大。
