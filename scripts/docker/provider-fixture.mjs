/** 仅供隔离 Docker 验收的 HTTPS 合成供应商；无外连、无真实凭据、无请求日志。 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

/** 固定合成凭据，不是任何真实供应商的密钥，也不接受环境变量覆盖。 */
export const SYNTHETIC_KEY = 'mc-acceptance-synthetic-only-v1';
/** 合成模型目录：文本仅报 token，图像另报明确金额，用于区分两类入账。 */
export const MODELS = Object.freeze([
  { id: 'mc-smoke-text-v1', mediaTypes: ['text'], price: { perRun: '9.99', currency: 'USD' } },
  { id: 'mc-smoke-image-v1', mediaTypes: ['image'], price: { perRun: '9.99', currency: 'USD' } },
]);
/** fixture 身份和协议版本，供验收脚本校验。 */
export const FIXTURE_ID = 'mc-acceptance-provider-v1';

/** 返回可由 ffprobe/FFmpeg 解码的 32x24 RGB PNG，所有像素在内存生成。 */
export function syntheticPng() {
  /** 按 PNG 标准封装类型、长度、数据及 CRC，不写临时媒体文件。 */
  function chunk(type, bytes) {
    const name = Buffer.from(type);
    const result = Buffer.alloc(bytes.length + 12);
    result.writeUInt32BE(bytes.length);
    name.copy(result, 4);
    bytes.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([name, bytes])), result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32);
  header.writeUInt32BE(24, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(24 * (1 + 32 * 3));
  for (let y = 0; y < 24; y += 1) {
    for (let x = 0; x < 32; x += 1) {
      const offset = y * 97 + 1 + x * 3;
      pixels.set([x * 7, y * 10, 160], offset);
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 返回确定性的文本内容；marker 必须是脚本生成的非秘密测试身份。 */
export function syntheticText(marker) {
  return `${marker}\nSYNTHETIC_TEXT_OK\n`;
}

/** 创建内存供应商状态；只接受两个合成模型，不代理或下载任何 URL。 */
export function createFixture() {
  /** 仅缓存请求摘要和合成结果；不保存 Authorization、完整输入或密码。 */
  const jobs = new Map();
  /** 无敏感信息的观测计数，用于确认重复 API 提交没有产生第二次上游创建。 */
  const counters = { posts: 0, creations: 0, replays: 0, conflicts: 0 };
  return {
    /** 返回脱敏统计，不包含幂等键、请求正文或任何凭据。 */
    stats() {
      return { fixture: FIXTURE_ID, ...counters };
    },
    /** 校验真实 HTTP 适配器发来的正文和幂等键，返回同步合成响应。 */
    generate(path, key, body) {
      const model = path === '/v1/chat/completions' ? MODELS[0] : MODELS[1];
      if (body?.model !== model.id || typeof key !== 'string' || !key || key.length > 512) {
        return { status: 400, body: { error: 'synthetic model and idempotency key required' } };
      }
      const content = JSON.stringify(body);
      const marker = content.match(/mc-docker-smoke:[0-9a-f-]{36}/)?.[0];
      if (!marker || /https?:\/\//i.test(content) || body.stream === true) {
        return { status: 400, body: { error: 'synthetic non-streaming input required' } };
      }
      counters.posts += 1;
      const fingerprint = createHash('sha256').update(path).update(content).digest('hex');
      const identity = createHash('sha256').update(key).digest('hex');
      const previous = jobs.get(identity);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          counters.conflicts += 1;
          return { status: 409, body: { error: 'idempotency conflict' } };
        }
        counters.replays += 1;
        return { status: 200, body: previous.result };
      }
      if (jobs.size >= 32) {
        return { status: 429, body: { error: 'synthetic fixture capacity reached' } };
      }
      const result =
        model.id === MODELS[0].id
          ? {
              id: `synthetic-${identity.slice(0, 16)}`,
              object: 'chat.completion',
              model: model.id,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: syntheticText(marker) },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
            }
          : {
              created: 1_700_000_000,
              data: [{ b64_json: syntheticPng().toString('base64') }],
              usage: { total_cost: '0.0123', currency: 'USD', images: 1 },
            };
      jobs.set(identity, { fingerprint, result });
      counters.creations += 1;
      return { status: 200, body: result };
    },
  };
}

/** 启动固定 9443 HTTPS 端口；证书校验由调用端执行，不允许禁用 TLS。 */
async function serve() {
  const fixture = createFixture();
  const server = createServer(
    {
      cert: await readFile('/run/multimodal/secrets/minio/public.crt'),
      key: await readFile('/run/multimodal/secrets/minio/private.key'),
      minVersion: 'TLSv1.2',
    },
    async (request, response) => {
      /** 只发送固定错误或合成内容，不回显请求头及请求正文。 */
      const send = (status, body) => {
        response.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify(body));
      };
      if (request.method === 'GET' && request.url === '/__smoke/stats') {
        return send(200, fixture.stats());
      }
      if (request.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`) {
        return send(401, { error: 'synthetic authorization required' });
      }
      if (request.method === 'GET' && request.url === '/v1/models') {
        return send(200, { object: 'list', data: MODELS });
      }
      if (
        request.method !== 'POST' ||
        !['/v1/chat/completions', '/v1/images/generations'].includes(request.url)
      ) {
        return send(404, { error: 'synthetic route not found' });
      }
      try {
        let size = 0;
        const chunks = [];
        for await (const part of request) {
          size += part.length;
          if (size > 64 * 1024) return send(413, { error: 'synthetic input too large' });
          chunks.push(part);
        }
        const result = fixture.generate(
          request.url,
          request.headers['idempotency-key'],
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        send(result.status, result.body);
      } catch {
        send(400, { error: 'invalid synthetic input' });
      }
    },
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(9443, '0.0.0.0', resolve);
  });
  console.log('Synthetic HTTPS provider ready on port 9443. No external requests are made.');
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve().catch(() => {
    console.error('Synthetic HTTPS provider failed. Check its read-only certificate mount.');
    process.exitCode = 1;
  });
}
