# 讯飞在线语音合成节点调用说明

更新时间：2026-09-05

本文记录后续音频节点调用讯飞在线语音合成流式 API 所需的协议和请求格式。真实 APISecret、APIKey、APIPassword 不写入仓库；运行时必须通过密钥管理或进程环境注入。

## 接口

- 官方文档：[在线语音合成 API](https://www.xfyun.cn/doc/tts/online_tts/API.html)
- WebSocket 地址：`wss://tts-api.xfyun.cn/v2/tts`
- 二进制音频响应：在查询串追加 `output_proto=binary`
- 请求协议：WebSocket，服务端支持 WebSocket version 13
- 文本编码：UTF-8
- 单次文本限制：Base64 编码前小于 8000 字节

## 推荐鉴权

优先使用控制台生成的 APIPassword，在 WebSocket 握手时设置：

```http
x-api-key: ${XFUN_TTS_API_PASSWORD}
```

运行时环境变量约定：

```text
XFUN_TTS_APP_ID=f4c1b9bd
XFUN_TTS_API_PASSWORD=<运行时注入，不写入文件>
XFUN_TTS_VOICE=xiaoyan
```

`APISecret` 和 `APIKey` 属于另一种 HMAC 鉴权方式。本项目当前已验证 APIPassword 方式，音频节点无需同时发送两套凭据。若后续切换 HMAC，必须按讯飞文档根据 `host`、RFC1123 `date` 和 `GET /v2/tts HTTP/1.1` 计算 `hmac-sha256`，不能复用 APIPassword 请求头。

## 请求体

文本必须先使用 UTF-8 编码，再进行 Base64 编码。示例文本“你好啊”的编码为 `5L2g5aW95ZWK`。

```json
{
  "common": {
    "app_id": "f4c1b9bd",
    "uid": "codex-local-tts"
  },
  "business": {
    "aue": "lame",
    "sfl": 1,
    "auf": "audio/L16;rate=16000",
    "vcn": "xiaoyan",
    "speed": 50,
    "volume": 50,
    "pitch": 50,
    "tte": "utf8"
  },
  "data": {
    "status": 2,
    "text": "5L2g5aW95ZWK"
  }
}
```

字段约束：

- `common.app_id`：讯飞应用 ID。
- `common.uid`：调用方生成的用户或节点标识，不放入密钥。
- `business.aue`：`lame` 表示 MP3；`raw` 表示 PCM。
- `business.sfl`：使用 MP3 流式响应时设为 `1`。
- `business.auf`：`audio/L16;rate=16000` 表示 16 kHz；不填写时默认 16 kHz。
- `business.vcn`：控制台已开通的发音人；示例使用 `xiaoyan`。
- `business.speed/volume/pitch`：整数 `0` 到 `100`，示例均为 `50`。
- `business.tte`：文本编码；中文请求使用 `utf8`。
- `data.status`：固定为 `2`，表示一次性上传完整文本。

## 响应处理

使用 `output_proto=binary` 时，响应帧顺序通常为：

1. 文本帧：包含 `code`、`message`、`sid` 和开始状态。
2. 一个或多个二进制帧：追加到音频缓冲区。
3. 文本帧：`code=0` 且 `data.status=2`，表示音频全部返回。

收到结束帧后关闭 WebSocket，使用正常关闭码 `1000`。任意文本帧出现非零 `code` 时立即失败并保留 `sid`、错误码和错误消息；不要把本地超时或断线自动重发为新的合成请求。

## 节点接入约定

音频节点应在发送前校验：

- `XFUN_TTS_API_PASSWORD` 已注入；缺失时请求前失败。
- `vcn`、格式、采样率和语速在节点参数范围内。
- UTF-8 文本 Base64 后小于 8000 字节。
- 仅发送一次 WebSocket 合成请求，保存 `sid`、音频字节数、MIME 类型和 SHA-256。
- 将 MP3 结果交给现有 Worker/对象存储归档链路，不保存签名 URL 或凭据。

## 本次验证结果

2026-09-05 已使用 APIPassword 鉴权成功生成“你好啊”：MP3、16 kHz、单声道、4536 字节、0.756 秒。请求和响应证据保存在被 Git 忽略的 `.data` 目录；仓库文档不包含真实密钥。

由于凭据曾在对话中明文提交，建议在讯飞控制台完成 APISecret、APIKey 和 APIPassword 轮换后，再将新值通过运行时密钥管理注入。
