/**
 * Canvas Agent Bridge
 *
 * 在本地把 ACP Agent（claude / codex / gemini / opencode / qwen）接到 multimodal-canvas 画布。
 *
 * 两种运行模式：
 *
 * 1. 直连本地模式（推荐，和画布页面直接通信，不经服务端中继）：
 *
 *      node canvas-bridge.js --local
 *
 *    桥接在 127.0.0.1 上监听 HTTP/SSE，启动后打印 Local URL 与 Connect token，
 *    把它们填进画布右上角「本地 Agent」面板即可聊天：
 *
 *     浏览器侧栏 --HTTP/SSE--> 本桥接(127.0.0.1) --ACP(stdio)--> Agent
 *                            \--MCP(HTTP)--> 画布 API
 *
 *    Agent 需要的画布 MCP 地址由画布页面在建立会话时下发（含项目与连接凭据），
 *    所以本地桥接不需要预先知道项目 ID。
 *
 * 2. 服务端中继模式（服务器部署/无浏览器直连时使用）：
 *
 *      node canvas-bridge.js --api <url> --token <key> --project <id> --agent claude
 *
 *     浏览器侧栏 --HTTP(SSE)--> 画布 API --NDJSON 长连接--> 本桥接 --ACP(stdio)--> Agent
 *
 * 通用选项：
 *   --agent      内置 Agent 名称：claude / codex / gemini / opencode / qwen
 *   --agent-args 追加给 Agent 进程的额外参数（空格分隔）
 *   --agent-cmd  覆盖内置 Agent 启动命令（便于接入自定义 ACP Agent 或做联调）
 *
 * 本地模式选项：
 *   --port       监听端口（默认 17871）
 *   --host       监听地址（默认 127.0.0.1，只允许本机访问）
 *   --local-token  固定连接令牌（默认读取/生成 ~/.canvas-agent/local-agent.json）
 *
 * 桥接会自动放行 Agent 发起的工具权限请求（与画布的产品决策一致：画布工具调用与画布外操作
 * 全部自动放行），并把 ACP 的会话更新归一化成画布侧栏认识的 5 种事件。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
const BRIDGE_VERSION = '0.2.0';
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const IS_WINDOWS = process.platform === 'win32';
const DEFAULT_LOCAL_HOST = '127.0.0.1';
const DEFAULT_LOCAL_PORT = 17_871;
/** 桥接运行目录；可用 CANVAS_AGENT_HOME 覆盖（测试与多实例联调用）。 */
const AGENT_HOME_DIR = process.env.CANVAS_AGENT_HOME?.trim() || join(homedir(), '.canvas-agent');
const LOCAL_CONFIG_PATH = join(AGENT_HOME_DIR, 'local-agent.json');
const MAX_BODY_BYTES = 1024 * 1024;
const HEARTBEAT_MS = 20_000;

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

/** 一次提示词请求（本地模式与中继模式共用）。 */
interface PromptRequest {
  taskId: string;
  /** 画布页面侧的桥接会话 ID。 */
  sessionId: string;
  projectId?: string;
  /** 画布 MCP 地址（含连接凭据），由画布页面下发。 */
  mcpUrl?: string;
  messages: Array<{ role: string; content: string }>;
}

/** 画布 API 通过 NDJSON 长连接下发的一次任务。 */
interface RelayPrompt extends PromptRequest {
  type: 'prompt';
  projectId: string;
}

interface AgentSpec {
  agent: AgentName;
  agentCmd?: string;
  agentArgs: string[];
}

interface RelayOptions extends AgentSpec {
  mode: 'relay';
  api: string;
  token: string;
  projectId: string;
}

interface LocalOptions extends AgentSpec {
  mode: 'local';
  host: string;
  port: number;
  noToken: boolean;
  localToken?: string;
}

