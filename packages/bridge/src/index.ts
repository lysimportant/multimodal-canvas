/**
 * Canvas Agent Bridge
 *
 * 在本地把 ACP Agent（claude / codex / gemini / opencode / qwen）接到 multimodal-canvas 画布。
 *
 * 数据流：
 *
 *   浏览器侧栏 --HTTP(SSE)--> 画布 API --NDJSON 长连接--> 本桥接 --ACP(stdio)--> Agent
 *
 * 用法：
 *
 *   node canvas-bridge.js --api http://localhost:8787 --token <urlKey> \
 *     --project <projectId> --agent claude
 *
 * 其中：
 *   --api        画布 API 的基地址
 *   --token      画布「Agent 连接」面板里生成的连接密钥（<connectionId>.<签名>）
 *   --project    画布项目 ID（连接面板生成的命令里已包含）
 *   --agent      内置 Agent 名称：claude / codex / gemini / opencode / qwen
 *   --agent-args 追加给 Agent 进程的额外参数（空格分隔）
 *   --agent-cmd  覆盖内置 Agent 启动命令（便于接入自定义 ACP Agent 或做联调）
 *
 * 桥接会自动放行 Agent 发起的工具权限请求（与画布的产品决策一致：画布工具调用与画布外操作
 * 全部自动放行），并把 ACP 的会话更新归一化成画布侧栏认识的 5 种事件。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';

const BRIDGE_NAME = 'canvas-bridge';
const BRIDGE_VERSION = '0.1.0';
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const IS_WINDOWS = process.platform === 'win32';

type AgentName = 'codex' | 'claude' | 'gemini' | 'opencode' | 'qwen';

const AGENT_BINARIES: Record<AgentName, { cmd: string; args: string[] }> = {
  codex: { cmd: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] },
  claude: { cmd: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  gemini: { cmd: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
  opencode: { cmd: 'opencode', args: ['acp'] },
  qwen: { cmd: 'npx', args: ['-y', '@qwen-code/qwen-code', '--acp'] },
};

/** 画布侧栏认识的事件类型。 */
type BridgeEvent =
  | { type: 'agent_message_chunk'; text: string }
  | { type: 'tool_call'; name: string; status?: string }
  | { type: 'usage_update'; inputTokens?: number; outputTokens?: number }
  | { type: 'done' }
  | { type: 'agent_error'; message: string };

/** 画布 API 通过 NDJSON 长连接下发的一次任务。 */
interface BridgePrompt {
  type: 'prompt';
  taskId: string;
  sessionId: string;
  projectId: string;
  messages: Array<{ role: string; content: string }>;
}

interface Options {
  api: string;
  token: string;
  projectId: string;
  agent: AgentName;
  agentCmd?: string;
  agentArgs: string[];
}

const log = {
  info: (message: string): void => {
    process.stderr.write(`${timestamp()} ${message}\n`);
  },
  warn: (message: string): void => {
    process.stderr.write(`${timestamp()} WARN ${message}\n`);
  },
};

