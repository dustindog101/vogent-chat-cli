import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CLI = join(ROOT, 'chat.mjs');
const TARGET = 'agent-fixture';
const PROMPT = 'prompt-fixture';
const FUNCTION = 'function-fixture';

const expectedAppointment = {
  patient_id: 901,
  doctor_id: 7,
  slot_id: 41,
  location_code: 'EAST',
  body_part: 'knee',
  issue_type: 'follow_up',
  appointment_time: '2030-06-03T14:00:00+00:00',
  formatted_time: 'Monday, June 03 at 10:00 AM',
  doctor_name: 'Dr. Example',
  location_name: 'East Clinic',
  status: 'SCHEDULED',
};

function appointment(id) {
  return { id, ...expectedAppointment };
}

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

function decodeClientFrames(buffer) {
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
    if (masked) for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
    frames.push({ opcode: first & 0x0f, text: body.toString('utf8') });
    offset = start + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

const offerReply = 'I can offer Monday, June 03 at 10:00 AM with Dr. Example at East Clinic.';
const choiceReply = 'Monday, June 03 at 10:00 AM with Dr. Example at East Clinic. Should I book that?';
const bookedReply = 'Confirmed: Monday, June 03 at 10:00 AM with Dr. Example at East Clinic.';

async function providerFixture({
  replies = [offerReply, choiceReply, bookedReply],
  afterAppointments = [appointment(92)],
  promptForRead = null,
} = {}) {
  const state = {
    requests: [], creates: 0, callInputs: [], chats: new Map(), turnInputs: [],
    subscriptions: 0, appointmentReads: 0, appointmentMethods: [], sockets: new Set(), promptReads: 0,
  };
  const functionDefinition = {
    id: FUNCTION,
    name: 'safe_test_lookup',
    type: 'api',
    apiPath: 'https://staging.example.test/v16/api/test-lookup',
    apiSchema: {
      headers: { 'X-Tenant-Key': 'header-secret' },
      body: { patient_name: 'body-patient-value' },
    },
    inputSchema: { type: 'object', properties: { caller_phone: { type: 'string' } }, required: ['caller_phone'] },
  };
  const agent = {
    id: TARGET,
    name: 'Synthetic staging fixture',
    defaultVersionedPromptId: PROMPT,
    linkedFunctionDefinitions: [{ functionDefinitionId: FUNCTION }],
  };
  const prompt = {
    id: PROMPT,
    agentType: 'CUSTOM_FLOW',
    settings: { fillEmptyStringVariables: true },
    flowDefinition: { nodes: [{ id: 'lookup', type: 'function', nodeData: { functionId: FUNCTION } }] },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    state.requests.push({ method: request.method, path: url.pathname });
    const json = (value, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.method === 'GET' && url.pathname === '/api/agents') return json({ data: [agent], cursor: null });
    if (request.method === 'GET' && url.pathname === '/api/phone_numbers') return json({ data: [], cursor: null });
    if (request.method === 'GET' && url.pathname === `/api/agents/${TARGET}/versioned_prompts/${PROMPT}`) {
      state.promptReads++;
      return json(promptForRead ? promptForRead(state.promptReads, prompt) : prompt);
    }
    if (request.method === 'GET' && url.pathname === `/api/functions/${FUNCTION}`) return json(functionDefinition);
    if (request.method === 'GET' && url.pathname === '/api/dials/dial-existing') return json({ data: {
      id: 'dial-existing', versionedPromptId: 'prompt-historical', status: 'completed', aiResult: 'completed',
      transcript: [{ timestamp: '2030-01-01T10:00:00Z', role: 'AI', text: 'Historical synthetic call.' }],
      functionCalls: [{ timestamp: '2030-01-01T10:00:01Z', id: 'dial-call-1', name: 'lookup_patient', arguments: '{"patientId":"private-patient"}' }],
      nodeTransition: [{ timestamp: '2030-01-01T10:00:02Z', fromNodeId: 'old-1', toNodeId: 'old-2', transitionData: { accepted: true } }],
      recordings: [{ url: 'https://recordings.example.test/dial-existing.wav' }],
    } });
    if (request.method === 'GET' && url.pathname === '/api/appointments') {
      state.appointmentReads++;
      state.appointmentMethods.push(request.method);
      if (url.searchParams.get('patient_id') !== '901') return json({ error: 'wrong patient scope' }, 400);
      return json({ appointments: state.subscriptions >= 3 ? afterAppointments : [] });
    }
    if (request.method === 'POST' && url.pathname === '/query') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const operation = JSON.parse(body);
      if (operation.query.includes('createAiChat')) {
        state.creates++;
        const id = `chat-${state.creates}`;
        state.callInputs.push(operation.variables.input.callAgentInput);
        state.chats.set(id, []);
        return json({ data: { createAiChat: { id } } });
      }
      if (operation.query.includes('aiChat(')) {
        const id = operation.variables.id;
        const transcript = state.chats.get(id) ?? (id === 'saved-current-chat' ? [
          { role: 'HUMAN', text: 'Current synthetic turn.' },
          { role: 'AI', text: 'Current synthetic response.', functionCalls: [{ id: 'current-call-1', name: 'commit_answer', arguments: '{"answer":"private-chat-value"}' }], nodeTransitionResult: null },
        ] : null);
        if (!transcript) return json({ errors: [{ message: 'unknown fixture chat' }] });
        return json({ data: { aiChat: { id, transcript } } });
      }
      return json({ errors: [{ message: 'unknown fixture operation' }] });
    }
    return json({ error: 'not found' }, 404);
  });

  server.on('upgrade', (request, socket) => {
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    const send = message => { if (!socket.destroyed) socket.write(frame(JSON.stringify(message))); };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeClientFrames(buffer);
      buffer = decoded.rest;
      for (const item of decoded.frames) {
        if (item.opcode === 8) {
          socket.end(frame(Buffer.alloc(0), 8));
          continue;
        }
        if (item.opcode !== 1) continue;
        let message;
        try { message = JSON.parse(item.text); } catch { continue; }
        if (message.type === 'connection_init') send({ type: 'connection_ack' });
        if (message.type === 'subscribe' && message.id === '1') {
          const input = message.payload?.variables?.input ?? {};
          const chatId = input.aiChatId;
          const text = input.text;
          state.subscriptions++;
          state.turnInputs.push(text);
          const reply = replies[state.subscriptions - 1] ?? bookedReply;
          const transcript = state.chats.get(chatId);
          transcript.push({ role: 'HUMAN', text });
          transcript.push({ role: 'AI', text: reply });
          send({ id: '1', type: 'next', payload: { data: { runChatQueryStream: {
            messageType: 'NEW_SPEAKER_RES', text: reply, transcriptLine: { role: 'AI', text: reply },
          } } } });
          send({ id: '1', type: 'complete' });
        }
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    state,
    apiBase: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/query`,
  };
}

async function closeFixture(fixture) {
  for (const socket of fixture.state.sockets) socket.destroy();
  await new Promise(resolve => fixture.server.close(resolve));
}

async function runCli(args, fixture, dataDir, { cwd = ROOT, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      VOGENT_API_KEY: 'fixture-secret-token',
      VOGENT_API_BASE_URL: fixture.apiBase,
      VOGENT_WS_URL: fixture.wsUrl,
      VOGENT_CHAT_HOME: dataDir,
      NODE_NO_WARNINGS: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'close');
  clearTimeout(timeout);
  return { code, stdout, stderr };
}

async function temporaryDirectory(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

async function scenarioFile(directory, {
  confirmationInput = 'Yes, please book that appointment.',
  confirmationText = 'Yes, please book that appointment.',
} = {}) {
  const path = join(directory, 'booking.scenario.json');
  const scenario = {
    schemaVersion: 1,
    name: 'synthetic exact appointment booking',
    agentId: TARGET,
    inputs: { callAgentInput: { caller_phone: '+15550000091' } },
    limits: { maxTurns: 3, timeoutMs: 10_000 },
    turns: [
      { name: 'offer', input: 'I need a knee follow-up appointment.', assertions: { exactText: [expectedAppointment.formatted_time] } },
      { name: 'choice', input: 'I will take the first option.', assertions: { exactText: [expectedAppointment.formatted_time] } },
      { name: 'confirmation', input: confirmationInput, assertions: { exactText: ['Confirmed:'] } },
    ],
    effects: {
      adapter: 'kyron-readonly-http',
      baseUrl: 'FIXTURE_BASE_URL',
      patientId: 901,
      expectedAppointment,
      speech: {
        offerTurn: 'offer', choiceTurn: 'choice', confirmationTurn: 'confirmation',
        choiceText: 'first option', confirmationPromptText: 'Should I book that?',
        confirmationText,
        offeredOptions: [{ time: expectedAppointment.formatted_time, doctor: expectedAppointment.doctor_name, location: expectedAppointment.location_name }],
        selectedOptionIndex: 0,
      },
    },
  };
  await writeFile(path, JSON.stringify(scenario, null, 2));
  return path;
}

test('CLI scenario process reconciles exact persisted offer/choice/confirmation with exact appointment delta', async t => {
  const fixture = await providerFixture();
  const home = await temporaryDirectory('vogent-independent-process-');
  const scenarioPath = await scenarioFile(home);
  const source = await readFile(scenarioPath, 'utf8');
  const parsed = JSON.parse(source);
  parsed.effects.baseUrl = fixture.apiBase;
  await writeFile(scenarioPath, JSON.stringify(parsed, null, 2));
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const result = await runCli(['scenario', 'run', '--scenario', scenarioPath, '--agent', TARGET, '--ack-target', TARGET, '--output', 'json'], fixture, home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.status, 'pass');
  assert.equal(envelope.turns.length, 3);
  assert.deepEqual(fixture.state.turnInputs, parsed.turns.map(turn => turn.input));
  assert.deepEqual(fixture.state.callInputs[0], parsed.inputs.callAgentInput);
  assert.equal(envelope.effects.backend.appointmentId, 92);
  assert.equal(envelope.effects.speech.checks.callerGivesExplicitConfirmation, true);
  assert.equal(envelope.effects.speech.checks.selectedOptionMatchesBackendAppointment, true);
  assert.equal(fixture.state.appointmentReads, 2);
  assert.deepEqual(fixture.state.appointmentMethods, ['GET', 'GET']);
  assert.equal(fixture.state.creates, 1);
  assert.equal(fixture.state.subscriptions, 3);
});

test('assistant assent cannot substitute for a caller confirmation in the saved turn', async t => {
  const fixture = await providerFixture({ replies: [offerReply, choiceReply, 'Yes, the appointment is booked for Monday, June 03 at 10:00 AM with Dr. Example at East Clinic.'] });
  const home = await temporaryDirectory('vogent-independent-consent-');
  const scenarioPath = await scenarioFile(home, { confirmationInput: 'No, do not book that appointment.' });
  const parsed = JSON.parse(await readFile(scenarioPath, 'utf8'));
  parsed.effects.baseUrl = fixture.apiBase;
  await writeFile(scenarioPath, JSON.stringify(parsed, null, 2));
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const result = await runCli(['scenario', 'run', '--scenario', scenarioPath, '--agent', TARGET, '--ack-target', TARGET, '--output', 'json'], fixture, home);
  assert.equal(result.code, 1, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.effects.backend.status, 'pass');
  assert.equal(envelope.effects.speech.checks.callerGivesExplicitConfirmation, false);
  assert.equal(envelope.effects.status, 'fail');
  assert.equal(envelope.status, 'fail');
  assert.equal(fixture.state.subscriptions, 3);
});

test('a caller yes that explicitly withdraws booking consent does not authorize the matching backend row', async t => {
  const fixture = await providerFixture({ replies: [offerReply, choiceReply, 'Yes, the appointment is booked for Monday, June 03 at 10:00 AM with Dr. Example at East Clinic.'] });
  const home = await temporaryDirectory('vogent-independent-negated-consent-');
  const scenarioPath = await scenarioFile(home, {
    confirmationInput: 'Yes, but do not book that appointment.',
    confirmationText: 'Yes',
  });
  const parsed = JSON.parse(await readFile(scenarioPath, 'utf8'));
  parsed.effects.baseUrl = fixture.apiBase;
  await writeFile(scenarioPath, JSON.stringify(parsed, null, 2));
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const result = await runCli(['scenario', 'run', '--scenario', scenarioPath, '--agent', TARGET, '--ack-target', TARGET, '--output', 'json'], fixture, home);
  assert.equal(result.code, 1, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.effects.backend.status, 'pass');
  assert.equal(envelope.effects.speech.checks.callerGivesExplicitConfirmation, false);
  assert.equal(envelope.effects.status, 'fail');
  assert.equal(envelope.status, 'fail');
});

test('config snapshot process does not export literal function header or body values', async t => {
  const fixture = await providerFixture();
  const home = await temporaryDirectory('vogent-independent-config-');
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const result = await runCli(['config', 'snapshot', '--agent', TARGET, '--output', 'json'], fixture, home);
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes('header-secret'), false);
  assert.equal(serialized.includes('body-patient-value'), false);
  assert.equal(serialized.includes('fixture-secret-token'), false);
  assert.equal(fixture.state.creates, 0);
  assert.equal(fixture.state.subscriptions, 0);
});

test('documented profile and harmless-control preflight commands parse and stay read-only', async t => {
  const fixture = await providerFixture();
  const home = await temporaryDirectory('vogent-independent-profile-');
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });
  const hostPath = 'staging.example.test/v16/api/';

  const saved = await runCli([
    'profile', 'set', '--name', 'fixture-control', '--agent-id', TARGET,
    '--allow-target', hostPath,
    '--harmless-function-id', FUNCTION,
    '--harmless-target', hostPath,
    '--expected-prompt-id', PROMPT,
    '--output', 'json',
  ], fixture, home);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse(saved.stdout).name, 'fixture-control');

  const inspected = await runCli(['profile', 'inspect', '--name', 'fixture-control', '--output', 'json'], fixture, home);
  assert.equal(inspected.code, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).agentId, TARGET);

  const agentInspection = await runCli(['--agent', TARGET, '--inspect', '--output', 'json'], fixture, home);
  assert.equal(agentInspection.code, 0, agentInspection.stderr);
  assert.equal(agentInspection.stdout.includes('header-secret'), false);
  assert.equal(agentInspection.stdout.includes('body-patient-value'), false);

  const diagnosis = await runCli([
    'diagnose-tools', '--agent', TARGET, '--call-input', '{"caller_phone":"+15550000091"}', '--output', 'json',
  ], fixture, home);
  assert.equal(diagnosis.code, 0, diagnosis.stderr);
  assert.equal(diagnosis.stdout.includes('header-secret'), false);
  assert.equal(diagnosis.stdout.includes('body-patient-value'), false);

  const doctor = await runCli(['doctor', '--output', 'json'], fixture, home);
  assert.equal(doctor.code, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).credential.status, 'accepted-for-read-only-agent-list');

  const preflight = await runCli([
    'control-preflight', '--agent', TARGET, '--profile', 'fixture-control',
    '--message', 'Inspect this synthetic, non-mutating control.',
    '--call-input', '{"caller_phone":"+15550000091"}', '--output', 'json',
  ], fixture, home);
  assert.equal(preflight.code, 0, preflight.stderr);
  const gate = JSON.parse(preflight.stdout);
  assert.equal(gate.status, 'preflight-passed');
  assert.equal(gate.execution, 'not-run');
  assert.equal(gate.action, 'preflight-only-no-chat-created-or-message-sent');
  assert.equal(fixture.state.creates, 0);
  assert.equal(fixture.state.subscriptions, 0);
  assert.ok(fixture.state.requests.every(request => request.method === 'GET'));
});

test('historical dial and current chat exports retain separate version and trace provenance', async t => {
  const fixture = await providerFixture();
  const home = await temporaryDirectory('vogent-independent-history-');
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const dial = await runCli(['dial', 'export', '--dial-id', 'dial-existing', '--redact', '--output', 'json'], fixture, home);
  const chat = await runCli(['trace', '--chat-id', 'saved-current-chat', '--output', 'json'], fixture, home);
  const config = await runCli(['config', 'snapshot', '--agent', TARGET, '--output', 'json'], fixture, home);
  assert.equal(dial.code, 0, dial.stderr);
  assert.equal(chat.code, 0, chat.stderr);
  assert.equal(config.code, 0, config.stderr);
  const oldDial = JSON.parse(dial.stdout);
  const currentChat = JSON.parse(chat.stdout);
  const currentConfig = JSON.parse(config.stdout);
  assert.equal(oldDial.executedVersionedPromptId, 'prompt-historical');
  assert.equal(currentConfig.defaultPromptId, PROMPT);
  assert.equal(currentChat.chatId, 'saved-current-chat');
  assert.equal(currentChat.nativeProviderTrace.completeness, 'partial; full voice-style Flow Builder trace is not established');
  assert.equal(Object.hasOwn(currentChat, 'executedVersionedPromptId'), false);
  assert.equal(JSON.stringify(currentChat).includes('prompt-historical'), false);
  assert.equal(JSON.stringify(currentChat).includes(PROMPT), false);
  assert.notEqual(oldDial.executedVersionedPromptId, currentConfig.defaultPromptId);
  assert.equal(dial.stdout.includes('private-patient'), false);
  assert.equal(chat.stdout.includes('private-chat-value'), false);
  assert.equal(fixture.state.creates, 0);
  assert.equal(fixture.state.subscriptions, 0);
});

test('start refuses default configuration drift between inspection and chat creation', async t => {
  const fixture = await providerFixture({ promptForRead: (index, prompt) => index === 1 ? prompt : {
    ...prompt,
    settings: { fillEmptyStringVariables: false },
  } });
  const home = await temporaryDirectory('vogent-independent-drift-');
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const result = await runCli([
    'start', '--agent', TARGET, '--ack-target', TARGET, '--message', 'Synthetic inquiry.', '--output', 'json',
  ], fixture, home);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stdout);
  assert.equal(error.error.kind, 'configuration_race');
  assert.equal(fixture.state.promptReads, 2);
  assert.equal(fixture.state.creates, 0);
  assert.equal(fixture.state.subscriptions, 0);
});

test('documented explicit env-file setup works outside the repository checkout', async t => {
  const fixture = await providerFixture();
  const home = await temporaryDirectory('vogent-independent-portable-');
  const envFile = join(home, 'provider.env');
  await writeFile(envFile, 'VOGENT_API_KEY=fixture-secret-token\n');
  t.after(async () => {
    await closeFixture(fixture);
    await rm(home, { recursive: true, force: true });
  });

  const result = await runCli(['doctor', '--env-file', envFile, '--output', 'json'], fixture, home, {
    cwd: home,
    env: { VOGENT_API_KEY: '' },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).credential.status, 'accepted-for-read-only-agent-list');
  assert.equal(result.stdout.includes('fixture-secret-token'), false);
  assert.deepEqual(fixture.state.requests.map(request => request.path), ['/api/agents', '/api/phone_numbers']);
  assert.equal(fixture.state.creates, 0);
  assert.equal(fixture.state.subscriptions, 0);
});
