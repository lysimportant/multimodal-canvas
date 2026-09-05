# 真实 Provider 最小验收

日期：2026-09-05。唯一实际服务地址为 `https://ai.helunox.cc.cd`。
New API 官方文档用于核对兼容协议，不是另一个已验收的服务器。

## 隔离与授权

- 用户指定文本、图片、视频测试 Key 与模型。凭据通过无回显 stdin 注入内存，子进程通过 IPC 获取，不写入源码、命令参数、日志或配置文件。
- 真实请求经过 API 运行提交、BullMQ、Worker、冻结凭据引用、Prisma 和 MinIO 归档。基础设施是专用 `mc-acceptance-test-p0p1`，不是业务生产库。
- 每次创建随机 `mc_live_test_<24hex>` schema 和队列，数据库凭据字段只存密文；结束清理本次 schema/队列，测试资产保留在隔离桶及被 Git 忽略的 `.data`。
- 每次 POST 前记录发送意图，不自动重试。用户明确纠正视频模型名称后才执行第二次指定请求；两次分开记录，不伪装成一次成功。
- 不对视频 404 推断未受理或未计费。没有返回价格或费用时保持未知，不估算本地收费。

## 已成功链路

| 项目            | 文本                                                        | 图片                                                 |
| --------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| 精确模型        | `gpt-5.5`                                                   | `gpt-image-2`                                        |
| 端点            | `POST /v1/chat/completions`                                 | `POST /v1/images/generations`                        |
| 请求次数 / HTTP | 1 / 200                                                     | 1 / 200                                              |
| 持久化运行状态  | succeeded                                                   | succeeded                                            |
| 归档类型 / 字节 | text/plain / 2                                              | image/png / 800639                                   |
| usage           | prompt_tokens=8684, completion_tokens=10, total_tokens=8694 | input_tokens=14, output_tokens=259, total_tokens=273 |
| 资产版本        | 1                                                           | 1                                                    |

文本输出为 `OK`，图片已查看为有效红色方形与白色背景。下载读回的 SHA-256 与归档元数据一致。
供应商 header requestId 的摘要与持久化 `providerJob.payload.requestId` 摘要一致。

| 关联项            | 文本                                                                        | 图片                                                                        |
| ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 内部运行 ID       | `run_idem_d7be8fb61b142379e26d05b6d68b63e3eba72bab1ad32ea0438379e215e3eac8` | `run_idem_513ffe553a50430c2eefbd532684633467248da27c0b3fd79ae7c2cf38c8a23b` |
| requestId SHA-256 | `e15394b742757cc174521058ae73c0f923f15b3e51486182c73144da7e3601b2`          | `9b1c63340421fb68c4fcfa8d66bfacb76c4757639b02984c1df99168fda33e6a`          |
| 内容 SHA-256      | `565339bc4d33d72817b583024112eb7f5cdf3e5eef0252d6ec1b9c9a94e12bb3`          | `3a5577bd9d2a8cfd73b1ecc4018b3313ecab6bbcd8f89f6c0e5f7333aecdc59e`          |

本地脱敏证据：`.data/live-provider-49a00e42-9929-4755-9e36-c0d2ad74e7d6-{text,image}.json`。
不提交生成资产、原始媒体、实际 Key 或第三方签名 URL。

## 视频结果

| 授权阶段                   | 精确模型字符串                                    | 端点                         | HTTP |
| -------------------------- | ------------------------------------------------- | ---------------------------- | ---- |
| 首次，采用模型列表返回名称 | `grok-imagine-video-1.5 （按次）`（括号前有空格） | `POST /v1/video/generations` | 404  |
| 用户明确纠正后             | `grok-imagine-video-1.5（按次）`（括号前无空格）  | `POST /v1/video/generations` | 404  |

第二次请求完整保留模型后缀，未删除括号、汉字或任何字符，也未替换成其它模型。
requestId 摘要为 `45e42b8856643ae5e11fa8a34d4f30f5b7f88324d757f29ba8460b8cb9962d39`，
内部运行 ID 为 `run_idem_b432e77be42a3a62266c7935cdde8848e034bd6aa551cddd613fb39d47e6472f`。
脱敏证据为 `.data/live-provider-88a2c3ad-2fc1-49cd-8743-ec0db351f0fc-video.json`。

404 只能证明该请求失败，不能断言该模型本身不支持视频。没有平台任务 ID、视频成品或 usage，
因此查询、任务恢复、下载及视频归档的真实链路还不能验收。

只读调查确认站点实际加载的脚本标识 Sub2API 并链接官方项目。固定提交
`b1748c4ea99ce2120401a269142aa071e18a84da` 的
[官方 README](https://github.com/Wei-Shaw/sub2api/blob/b1748c4ea99ce2120401a269142aa071e18a84da/README.md#L750)
及[路由源码](https://github.com/Wei-Shaw/sub2api/blob/b1748c4ea99ce2120401a269142aa071e18a84da/backend/internal/server/routes/gateway.go#L268)
列出创建 `POST /v1/videos/generations`、查询 `GET /v1/videos/{request_id}`，对应应用显式
`NEW_API_VIDEO_CONTRACT=legacy-v1`。这是协议差异的来源证据，不证明站点具体部署版本。
已请求用户确认在正确复数端点执行一次；获得后续请求授权前不自动切换协议重发。

## 其它边界

- 三把 Key 的 `/v1/models` GET 均为 HTTP 200；可列出模型不等于特定媒体端点可调用。
- 未进行真实音频调用：尚无指定 TTS 模型、voice 与调用授权。合成音频和真实存储/FFmpeg 另有独立验收。
- 未进行供应商后台 Key 撤销/轮换、真实多 Key DAG、收费失败重试、远程取消或 Webhook 注册。
- 原始明文凭据不应继续长期使用；验收结束后应在平台侧轮换测试 Key。