function timestamp(): string {
  return `[canvas-bridge ${new Date().toISOString()}]`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function usage(): string {
  return [
    'canvas-bridge — 把本地 ACP Agent 接到 multimodal-canvas 画布',
    '',
    '用法：',
    '  node canvas-bridge.js --api <url> --token <key> --project <projectId> [options]',
    '',
    '必填：',
    '  --api <url>        画布 API 基地址，例如 http://localhost:8787',
    '  --token <key>      画布「Agent 连接」面板生成的连接密钥',
    '  --project <id>     画布项目 ID（面板生成的命令里已包含）',
    '',
    '可选：',
    `  --agent <name>     内置 Agent：${Object.keys(AGENT_BINARIES).join(' / ')}（默认 codex）`,
    '  --agent-cmd <cmd>  覆盖内置 Agent 启动命令',
    '  --agent-args <s>   追加给 Agent 进程的参数（空格分隔）',
    '  --help, -h         显示本帮助',
  ].join('\n');
}

function parseArgs(argv: string[]): Options | null {
  const values = new Map<string, string>();
  const allowed = new Set(['api', 'token', 'project', 'agent', 'agent-cmd', 'agent-args']);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(`${usage()}\n`);
      return null;
    }
    if (!argument.startsWith('--')) {
      fail(`无法识别的参数：${argument}`);
    }
    const equals = argument.indexOf('=');
    if (equals > 2) {
      const name = argument.slice(2, equals);
      if (!allowed.has(name)) {
        fail(`无法识别的参数：--${name}`);
      }
      values.set(name, argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    if (!allowed.has(name)) {
      fail(`无法识别的参数：--${name}`);
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, '');
    }
  }

  const api = values.get('api')?.trim() ?? '';
  if (!api) {
    fail('缺少 --api');
  }
  const token = values.get('token')?.trim() ?? '';
  if (!token) {
    fail('缺少 --token（从画布「Agent 连接」面板复制完整命令）');
  }
  const projectId = values.get('project')?.trim() ?? '';
  if (!projectId) {
    fail('缺少 --project（画布项目 ID，可从画布 URL 或「Agent 连接」面板复制）');
  }

  const agentName = (values.get('agent')?.trim() || 'codex') as AgentName;
  if (!Object.prototype.hasOwnProperty.call(AGENT_BINARIES, agentName)) {
    fail(`不支持的 --agent：${agentName}（可选：${Object.keys(AGENT_BINARIES).join(' / ')}）`);
  }

  const agentArgs = (values.get('agent-args') ?? '')
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const agentCmd = values.get('agent-cmd')?.trim();

  return {
    api: api.replace(/\/+$/, ''),
    token,
    projectId,
    agent: agentName,
    ...(agentCmd ? { agentCmd } : {}),
    agentArgs,
  };
}

function fail(message: string): never {
  process.stderr.write(`canvas-bridge: ${message}\n\n${usage()}\n`);
  process.exit(2);
}

function resolveBinary(spec: { cmd: string; args: string[] }): { cmd: string; args: string[] } {
  if (!IS_WINDOWS || spec.cmd !== 'npx') {
    return spec;
  }
  return { cmd: 'npx.cmd', args: spec.args };
}

function lastUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return '';
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message && message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'RelayHttpError';
  }
}

/**
 * 画布 API 中继客户端：维持 /v1/agent-bridge/connect 长连接（读任务），
 * 并把任务事件 POST 回 /v1/agent-bridge/tasks/:taskId/events。
 */
class ApiRelay {
  private readonly abortController = new AbortController();
  private stopped = false;
  private attempt = 0;

  constructor(
    private readonly options: Options,
    private readonly handlers: {
      onPrompt: (prompt: BridgePrompt) => void;
      onCancel: (taskId: string) => void;
    },
  ) {}

  start(): void {
    void this.loop();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortController.abort();
  }

