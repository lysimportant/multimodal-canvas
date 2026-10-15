// Wire-level probe: speaks the same app-server JSON-RPC protocol that
// @deepseek-ai/dsh-subagent-codex (wire.ts) uses, against the Codex payload
// installed into the desktop profile. Verifies the exact DSH delegation path
// (initialize -> thread/start -> turn/start -> turn/completed) end to end.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const CODEX = 'C:\\Users\\Sui\\.dsh\\profiles\\desktop\\node_modules\\@openai\\codex\\bin\\codex.js';
const CWD = 'G:\\multimodal-canvas';
const PROMPT =
  'Do not use any tools, commands, or file reads. Reply with exactly two lines:\n' +
  'line1 = MARKER-QX7-4E91\n' +
  'line2 = 17*19=<number>';

const child = spawn(process.execPath, [CODEX, 'app-server', '--stdio'], {
  cwd: CWD,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
  windowsHide: true,
});

let nextId = 1;
const pending = new Map();
let threadId = null;
let turnId = null;
let finalAnswer = null;
let unphased = null;
let turnStatus = null;

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log('[non-json]', line.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${p.method} -> ${JSON.stringify(msg.error)}`));
    else p.resolve(msg.result);
    return;
  }
  if (msg.id !== undefined && msg.method) {
    console.log('[server-request]', msg.method, JSON.stringify(msg.params ?? {}).slice(0, 300));
    if (/Approval/.test(msg.method)) send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } });
    else send({ jsonrpc: '2.0', id: msg.id, result: {} });
    return;
  }
  if (msg.method === 'item/completed') {
    const item = msg.params?.item;
    if (item?.type === 'agentMessage') {
      if (item.phase === 'final_answer') finalAnswer = item.text;
      else if (item.phase === null || item.phase === undefined) unphased = item.text;
    }
  }
  if (msg.method === 'turn/completed') turnStatus = msg.params?.turn?.status;
});
child.stderr.on('data', (d) => process.stderr.write('[child stderr] ' + String(d)));

const guard = setTimeout(() => {
  console.log('RESULT: TIMEOUT');
  child.kill();
  process.exit(2);
}, 240000);

try {
  const init = await request('initialize', {
    clientInfo: { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '0.0.1' },
    capabilities: { experimentalApi: false, requestAttestation: false },
  });
  console.log('initialize -> OK', JSON.stringify(init).slice(0, 300));
  notify('initialized', {});

  const thread = await request('thread/start', {
    cwd: CWD,
    ephemeral: true,
    approvalPolicy: 'never',
  });
  threadId = thread?.thread?.id;
  console.log('thread/start -> threadId =', threadId, '| ephemeral =', thread?.thread?.ephemeral, '| model =', thread?.model ?? '(none)');

  const turn = await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPT, text_elements: [] }],
  });
  turnId = turn?.turn?.id;
  console.log('turn/start -> turnId =', turnId);

  const started = Date.now();
  while (!turnStatus && Date.now() - started < 200000) await new Promise((r) => setTimeout(r, 250));

  console.log('turn/completed status =', turnStatus);
  console.log('selected answer (final_answer) =', JSON.stringify(finalAnswer));
  console.log('fallback answer (phase null)   =', JSON.stringify(unphased));
  const chosen = (finalAnswer ?? unphased ?? '').trim();
  console.log('ANSWER =', JSON.stringify(chosen));
  console.log('RESULT:', chosen.includes('MARKER-QX7-4E91') && chosen.includes('323') ? 'PASS' : 'CHECK');
} catch (e) {
  console.log('RESULT: FAILED ->', e.message);
} finally {
  clearTimeout(guard);
  child.kill();
}