type CliOptions = RelayOptions | LocalOptions;

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
    '直连本地模式（推荐）：',
    '  node canvas-bridge.js --local [--port 17871] [--agent claude]',
    '',
    '  启动后终端会打印 Local URL 与 Connect token，把它们填进画布右上角',
    '  「本地 Agent」面板即可连接；浏览器直接访问本机 127.0.0.1，不经服务端中继。',
    '  加 --no-token 可跳过令牌：只允许本机画布页面连接（首次连接自动记住来源）。',
    '',
    '服务端中继模式：',
    '  node canvas-bridge.js --api <url> --token <key> --project <projectId> [options]',
    '',
    '通用选项：',
    `  --agent <name>     内置 Agent：${Object.keys(AGENT_BINARIES).join(' / ')}（默认 codex）`,
    '  --agent-cmd <cmd>  覆盖内置 Agent 启动命令',
    '  --agent-args <s>   追加给 Agent 进程的参数（空格分隔）',
    '',
    '本地模式选项：',
    `  --port <n>         监听端口（默认 ${DEFAULT_LOCAL_PORT}）`,
    `  --host <addr>      监听地址（默认 ${DEFAULT_LOCAL_HOST}，只允许本机访问）`,
    '  --local-token <s>  固定连接令牌（默认读取/生成 ~/.canvas-agent/local-agent.json）',
    '  --no-token         免令牌模式：只允许本机画布页面连接，首次连接自动记住来源',
    '',
    '中继模式选项：',
    '  --api <url>        画布 API 基地址，例如 http://localhost:8787',
    '  --token <key>      画布「Agent 连接」面板生成的连接密钥',
    '  --project <id>     画布项目 ID（面板生成的命令里已包含）',
    '',
    '  --help, -h         显示本帮助',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions | null {
  const values = new Map<string, string>();
  const allowed = new Set([
    'api',
    'token',
    'project',
    'agent',
    'agent-cmd',
    'agent-args',
    'local',
    'port',
    'host',
    'local-token',
    'no-token',
  ]);
  const booleanFlags = new Set(['local', 'no-token']);

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
    if (booleanFlags.has(name)) {
      values.set(name, '');
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      values.set(name, '');
    }
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
  const spec: AgentSpec = {
    agent: agentName,
    ...(agentCmd ? { agentCmd } : {}),
    agentArgs,
  };

  if (values.has('local')) {
    const rawPort = (values.get('port') ?? '').trim();
    const port = rawPort ? Number(rawPort) : DEFAULT_LOCAL_PORT;
    // 0 表示交给系统分配空闲端口（便于测试与多实例联调），启动后会打印实际地址。
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      fail(`--port 不是有效端口：${rawPort}`);
    }
    const host = (values.get('host') ?? '').trim() || DEFAULT_LOCAL_HOST;
    const localToken = values.get('local-token')?.trim();
    const noToken = values.has('no-token');
    if (noToken && localToken) {
      log.warn('--no-token 已启用，忽略 --local-token');
    }
    return {
      mode: 'local',
      host,
      port,
      noToken,
      ...spec,
      ...(localToken && !noToken ? { localToken } : {}),
    };
  }

  const api = values.get('api')?.trim() ?? '';
  if (!api) {
    fail('缺少 --api（服务端中继模式），或改用 --local 直连本地模式');
  }
  const token = values.get('token')?.trim() ?? '';
  if (!token) {
    fail('缺少 --token（从画布「Agent 连接」面板复制完整命令），或改用 --local');
  }
  const projectId = values.get('project')?.trim() ?? '';
  if (!projectId) {
    fail('缺少 --project（画布项目 ID），或改用 --local');
  }
  return {
    mode: 'relay',
    ...spec,
    api: api.replace(/\/+$/, ''),
    token,
    projectId,
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

/** 画布 MCP 地址；项目 ID 会编码，令牌放在 connection 查询参数里（API 侧强制该形式）。 */
function mcpUrlFor(options: { api: string; token: string; projectId: string }): string {
  return (
    `${options.api}/v1/projects/${encodeURIComponent(options.projectId)}` +
    `/mcp?connection=${encodeURIComponent(options.token)}`
  );
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

/** 事件出口：本地模式写 SSE，中继模式 POST 回画布 API。 */
interface EventSink {
  push(event: BridgeEvent): void;
  flush(): Promise<void>;
  close(): void;
}

/** 按任务串行、批量投递事件；保证 done 一定在最后一批之后。 */
class BatchSink implements EventSink {
  private buffer: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private scheduled = false;
  private closed = false;

  constructor(private readonly send: (lines: string[]) => Promise<void>) {}

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
        await this.send(batch);
      }
    });
  }
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
    private readonly options: RelayOptions,
    private readonly handlers: {
      onPrompt: (prompt: RelayPrompt) => void;
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
        this.handlers.onPrompt(parsed as RelayPrompt);
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

interface HostSession {
  bridgeSessionId: string;
  cwd: string;
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
  private readonly sessions = new Map<string, HostSession>();
  private readonly turns = new Map<string, TurnRecord>();
  private readonly sinks = new Map<string, EventSink>();
  private readonly currentTaskByAcpSession = new Map<string, string>();
  /** 已转发过的工具调用，避免权限请求再推一条重复的 tool_call。 */
  private readonly emittedToolCalls = new Set<string>();

  constructor(private readonly spec: AgentSpec) {}

  /** Agent 的工作目录按项目隔离：~/.canvas-agent/<projectId>。 */
  workdirFor(projectId: string | undefined): string {
    return join(AGENT_HOME_DIR, projectId ? encodeURIComponent(projectId) : 'local');
  }

  async handlePrompt(prompt: PromptRequest, sink: EventSink): Promise<void> {
    this.sinks.set(prompt.taskId, sink);
    try {
      const session = await this.ensureSession(prompt);
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

  private async ensureSession(prompt: PromptRequest): Promise<HostSession> {
    const existing = this.sessions.get(prompt.sessionId);
    if (existing) {
      return existing;
    }
    const connection = await this.ensureConnection();
    const cwd = this.workdirFor(prompt.projectId);
    mkdirSync(cwd, { recursive: true });
    const builder = connection.agent.buildSession(cwd);
    if (prompt.mcpUrl) {
      builder.withMcpServer({
        type: 'http',
        name: 'canvas',
        url: prompt.mcpUrl,
        headers: [],
      });
    }
    const acp = await builder.start();
    const session: HostSession = {
      bridgeSessionId: prompt.sessionId,
      cwd,
      acp,
      queue: Promise.resolve(),
    };
    this.sessions.set(prompt.sessionId, session);
    log.info(
      `session ready: bridge=${prompt.sessionId} acp=${acp.sessionId} ` +
        `mcp=${prompt.mcpUrl ? 'canvas' : 'none'} cwd=${cwd}`,
    );
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
    const spec = this.spec.agentCmd
      ? { cmd: this.spec.agentCmd, args: [] }
      : resolveBinary(AGENT_BINARIES[this.spec.agent]);
    const args = [...spec.args, ...this.spec.agentArgs];
    log.info(`starting agent: ${spec.cmd} ${args.join(' ')}`);
    const child = spawn(spec.cmd, args, {
      cwd: AGENT_HOME_DIR,
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
    this.notifyToolCall(request.sessionId, request.toolCall.toolCallId, title);
    if (!selected) {
      return { outcome: { outcome: 'cancelled' } };
    }
    log.info(`auto-approving "${title}" with ${selected.kind}`);
    return { outcome: { outcome: 'selected', optionId: selected.optionId } };
  }

  private notifyToolCall(acpSessionId: string, toolCallId: string, title: string): void {
    const key = `${acpSessionId}:${toolCallId}`;
    if (this.emittedToolCalls.has(key)) {
      return;
    }
    const taskId = this.currentTaskByAcpSession.get(acpSessionId);
    if (!taskId) {
      return;
    }
    this.emittedToolCalls.add(key);
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
    this.emittedToolCalls.clear();
  }

  private async runTurn(
    session: HostSession,
    prompt: PromptRequest,
    sink: EventSink,
  ): Promise<void> {
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

  private async consumeUpdates(session: HostSession, sink: EventSink): Promise<StopReason> {
    for (;;) {
      const message = await session.acp.nextUpdate();
      if (message.kind === 'stop') {
        return message.stopReason;
      }
      this.forwardUpdate(session, message.update, sink);
    }
  }

  private forwardUpdate(session: HostSession, update: SessionUpdate, sink: EventSink): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        if (update.content.type === 'text' && update.content.text) {
          sink.push({ type: 'agent_message_chunk', text: update.content.text });
        }
        return;
      }
      case 'tool_call': {
        const name = update.title || update.name || update.toolCallId;
        this.emittedToolCalls.add(`${session.acp.sessionId}:${update.toolCallId}`);
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

interface LocalConfig {
  token?: string;
  allowedOrigins?: string[];
}

function readLocalConfig(): LocalConfig {
  try {
    const raw = JSON.parse(readFileSync(LOCAL_CONFIG_PATH, 'utf8')) as unknown;
    return typeof raw === 'object' && raw !== null ? (raw as LocalConfig) : {};
  } catch {
    // 首次运行或配置损坏时按空配置处理。
    return {};
  }
}

function writeLocalConfig(config: LocalConfig): void {
  try {
    mkdirSync(dirname(LOCAL_CONFIG_PATH), { recursive: true });
    writeFileSync(LOCAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    log.warn(`无法保存本地配置：${errorMessage(error)}`);
  }
}

/** 本地模式：读取/生成稳定的连接令牌。 */
function loadLocalToken(override?: string): string {
  if (override) {
    return override;
  }
  const config = readLocalConfig();
  if (typeof config.token === 'string' && config.token.length >= 16) {
    return config.token;
  }
  const token = randomBytes(24).toString('base64url');
  writeLocalConfig({ ...config, token });
  return token;
}

/** 免令牌模式记住的画布页面来源；只允许本机（loopback）页面。 */
function loadAllowedOrigins(): string[] {
  const config = readLocalConfig();
  return Array.isArray(config.allowedOrigins)
    ? config.allowedOrigins.filter((origin): origin is string => typeof origin === 'string')
    : [];
}

function rememberOrigin(origin: string): void {
  const config = readLocalConfig();
  const key = originComparisonKey(origin);
  const others = loadAllowedOrigins().filter((item) => originComparisonKey(item) !== key);
  writeLocalConfig({ ...config, allowedOrigins: [...others, origin] });
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function parseOrigin(origin: string): URL | undefined {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  const url = parseOrigin(origin);
  return url ? LOOPBACK_HOSTNAMES.has(url.hostname) : false;
}

/** localhost / 127.0.0.1 / [::1] 视为同一来源，只按端口区分。 */
function originComparisonKey(origin: string): string {
  const url = parseOrigin(origin);
  if (!url) {
    return origin;
  }
  return isLoopbackOrigin(origin) ? `loopback:${url.port || '80'}` : origin;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'request_too_large', '请求体超过 1MiB');
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', '请求体不是有效的 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

interface LocalSessionState {
  id: string;
  projectId?: string;
  mcpUrl?: string;
  clients: Set<ServerResponse>;
  currentTaskId?: string;
}

/**
 * 本地 Agent 服务：监听 127.0.0.1，供画布页面直接连接。
 *
 *  - GET    /health                     → 服务信息（无需令牌，用于探测）
 *  - POST   /sessions                   → 建立桥接会话，body { projectId?, mcpUrl? }
 *  - GET    /sessions/:id/events        → SSE 事件流
 *  - POST   /sessions/:id/prompt        → 发送提示词，body { messages }
 *  - POST   /sessions/:id/cancel        → 取消当前任务
 *  - DELETE /sessions/:id               → 结束会话
 *
 * 默认要求 `Authorization: Bearer <Connect token>`；用 --no-token 启动时改为
 * 只允许本机画布页面来源（首次连接记住来源并写入配置文件），/health 暴露 auth 模式。
 */
class LocalAgentServer {
  private readonly sessions = new Map<string, LocalSessionState>();
  private readonly tokenBuffer?: Buffer;
  private readonly allowedOrigins: Set<string>;
  private server?: Server;
  private closing = false;

  constructor(
    private readonly options: {
      host: string;
      port: number;
      token?: string;
      allowedOrigins: string[];
      agentLabel: string;
    },
    private readonly host: AgentHost,
  ) {
    this.tokenBuffer = options.token ? Buffer.from(options.token) : undefined;
    this.allowedOrigins = new Set(options.allowedOrigins);
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.port, this.options.host);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : this.options.port;
    return `http://${this.options.host}:${port}`;
  }

  async stop(): Promise<void> {
    this.closing = true;
    for (const session of this.sessions.values()) {
      for (const client of session.clients) {
        client.end();
      }
      session.clients.clear();
    }
    this.sessions.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.applyCors(request, response);
    const url = new URL(request.url ?? '/', `http://${this.options.host}`);
    try {
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        this.sendJson(response, 200, {
          ok: true,
          name: BRIDGE_NAME,
          version: BRIDGE_VERSION,
          agent: this.options.agentLabel,
          auth: this.tokenBuffer ? 'token' : 'none',
        });
        return;
      }
      const denied = this.authorizationFailure(request);
      if (denied) {
        this.sendJson(response, denied.status, { code: denied.code, error: denied.error });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/sessions') {
        await this.createSession(request, response);
        return;
      }
      const match = /^\/sessions\/([A-Za-z0-9-]+)(\/events|\/prompt|\/cancel)?$/.exec(url.pathname);
      if (!match) {
        this.sendJson(response, 404, { code: 'not_found', error: '未知接口' });
        return;
      }
      const session = this.sessions.get(match[1] ?? '');
      if (!session) {
        this.sendJson(response, 404, { code: 'session_not_found', error: '会话不存在或已结束' });
        return;
      }
      const action = match[2] ?? '';
      if (request.method === 'GET' && action === '/events') {
        this.openEvents(response, session);
        return;
      }
      if (request.method === 'POST' && action === '/prompt') {
        await this.prompt(request, response, session);
        return;
      }
      if (request.method === 'POST' && action === '/cancel') {
        this.cancel(response, session);
        return;
      }
      if (request.method === 'DELETE' && action === '') {
        this.removeSession(session);
        response.writeHead(204);
        response.end();
        return;
      }
      this.sendJson(response, 405, { code: 'method_not_allowed', error: '不支持的请求方法' });
    } catch (error) {
      if (error instanceof HttpError) {
        this.sendJson(response, error.status, { code: error.code, error: error.message });
        return;
      }
      log.warn(`local request failed: ${errorMessage(error)}`);
      this.sendJson(response, 500, { code: 'internal_error', error: '本地 Agent 处理请求失败' });
    }
  }

  private applyCors(request: IncomingMessage, response: ServerResponse): void {
    const origin = request.headers.origin;
    response.setHeader(
      'access-control-allow-origin',
      typeof origin === 'string' && origin !== 'null' ? origin : '*',
    );
    response.setHeader('vary', 'origin');
    response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('access-control-allow-headers', 'authorization, content-type, accept');
    response.setHeader('access-control-max-age', '600');
    // Chrome 的 Private Network Access 预检。
    response.setHeader('access-control-allow-private-network', 'true');
  }

  /** 校验请求身份：令牌模式比对 Bearer，免令牌模式只放行本机画布页面来源。 */
  private authorizationFailure(
    request: IncomingMessage,
  ): { status: number; code: string; error: string } | undefined {
    if (this.tokenBuffer) {
      const header = request.headers.authorization ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      const presented = Buffer.from(match?.[1]?.trim() ?? '');
      const ok =
        presented.length === this.tokenBuffer.length &&
        timingSafeEqual(presented, this.tokenBuffer);
      return ok
        ? undefined
        : {
            status: 401,
            code: 'invalid_token',
            error: '连接令牌无效，请使用桥接启动时打印的 Connect token',
          };
    }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin.trim() : '';
    if (!origin || origin === 'null') {
      return {
        status: 403,
        code: 'origin_required',
        error: '免令牌模式只接受浏览器页面连接，请从画布的「本地 Agent」面板连接',
      };
    }
    if (!isLoopbackOrigin(origin)) {
      return {
        status: 403,
        code: 'origin_rejected',
        error: `免令牌模式只允许本机画布页面连接，已拒绝来源 ${origin}`,
      };
    }
    if (this.allowedOrigins.size === 0) {
      this.allowedOrigins.add(origin);
      rememberOrigin(origin);
      log.info(`local no-token mode: remembered origin ${origin}`);
      return undefined;
    }
    const key = originComparisonKey(origin);
    for (const allowed of this.allowedOrigins) {
      if (originComparisonKey(allowed) === key) {
        return undefined;
      }
    }
    return {
      status: 403,
      code: 'origin_rejected',
      error:
        '免令牌模式只允许首次连接的本机画布页面；如果换了访问地址，' +
        `请删除 ${LOCAL_CONFIG_PATH} 后重启桥接程序`,
    };
  }

  private async createSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    const projectId =
      typeof body.projectId === 'string' && body.projectId.trim()
        ? body.projectId.trim().slice(0, 200)
        : undefined;
    let mcpUrl: string | undefined;
    if (typeof body.mcpUrl === 'string' && body.mcpUrl.trim()) {
      const candidate = body.mcpUrl.trim();
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('unsupported protocol');
        }
      } catch {
        throw new HttpError(400, 'invalid_mcp_url', 'mcpUrl 必须是 http(s) 地址');
      }
      mcpUrl = candidate;
    }
    const session: LocalSessionState = {
      id: randomUUID(),
      ...(projectId ? { projectId } : {}),
      ...(mcpUrl ? { mcpUrl } : {}),
      clients: new Set<ServerResponse>(),
    };
    this.sessions.set(session.id, session);
    log.info(
      `local session created: ${session.id} project=${projectId ?? '-'} ` +
        `mcp=${mcpUrl ? 'canvas' : 'none'}`,
    );
    this.sendJson(response, 201, { sessionId: session.id });
  }

  private openEvents(response: ServerResponse, session: LocalSessionState): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');
    session.clients.add(response);
    const timer = setInterval(() => {
      try {
        response.write(': ping\n\n');
      } catch {
        // 客户端已断开，close 事件会清理。
      }
    }, HEARTBEAT_MS);
    timer.unref();
    response.on('close', () => {
      clearInterval(timer);
      session.clients.delete(response);
    });
  }

  private async prompt(
    request: IncomingMessage,
    response: ServerResponse,
    session: LocalSessionState,
  ): Promise<void> {
    const body = await readJsonBody(request);
    const messages = Array.isArray(body.messages)
      ? body.messages
          .filter(
            (item): item is { role?: unknown; content: unknown } =>
              typeof item === 'object' && item !== null,
          )
          .filter((item) => typeof item.content === 'string')
          .map((item) => ({ role: String(item.role ?? 'user'), content: String(item.content) }))
      : [];
    if (!messages.some((message) => message.role === 'user' && message.content.trim())) {
      throw new HttpError(400, 'invalid_prompt', 'messages 里没有用户消息');
    }
    if (session.currentTaskId) {
      throw new HttpError(409, 'prompt_in_progress', '上一轮还在进行中，请先停止或等待结束');
    }
    const taskId = randomUUID();
    session.currentTaskId = taskId;
    const sink = new BatchSink(async (lines) => {
      this.broadcast(session, lines);
    });
    void this.host
      .handlePrompt(
        {
          taskId,
          sessionId: session.id,
          ...(session.projectId ? { projectId: session.projectId } : {}),
          ...(session.mcpUrl ? { mcpUrl: session.mcpUrl } : {}),
          messages,
        },
        sink,
      )
      .finally(() => {
        if (session.currentTaskId === taskId) {
          session.currentTaskId = undefined;
        }
      });
    this.sendJson(response, 202, { taskId });
  }

  private cancel(response: ServerResponse, session: LocalSessionState): void {
    const taskId = session.currentTaskId;
    if (!taskId) {
      this.sendJson(response, 409, { code: 'no_active_task', error: '当前没有进行中的任务' });
      return;
    }
    this.host.cancel(taskId);
    response.writeHead(204);
    response.end();
  }

  private removeSession(session: LocalSessionState): void {
    for (const client of session.clients) {
      client.end();
    }
    session.clients.clear();
    this.sessions.delete(session.id);
    log.info(`local session closed: ${session.id}`);
  }

  private broadcast(session: LocalSessionState, lines: string[]): void {
    for (const line of lines) {
      const chunk = `data: ${line}\n\n`;
      for (const client of [...session.clients]) {
        try {
          client.write(chunk);
        } catch {
          session.clients.delete(client);
        }
      }
    }
  }

  private sendJson(response: ServerResponse, status: number, payload: unknown): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    const body = JSON.stringify(payload);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    response.end(body);
  }
}

function installShutdown(handler: () => Promise<void>): () => void {
  let shuttingDown = false;
  return (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    void handler().finally(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2_000).unref();
  };
}

async function runLocal(options: LocalOptions): Promise<void> {
  const token = options.noToken ? undefined : loadLocalToken(options.localToken);
  const allowedOrigins = loadAllowedOrigins();
  const host = new AgentHost(options);
  const server = new LocalAgentServer(
    {
      host: options.host,
      port: options.port,
      ...(token ? { token } : {}),
      allowedOrigins,
      agentLabel: options.agentCmd ?? options.agent,
    },
    host,
  );

  let url: string;
  try {
    url = await server.start();
  } catch (error) {
    log.warn(`无法监听 ${options.host}:${options.port}：${errorMessage(error)}`);
    process.exit(1);
  }

  process.on(
    'SIGINT',
    installShutdown(() => server.stop().then(() => host.close())),
  );
  process.on(
    'SIGTERM',
    installShutdown(() => server.stop().then(() => host.close())),
  );
  process.on('unhandledRejection', (reason: unknown) => {
    log.warn(`unhandled rejection: ${errorMessage(reason)}`);
  });

  const authLines = token
    ? [
        `Connect token: ${token}`,
        '在画布右上角「本地 Agent」面板填入上面的地址与令牌后点「连接」。',
        `令牌已保存到 ${LOCAL_CONFIG_PATH}，下次启动复用。`,
      ]
    : [
        '免令牌模式：画布页面直接连接，不需要填写令牌。',
        allowedOrigins.length > 0
          ? `已记住的页面来源：${allowedOrigins.join(', ')}`
          : '首次连接会自动记住本机画布页面来源。',
        `如需重置来源，删除 ${LOCAL_CONFIG_PATH} 后重启。`,
      ];
  process.stdout.write(
    [
      '',
      'canvas-bridge 本地 Agent 已启动',
      `Local URL: ${url}`,
      ...authLines,
      `Agent: ${options.agentCmd ?? options.agent}`,
      '',
    ].join('\n') + '\n',
  );
  log.info(`local agent listening on ${url} (pid ${process.pid})`);
  await new Promise<void>(() => undefined);
}

async function runRelay(options: RelayOptions): Promise<void> {
  const host = new AgentHost(options);
  const relay = new ApiRelay(options, {
    onPrompt: (prompt) => {
      const sink = new BatchSink((lines) =>
        relay.postEvents(prompt.taskId, prompt.projectId, lines),
      );
      void host.handlePrompt(
        {
          taskId: prompt.taskId,
          sessionId: prompt.sessionId,
          projectId: prompt.projectId,
          mcpUrl: mcpUrlFor(options),
          messages: prompt.messages,
        },
        sink,
      );
    },
    onCancel: (taskId) => {
      host.cancel(taskId);
    },
  });

  process.on(
    'SIGINT',
    installShutdown(async () => {
      relay.stop();
      await host.close();
    }),
  );
  process.on(
    'SIGTERM',
    installShutdown(async () => {
      relay.stop();
      await host.close();
    }),
  );
  process.on('unhandledRejection', (reason: unknown) => {
    log.warn(`unhandled rejection: ${errorMessage(reason)}`);
  });

  log.info(
    `canvas bridge ${BRIDGE_VERSION} relay mode (agent: ${options.agentCmd ?? options.agent}, ` +
      `project: ${options.projectId})`,
  );
  log.info(`workspace: ${host.workdirFor(options.projectId)}`);

  relay.start();
  await new Promise<void>(() => undefined);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    return;
  }
  mkdirSync(AGENT_HOME_DIR, { recursive: true });
  if (options.mode === 'local') {
    await runLocal(options);
  } else {
    await runRelay(options);
  }
}

void main().catch((error: unknown) => {
  log.warn(`fatal: ${errorMessage(error)}`);
  process.exit(1);
});