  async postEvents(taskId: string, projectId: string, lines: string[]): Promise<void> {
    if (lines.length === 0 || this.stopped) {
      return;
    }
    const url =
      `${this.options.api}/v1/agent-bridge/tasks/${encodeURIComponent(taskId)}/events` +
      `?projectId=${encodeURIComponent(projectId)}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/x-ndjson',
        },
        body: `${lines.join('\n')}\n`,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn(`event post rejected: HTTP ${response.status} ${body.slice(0, 200)}`);
      }
    } catch (error) {
      log.warn(`event post failed: ${errorMessage(error)}`);
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.run();
        log.warn('bridge connection closed by server');
      } catch (error) {
        if (this.stopped) {
          return;
        }
        if (error instanceof RelayHttpError && (error.status === 401 || error.status === 400)) {
          log.warn(
            `connect rejected (HTTP ${error.status}${error.body ? `: ${error.body.slice(0, 120)}` : ''})` +
              ' — token 或 projectId 无效，请在画布「Agent 连接」面板重新复制命令',
          );
        } else {
          log.warn(`bridge connection lost: ${errorMessage(error)}`);
        }
      }
      if (this.stopped) {
        return;
      }
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempt, BACKOFF_MAX_MS);
      this.attempt += 1;
      log.info(`reconnecting in ${Math.round(delay / 1000)}s`);
      await sleep(delay, this.abortController.signal);
    }
  }

  private async run(): Promise<void> {
    const url =
      `${this.options.api}/v1/agent-bridge/connect` +
      `?projectId=${encodeURIComponent(this.options.projectId)}`;
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
        accept: 'application/x-ndjson',
      },
      signal: this.abortController.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new RelayHttpError(response.status, body);
    }
    if (!response.body) {
      throw new Error('connect response has no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          this.handleLine(line);
        }
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn(`ignoring malformed bridge line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return;
    }
    const message = parsed as { type?: unknown; taskId?: unknown };
    switch (message.type) {
      case 'ready':
        this.attempt = 0;
        log.info(`connected to ${this.options.api} (project ${this.options.projectId})`);
        return;
      case 'ping':
        return;
      case 'prompt':
        this.handlers.onPrompt(parsed as BridgePrompt);
        return;
      case 'cancel':
        if (typeof message.taskId === 'string') {
          this.handlers.onCancel(message.taskId);
        }
        return;
      default:
        log.warn(`ignoring unknown bridge message: ${line.slice(0, 200)}`);
    }
  }
}

/** 按任务串行、批量投递事件；保证 done 一定在最后一批之后。 */
class TaskSink {
  private buffer: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private closed = false;

  constructor(
    private readonly relay: ApiRelay,
    private readonly taskId: string,
    private readonly projectId: string,
  ) {}

  push(event: BridgeEvent): void {
    if (this.closed) {
      return;
    }
    this.buffer.push(JSON.stringify(event));
    this.schedule();
  }

  async flush(): Promise<void> {
    this.schedule();
    await this.chain;
  }

  close(): void {
    this.closed = true;
  }

  private schedule(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    this.chain = this.chain.then(async () => {
      this.scheduled = false;
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.buffer.length);
        await this.relay.postEvents(this.taskId, this.projectId, batch);
      }
    });
  }
}

interface HostSession {
  bridgeSessionId: string;
  acp: ActiveSession;
  queue: Promise<void>;
}

interface TurnRecord {
  bridgeSessionId: string;
  acpSessionId: string;
}

/** 管理 Agent 子进程、ACP 连接与画布会话的映射关系。 */
class AgentHost {
  private connection?: ClientConnection;
  private child?: ChildProcess;
  private relay?: ApiRelay;
  private readonly sessions = new Map<string, HostSession>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly sinks = new Map<string, TaskSink>();
  private readonly currentTaskByAcpSession = new Map<string, string>();
  private readonly workdir: string;

  constructor(private readonly options: Options) {
    this.workdir = join(homedir(), '.canvas-agent', options.projectId);
  }

  get workingDirectory(): string {
    return this.workdir;
  }

  attachRelay(relay: ApiRelay): void {
    this.relay = relay;
  }

  async handlePrompt(prompt: BridgePrompt): Promise<void> {
    const relay = this.relay;
    if (!relay) {
      return;
    }
    const sink = new TaskSink(relay, prompt.taskId, prompt.projectId);
    this.sinks.set(prompt.taskId, sink);
    try {
      const session = await this.ensureSession(prompt.sessionId);
      const previous = session.queue;
      const turn = previous.then(() => this.runTurn(session, prompt, sink));
      session.queue = turn.then(
        () => undefined,
        () => undefined,
      );
      await turn;
    } catch (error) {
      log.warn(`task ${prompt.taskId} failed: ${errorMessage(error)}`);
      sink.push({ type: 'agent_error', message: errorMessage(error) });
      sink.push({ type: 'done' });
    } finally {
      await sink.flush();
      sink.close();
      this.sinks.delete(prompt.taskId);
      this.turns.delete(prompt.taskId);
    }
  }

