import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExportingObservability } from './index';

/** 本测试创建的回环监听器；每项结束时关闭全部连接。 */
const servers: Server[] = [];

/** 启动独立随机端口 collector，不读取外部追踪配置或发送生产请求。 */
async function collector(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('collector did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
});

describe('real HTTP telemetry delivery', () => {
  it('delivers OTLP JSON and Sentry envelopes with sanitized content', async () => {
    const received: Array<{ path: string; contentType: string | undefined; body: string }> = [];
    const endpoint = await collector((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        received.push({
          path: request.url ?? '',
          contentType: request.headers['content-type'],
          body,
        });
        response.writeHead(200).end();
      });
    });
    const observability = createExportingObservability({
      otlpEndpoint: endpoint,
      sentryDsn: endpoint.replace('http://', 'http://synthetic-public-key@') + '/42',
      service: 'local-acceptance',
    });
    const span = observability.startSpan('archive', {
      runId: 'run-local',
      cookie: 'synthetic-cookie',
    });
    span.recordException(
      new Error('download https://cdn.example/a?X-Amz-Signature=synthetic-signed-value'),
    );
    span.end('error');
    await vi.waitFor(() => expect(received).toHaveLength(2));
    const otlp = received.find((entry) => entry.path === '/v1/traces');
    expect(otlp?.contentType).toBe('application/json');
    const payload = JSON.parse(otlp!.body);
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
    const sentry = received.find((entry) => entry.path.startsWith('/api/42/envelope/'));
    expect(sentry?.contentType).toBe('application/x-sentry-envelope');
    expect(JSON.parse(sentry!.body.split('\n')[2]).tags.runId).toBe('run-local');
    expect(JSON.stringify(received)).not.toMatch(/synthetic-cookie|synthetic-signed-value/);
  });

  it('bounds stalled collectors, drops excess work, and recovers capacity', async () => {
    let stalled = true;
    let requests = 0;
    const endpoint = await collector((_request, response) => {
      requests += 1;
      if (!stalled) response.writeHead(200).end();
    });
    const failures: string[] = [];
    const observability = createExportingObservability({
      otlpEndpoint: endpoint,
      sentryDsn: '',
      timeoutMs: 150,
      maxPendingExports: 1,
      onExportFailure: (reason) => {
        failures.push(reason);
        throw new Error('diagnostic sink failed');
      },
    });
    expect(() => {
      observability.startSpan('stalled').end('ok');
      observability.startSpan('over-capacity').end('ok');
    }).not.toThrow();
    await vi.waitFor(() => expect(failures).toContain('timeout'));
    expect(failures).toContain('capacity');
    expect(requests).toBe(1);
    stalled = false;
    observability.startSpan('recovered').end('ok');
    await vi.waitFor(() => expect(requests).toBe(2));
  });

  it('isolates HTTP rejection and never forwards telemetry across redirects', async () => {
    let leaked = 0;
    const target = await collector((_request, response) => {
      leaked += 1;
      response.end();
    });
    const failures: string[] = [];
    const endpoint = await collector((request, response) => {
      if (request.url?.startsWith('/reject'))
        response.writeHead(503).end('synthetic-private-response');
      else response.writeHead(307, { location: target }).end();
    });
    for (const suffix of ['/reject', '/redirect']) {
      createExportingObservability({
        otlpEndpoint: endpoint + suffix,
        sentryDsn: '',
        onExportFailure: (reason) => {
          failures.push(reason);
        },
      }).captureException(new Error('safe message'));
    }
    await vi.waitFor(() => expect(failures).toHaveLength(2));
    expect(failures.sort()).toEqual(['http', 'network']);
    expect(leaked).toBe(0);
  });
});
