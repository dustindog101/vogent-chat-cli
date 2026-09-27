import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, traceChatReadback } from '../chat.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'chat.mjs');

function frame(payload, opcode = 1) {
  const body = Buffer.from(payload);
  let head;
  if (body.length < 126) head = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length <= 0xffff) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([head, body]);
}

function clientFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const long = buffer.readBigUInt64BE(offset + 2);
      if (long > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('fixture frame too large');
      length = Number(long);
      header = 10;
    }
    const masked = Boolean(second & 0x80);
    const maskLength = masked ? 4 : 0;
    if (offset + header + maskLength + length > buffer.length) break;
    const mask = masked ? buffer.subarray(offset + header, offset + header + 4) : null;
    const start = offset + header + maskLength;
    const body = Buffer.from(buffer.subarray(start, start + length));
    if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    frames.push({ opcode: first & 0x0f, text: body.toString('utf8'), body });
    offset = start + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

async function fixture({ mode = 'success', functionDefinition = null, fillEmptyStringVariables = true } = {}) {
  const stats = { creates: 0, subscriptions: 0, requests: [], callInputs: [], websocketMessages: [] };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    stats.requests.push({ method: req.method, path: url.pathname });
    const json = (value, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      return json({ data: [{ id: 'agent-fixture', name: 'Fixture Agent', defaultVersionedPromptId: 'prompt-1',
        linkedFunctionDefinitions: functionDefinition ? [{ functionDefinitionId: 'function-1' }] : [] }], cursor: null });
    }
    if (req.method === 'GET' && url.pathname === '/api/phone_numbers') return json({ data: [], cursor: null });
    if (req.method === 'GET' && url.pathname === '/api/agents/agent-fixture/versioned_prompts/prompt-1') {
      return json({ id: 'prompt-1', agentType: 'CUSTOM_FLOW', flowDefinition: { nodes: [{ id: 'q1', type: 'question' }] }, settings: { fillEmptyStringVariables } });
    }
    if (req.method === 'GET' && url.pathname === '/api/functions/function-1') return json({ data: functionDefinition });
    if (req.method === 'GET' && url.pathname === '/api/dials/dial-existing') {
      return json({ data: {
        id: 'dial-existing', versionedPromptId: 'prompt-historical', status: 'completed', aiResult: 'completed',
        transcript: [{ timestamp: '2026-01-01T00:00:00Z', role: 'AI', text: 'Sensitive synthetic transcript' }],
        functionCalls: [{ timestamp: '2026-01-01T00:00:01Z', id: 'fc-1', name: 'commit_answer', arguments: '{"patientId":"secret-patient"}' }],
        nodeTransition: [{ timestamp: '2026-01-01T00:00:02Z', fromNodeId: 'n1', toNodeId: 'n2', transitionData: { ok: true } }],
        recordings: [{ url: 'https://recordings.example.test/call-1.wav' }],
      } });
    }
    if (req.method === 'POST' && url.pathname === '/query') {
      let body = '';
      for await (const part of req) body += part;
      const query = JSON.parse(body);
      if (query.query.includes('createAiChat')) {
        stats.creates++;
        stats.callInputs.push(query.variables.input.callAgentInput);
        return json({ data: { createAiChat: { id: `chat-${stats.creates}` } } });
      }
      if (query.query.includes('aiChat(')) {
        const id = query.variables.id;
        return json({ data: { aiChat: { id, transcript: [
          { role: 'HUMAN', text: 'Sensitive synthetic request' },
          { role: 'AI', text: 'Sensitive synthetic response', functionCalls: [{ id: 'fc-2', name: 'commit_answer', arguments: '{"patientId":"secret-patient"}' }], nodeTransitionResult: null },
        ] } } });
      }
      return json({ errors: [{ message: 'unknown fixture operation' }] });
    }
    return json({ error: 'not found' }, 404);
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    const send = data => { if (!socket.destroyed) socket.write(frame(JSON.stringify(data))); };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = clientFrames(buffer);
      buffer = decoded.rest;
      for (const item of decoded.frames) {
        if (item.opcode === 8) {
          socket.write(frame(item.body, 8));
          socket.end();
          continue;
        }
        if (item.opcode !== 1) continue;
        let message;
        try { message = JSON.parse(item.text); } catch { continue; }
        stats.websocketMessages.push(message.type || 'unknown');
        if (message.type === 'connection_init') send({ type: 'connection_ack' });
        if (message.type === 'subscribe' && message.id === '1') {
          const turn = ++stats.subscriptions;
          if (mode === 'later_graphql_error' && turn === 2) {
            send({ id: '1', type: 'next', payload: { errors: [{ message: 'synthetic later-turn error' }] } });
            send({ id: '1', type: 'complete' });
          } else if (mode === 'empty') send({ id: '1', type: 'complete' });
          else if (mode === 'malformed') socket.write(frame('{malformed'));
          else if (mode === 'premature_close') socket.destroy();
          else {
            send({ id: '1', type: 'next', payload: { data: { runChatQueryStream: { messageType: 'NEW_SPEAKER_RES', text: 'Reply', transcriptLine: { role: 'AI', text: 'Reply' } } } } });
            send({ id: '1', type: 'next', payload: { data: { runChatQueryStream: { messageType: 'APPEND_TEXT', text: ' text', transcriptLine: { role: 'AI', text: 'Reply text' } } } } });
            send({ id: '1', type: 'complete' });
          }
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server, stats, apiBase: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/query`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function runCli(args, { apiBase, wsUrl, dataDir, env = {} }) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, VOGENT_API_KEY: 'fixture-secret-token', VOGENT_API_BASE_URL: apiBase,
      VOGENT_WS_URL: wsUrl, VOGENT_CHAT_HOME: dataDir, VOGENT_CHAT_TIMEOUT_MS: '3000', NODE_NO_WARNINGS: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

async function makeDataDir() { return mkdtemp(join(tmpdir(), 'vogent-cli-core-')); }

test('parser preserves a flag-looking raw message and validates JSON call inputs before mutation', async () => {
  assert.throws(() => parseArgs(['--agent', 'agent-fixture', '--message', '--inspect']), /Missing value for --message/);
  const parsed = parseArgs(['--agent', 'agent-fixture', '--message=--inspect']);
  assert.deepEqual(parsed.messages, ['--inspect']);
  assert.equal(parsed.inspect, false);

  const local = await fixture();
  const dataDir = await makeDataDir();
  try {
    const result = await runCli(['start', '--agent', 'agent-fixture', '--call-input', 'not-json', '--output', 'json'], { ...local, dataDir });
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).error.kind, 'argument_error');
    assert.equal(local.stats.creates, 0);
    assert.equal(result.stderr, '');
  } finally {
    await local.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('CLI writes structured durable private evidence and reduces repeated transcript events once', async () => {
  const local = await fixture();
  const dataDir = await makeDataDir();
  try {
    const result = await runCli(['start', '--agent', 'agent-fixture', '--ack-target', 'agent-fixture', '--call-input', '{"caller":"synthetic"}',
      '--message', 'hello', '--output', 'json'], { ...local, dataDir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.schema, 'vogent-chat-run.v1');
    assert.equal(envelope.turns[0].reply, 'Reply text');
    assert.equal(local.stats.callInputs[0].caller, 'synthetic');
    assert.equal(result.stdout.includes('Text chat creates'), false);
    assert.equal(result.stdout.includes('fixture-secret-token'), false);
    const runNames = await readdir(join(dataDir, 'runs'));
    assert.equal(runNames.length, 1);
    const journalPath = join(dataDir, 'runs', runNames[0]);
    const records = (await readFile(journalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.some(item => item.type === 'turn_submitted'));
    assert.ok(records.some(item => item.type === 'stream_event'));
    assert.ok(records.some(item => item.type === 'turn_complete'));
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    const sessionNames = await readdir(join(dataDir, 'sessions'));
    assert.equal(sessionNames.length, 1);
    assert.equal((await stat(join(dataDir, 'sessions', sessionNames[0]))).mode & 0o777, 0o600);
  } finally {
    await local.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('failed later turn keeps earlier evidence and does not retry an uncertain write', async () => {
  const local = await fixture({ mode: 'later_graphql_error' });
  const dataDir = await makeDataDir();
  try {
    const result = await runCli(['--agent', 'agent-fixture', '--ack-target', 'agent-fixture', '--message', 'first', '--message', 'second', '--output', 'json'], { ...local, dataDir });
    assert.equal(result.code, 1);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, 'incomplete');
    assert.equal(envelope.turns[0].status, 'complete');
    assert.equal(envelope.turns[1].outcome, 'outcome_unknown');
    assert.equal(local.stats.subscriptions, 2);
    const runNames = await readdir(join(dataDir, 'runs'));
    const records = (await readFile(join(dataDir, 'runs', runNames[0]), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.some(item => item.type === 'turn_complete' && item.data.index === 0));
    assert.ok(records.some(item => item.type === 'turn_incomplete' && item.data.index === 1));
    assert.equal(records.at(-1).data.status, 'incomplete');
  } finally {
    await local.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('empty completion, malformed frames, and premature close fail with typed uncertain outcomes', async t => {
  for (const [mode, kind] of [['empty', 'empty_completion'], ['malformed', 'malformed_frame'], ['premature_close', 'premature_close']]) {
    await t.test(mode, async () => {
      const local = await fixture({ mode });
      const dataDir = await makeDataDir();
      try {
        const result = await runCli(['--agent', 'agent-fixture', '--ack-target', 'agent-fixture', '--message', 'hello', '--output', 'json'], { ...local, dataDir });
        assert.equal(result.code, 1);
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.turns[0].failureKind, kind);
        assert.equal(envelope.turns[0].outcome, 'outcome_unknown');
      } finally {
        await local.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test('chat and dial readback are read-only; exports expose traces and redact sensitive fields', async () => {
  const local = await fixture();
  const dataDir = await makeDataDir();
  try {
    const chat = await runCli(['get', '--chat-id', 'saved-chat', '--redact', '--output', 'json'], { ...local, dataDir });
    assert.equal(chat.code, 0, chat.stderr);
    const trace = JSON.parse(chat.stdout);
    assert.equal(trace.availability.functionCalls, 'available');
    assert.equal(trace.availability.nodeTransitions, 'unavailable');
    assert.equal(trace.functionCalls[0].classification, 'internal_commit_answer');
    assert.equal(chat.stdout.includes('Sensitive synthetic response'), false);
    assert.equal(chat.stdout.includes('secret-patient'), false);
    const dial = await runCli(['dial', 'export', '--dial-id', 'dial-existing', '--redact', '--output', 'json'], { ...local, dataDir });
    assert.equal(dial.code, 0, dial.stderr);
    const history = JSON.parse(dial.stdout);
    assert.equal(history.executedVersionedPromptId, 'prompt-historical');
    assert.equal(history.recordingInspected, false);
    assert.equal(dial.stdout.includes('Sensitive synthetic transcript'), false);
    assert.equal(dial.stdout.includes('secret-patient'), false);
    assert.equal(local.stats.creates, 0);
    assert.equal(local.stats.subscriptions, 0);
  } finally {
    await local.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('configuration snapshots preserve schema shape, exclude header/body literals, and detect setting drift', async () => {
  const functionDefinition = {
    id: 'function-1', name: 'fixture_lookup', type: 'api',
    apiPath: 'https://staging.example.test/v1/lookup?api_key=query-secret',
    apiSchema: { method: 'POST', headers: { 'X-Tenant-Key': 'header-secret' }, body: { patient_name: 'body-patient-value' } },
    inputSchema: { type: 'object', properties: { patient_name: { type: 'string', description: 'private caller value' } }, required: ['patient_name'] },
  };
  const beforeServer = await fixture({ functionDefinition, fillEmptyStringVariables: true });
  const afterServer = await fixture({ functionDefinition, fillEmptyStringVariables: false });
  const dataDir = await makeDataDir();
  const beforeFile = join(dataDir, 'before.json');
  const afterFile = join(dataDir, 'after.json');
  try {
    const before = await runCli(['config', 'snapshot', '--agent', 'agent-fixture', '--out', beforeFile, '--output', 'json'], { ...beforeServer, dataDir });
    const after = await runCli(['config', 'snapshot', '--agent', 'agent-fixture', '--out', afterFile, '--output', 'json'], { ...afterServer, dataDir });
    assert.equal(before.code, 0, before.stderr);
    assert.equal(after.code, 0, after.stderr);
    for (const output of [before.stdout, after.stdout, await readFile(beforeFile, 'utf8'), await readFile(afterFile, 'utf8')]) {
      for (const secret of ['header-secret', 'body-patient-value', 'query-secret', 'private caller value']) assert.equal(output.includes(secret), false);
    }
    const snapshot = JSON.parse(before.stdout);
    assert.equal(snapshot.functions[0].inputSchema.properties.patient_name.type, 'string');
    assert.deepEqual(snapshot.functions[0].inputSchema.required, ['patient_name']);
    assert.deepEqual(snapshot.functions[0].apiSchema.headerNames, ['X-Tenant-Key']);
    assert.equal(snapshot.functions[0].apiSchema.body.patient_name, '[REDACTED]');
    assert.equal(snapshot.functions[0].apiTarget.host, 'staging.example.test');
    const diff = await runCli(['config', 'diff', '--before', beforeFile, '--after', afterFile, '--output', 'json'], { ...beforeServer, dataDir });
    assert.equal(diff.code, 0, diff.stderr);
    const changes = JSON.parse(diff.stdout);
    assert.equal(changes.changed, true);
    assert.ok(changes.differences.some(item => item.path.includes('fillEmptyStringVariables')));
    assert.equal(beforeServer.stats.creates + afterServer.stats.creates, 0);
  } finally {
    await beforeServer.close();
    await afterServer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('cross-process send records unsupported resume and never replays the message', async () => {
  const local = await fixture();
  const dataDir = await makeDataDir();
  try {
    const result = await runCli(['send', '--chat-id', 'saved-chat', '--message', 'do not repeat', '--output', 'json'], { ...local, dataDir });
    assert.equal(result.code, 2);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.status, 'unsupported');
    assert.equal(envelope.replayAttempted, false);
    assert.equal(local.stats.creates, 0);
    assert.equal(local.stats.subscriptions, 0);
    const records = await readFile(envelope.journalPath, 'utf8');
    assert.ok(records.includes('resume_unsupported'));
  } finally {
    await local.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('locally created sessions continue across CLI processes after readback and exact-agent checks', async () => {
  const local = await fixture();
  const dataDir = await makeDataDir();
  try {
    const started = await runCli(['start', '--agent', 'agent-fixture', '--ack-target', 'agent-fixture', '--message', 'hello', '--output', 'json'], { ...local, dataDir });
    assert.equal(started.code, 0, started.stderr);
    const first = JSON.parse(started.stdout);
    assert.equal(first.status, 'complete');
    const sent = await runCli(['send', '--chat-id', first.chat.id, '--agent', 'agent-fixture', '--ack-target', 'agent-fixture', '--message', 'where is the clinic?', '--output', 'json'], { ...local, dataDir });
    assert.equal(sent.code, 0, sent.stderr);
    const second = JSON.parse(sent.stdout);
    assert.equal(second.sessionMode, 'resumed');
    assert.equal(second.resumeEvidence.status, 'stream_completed_on_existing_chat_id');
    assert.equal(second.chat.providerProvenAgentBinding, false, sent.stdout);
    assert.equal(local.stats.creates, 1);
    assert.equal(local.stats.subscriptions, 2);
    assert.ok(local.stats.requests.some(request => request.method === 'POST' && request.path === '/query'));
  } finally {
    await local.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('readback trace preserves provider provenance and available fields', () => {
  const trace = traceChatReadback({ status: 'available', provenance: 'fixture readback', capabilities: { functionCalls: 'requested' },
    data: { id: 'chat-1', transcript: [{ role: 'AI', functionCalls: [{ id: 'f1', name: 'commit_answer' }], nodeTransitionResult: null }] } });
  assert.equal(trace.functionCalls[0].provenance, 'aiChat readback transcript.functionCalls');
  assert.equal(trace.availability.nodeTransitionResult, 'unavailable');
  assert.equal(trace.availability.backendFunctionResults, 'unavailable_in_chat_schema');
});