  cancel(taskId: string): void {
    const turn = this.turns.get(taskId);
    const connection = this.connection;
    if (!turn || !connection) {
      return;
    }
    log.info(`cancelling task ${taskId} (acp session ${turn.acpSessionId})`);
    void Promise.resolve(
      connection.agent.notify(methods.agent.session.cancel, { sessionId: turn.acpSessionId }),
    ).catch((error: unknown) => {
      log.warn(`cancel failed: ${errorMessage(error)}`);
    });
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    const child = this.child;
    this.child = undefined;
    this.sessions.clear();
    this.turns.clear();
    this.sinks.clear();
    this.currentTaskByAcpSession.clear();
    connection?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  private async ensureSession(bridgeSessionId: string): Promise<HostSession> {
    const existing = this.sessions.get(bridgeSessionId);
    if (existing) {
      return existing;
    }
    const connection = await this.ensureConnection();
    const builder = connection.agent.buildSession(this.workdir);
    builder.withMcpServer({
      type: 'http',
      name: 'canvas',
      url:
        `${this.options.api}/v1/projects/${encodeURIComponent(this.options.projectId)}` +
        `/mcp?connection=${encodeURIComponent(this.options.token)}`,
      headers: [],
    });
    const acp = await builder.start();
    const session: HostSession = { bridgeSessionId, acp, queue: Promise.resolve() };
    this.sessions.set(bridgeSessionId, session);
    log.info(`session ready: bridge=${bridgeSessionId} acp=${acp.sessionId}`);
    return session;
  }

  private async ensureConnection(): Promise<ClientConnection> {
    const existing = this.connection;
    if (existing && !existing.signal.aborted) {
      return existing;
    }
    return this.startAgent();
  }

  private async startAgent(): Promise<ClientConnection> {
    const spec = this.options.agentCmd
      ? { cmd: this.options.agentCmd, args: [] }
      : resolveBinary(AGENT_BINARIES[this.options.agent]);
    const args = [...spec.args, ...this.options.agentArgs];
    log.info(`starting agent: ${spec.cmd} ${args.join(' ')}`);
    const child = spawn(spec.cmd, args, {
      cwd: this.workdir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: IS_WINDOWS,
      env: process.env,
    });
    this.child = child;

    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      for (;;) {
        const newline = stderrBuffer.indexOf('\n');
        if (newline < 0) {
          break;
        }
        process.stderr.write(`[agent] ${stderrBuffer.slice(0, newline)}\n`);
        stderrBuffer = stderrBuffer.slice(newline + 1);
      }
    });

    const exited = new Promise<never>((_, reject) => {
      child.once('error', (error) => {
        reject(new Error(`agent process failed to start: ${errorMessage(error)}`));
      });
      child.once('exit', (code, signal) => {
        reject(new Error(`agent exited (code ${String(code)}, signal ${String(signal)})`));
      });
    });
    void exited.catch(() => undefined);

    if (!child.stdin || !child.stdout) {
      throw new Error('agent process stdio unavailable');
    }

    const app = client({ name: BRIDGE_NAME });
    app.onRequest(methods.client.session.requestPermission, (context) =>
      this.approvePermission(context.params),
    );

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const connection = app.connect(stream);
    this.connection = connection;
    child.once('exit', (code, signal) => {
      this.handleAgentExit(connection, code, signal);
    });

    await Promise.race([
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      }),
      exited,
    ]);
    log.info('agent initialized');
    return connection;
  }

  private approvePermission(request: RequestPermissionRequest): RequestPermissionResponse {
    const allowAlways = request.options.find((option) => option.kind === 'allow_always');
    const allowOnce = request.options.find((option) => option.kind === 'allow_once');
    const selected = allowAlways ?? allowOnce ?? request.options[0];
    const title = request.toolCall.title ?? request.toolCall.name ?? 'tool call';
    this.notifyToolCall(request.sessionId, title);
    if (!selected) {
      return { outcome: { outcome: 'cancelled' } };
    }
    log.info(`auto-approving "${title}" with ${selected.kind}`);
    return { outcome: { outcome: 'selected', optionId: selected.optionId } };
  }

  private notifyToolCall(acpSessionId: string, title: string): void {
    const taskId = this.currentTaskByAcpSession.get(acpSessionId);
    if (!taskId) {
      return;
    }
    this.sinks.get(taskId)?.push({ type: 'tool_call', name: title, status: 'pending' });
  }

  private handleAgentExit(
    connection: ClientConnection,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.connection !== connection) {
      return;
    }
    log.warn(`agent exited (code ${String(code)}, signal ${String(signal)})`);
    this.connection = undefined;
    this.child = undefined;
    this.sessions.clear();
    this.currentTaskByAcpSession.clear();
  }

  private async runTurn(session: HostSession, prompt: BridgePrompt, sink: TaskSink): Promise<void> {
    const acpSessionId = session.acp.sessionId;
    this.turns.set(prompt.taskId, { bridgeSessionId: session.bridgeSessionId, acpSessionId });
    this.currentTaskByAcpSession.set(acpSessionId, prompt.taskId);

    const text = lastUserMessage(prompt.messages);
    if (!text) {
      sink.push({ type: 'agent_error', message: '没有可发送的用户消息' });
      sink.push({ type: 'done' });
      this.currentTaskByAcpSession.delete(acpSessionId);
      return;
    }

    const response = session.acp.prompt(text);
    try {
      const stopReason = await this.consumeUpdates(session, sink);
      await response;
      log.info(`task ${prompt.taskId} finished (${stopReason})`);
      sink.push({ type: 'done' });
    } catch (error) {
      log.warn(`task ${prompt.taskId} failed: ${errorMessage(error)}`);
      sink.push({ type: 'agent_error', message: errorMessage(error) });
      sink.push({ type: 'done' });
      void response.catch(() => undefined);
    } finally {
      this.currentTaskByAcpSession.delete(acpSessionId);
    }
  }

  private async consumeUpdates(session: HostSession, sink: TaskSink): Promise<StopReason> {
    for (;;) {
      const message = await session.acp.nextUpdate();
      if (message.kind === 'stop') {
        return message.stopReason;
      }
      this.forwardUpdate(message.update, sink);
    }
  }

  private forwardUpdate(update: SessionUpdate, sink: TaskSink): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          sink.push({ type: 'agent_message_chunk', text: update.content.text });
        }
        return;
      }
      case 'tool_call': {
        const name = update.title || update.name || update.toolCallId;
        if (name) {
          sink.push({ type: 'tool_call', name, status: update.status });
        }
        return;
      }
      case 'usage_update': {
        sink.push({ type: 'usage_update', inputTokens: update.used, outputTokens: update.size });
        return;
      }
      default:
        return;
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }

  const host = new AgentHost(options);
  mkdirSync(host.workingDirectory, { recursive: true });

  const relay = new ApiRelay(options, {
    onPrompt: (prompt) => {
      void host.handlePrompt(prompt);
    },
    onCancel: (taskId) => {
      host.cancel(taskId);
    },
  });
  host.attachRelay(relay);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    relay.stop();
    void host.close().finally(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason: unknown) => {
    log.warn(`unhandled rejection: ${errorMessage(reason)}`);
  });

  log.info(
    `canvas bridge ${BRIDGE_VERSION} (agent: ${options.agentCmd ?? options.agent}, ` +
      `project: ${options.projectId})`,
  );
  log.info(`workspace: ${host.workingDirectory}`);

  relay.start();
  await new Promise<void>(() => undefined);
}

void main().catch((error: unknown) => {
  log.warn(`fatal: ${errorMessage(error)}`);
  process.exit(1);
});
