import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleScenarios, parseScenario, runScenario, runSuite, ScenarioSchemaError } from '../lib/scenarios.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../chat.mjs');

const target = {
  id: 'agent-fixture', name: 'Fixture agent', defaultVersionedPromptId: 'prompt-fixture',
  linkedFunctionDefinitions: [],
};

function scenario({ turns, name = 'fixture greeting', maxTurns = 4 } = {}) {
  return {
    schemaVersion: 1,
    name,
    inputs: { callAgentInput: { caller_phone: '+15555550123' } },
    limits: { maxTurns, timeoutMs: 5_000 },
    turns: turns ?? [{ name: 'greeting', input: 'Hello.', assertions: { exactText: ['Welcome to the clinic.'] } }],
  };
}

function fixtures({ replies = ['Welcome to the clinic.'], omitReply = false, includeSavedTrace = true, calls = [], delayMs = 0, expectedCallInput = { caller_phone: '+15555550123' } } = {}) {
  const chats = new Map();
  const journals = [];
  let nextChat = 1;
  let activeTurns = 0;
  let maxActiveTurns = 0;
  const provider = {
    async listAgents() { return [target]; },
    async listPhones() { return []; },
    async inspectAgent(agent, phones) {
      assert.equal(agent.id, target.id);
      assert.equal(phones.status, 'available');
      return { knownStaging: true, agent, prompt: { id: 'prompt-fixture', agentType: 'CUSTOM_FLOW' }, functions: [], phoneLinkage: { status: 'unlinked' } };
    },
    async createChat(input) {
      assert.equal(input.agentId, target.id);
      assert.deepEqual(input.callAgentInput, expectedCallInput);
      const id = `chat-${nextChat++}`;
      chats.set(id, []);
      return { id };
    },
    async runChatTurn({ chatId, text, signal }) {
      activeTurns++;
      maxActiveTurns = Math.max(maxActiveTurns, activeTurns);
      try {
        if (delayMs) await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('fixture aborted')); }, { once: true });
        });
        const index = chats.get(chatId).filter(line => line.role.toLowerCase() === 'user').length;
        const reply = replies[index] ?? '';
      chats.get(chatId).push({ role: 'USER', text });
        if (!omitReply && reply) {
          const line = { role: 'AI', text: reply };
          if (includeSavedTrace) line.functionCalls = calls[index] ?? [];
          chats.get(chatId).push(line);
        }
        return { status: 'complete', outcome: 'stream_complete', text: reply, functionCalls: calls[index] ?? [], traceStatus: { functionCalls: 'available' } };
      } finally {
        activeTurns--;
      }
    },
    async readChat(chatId) {
      return { status: 'available', data: { id: chatId }, transcriptLines: chats.get(chatId).map(line => ({ ...line })) };
    },
  };
  const createJournal = ({ header }) => {
    const entry = { runId: `run-${journals.length + 1}`, header, events: [], status: null, details: null };
    entry.append = (type, data) => entry.events.push({ type, data });
    entry.finalize = (status, details) => { entry.status = status; entry.details = details; };
    journals.push(entry);
    return entry;
  };
  return { provider, createJournal, journals, chats, get maxActiveTurns() { return maxActiveTurns; } };
}

test('runner persists exact text evidence and returns pass/fail against saved replies', async () => {
  const good = fixtures();
  const passed = await runScenario({ scenario: scenario(), agentId: target.id }, good);
  assert.equal(passed.status, 'pass');
  assert.equal(passed.chatId, 'chat-1');
  assert.equal(good.journals[0].events.find(item => item.type === 'turn_persisted').data.reply, 'Welcome to the clinic.');
  assert.equal(good.journals[0].header.configurationHash, passed.configurationHash);

  const wrong = fixtures({ replies: ['Welcome to the clinic on the wrong day.'] });
  const failed = await runScenario({ scenario: scenario(), agentId: target.id }, wrong);
  assert.equal(failed.status, 'fail');
});

test('explicit CLI call input overrides the scenario input only when the flag was supplied', async () => {
  const explicit = { caller_phone: '+15555550124' };
  const fixture = fixtures({ expectedCallInput: explicit });
  const result = await runScenario({ scenario: scenario(), agentId: target.id, callAgentInput: explicit, callInputProvided: true }, fixture);
  assert.equal(result.status, 'pass');
  assert.deepEqual(fixture.journals[0].header.callAgentInput, explicit);
});

test('missing saved reply is incomplete even when the stream closes successfully', async () => {
  const fixture = fixtures({ replies: ['Welcome to the clinic.'], omitReply: true });
  const result = await runScenario({ scenario: scenario(), agentId: target.id }, fixture);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.turns[0].persisted, false);
});

test('function-call assertions require saved traces and exact arguments', async () => {
  const scenarioWithCall = scenario({ turns: [{
    name: 'lookup', input: 'Find the patient.',
    assertions: { exactText: ['Found the chart.'], functionCalls: [{ name: 'lookup_patient', arguments: { patient_id: 12 } }] },
  }] });
  const noTrace = fixtures({ replies: ['Found the chart.'], calls: [[{ name: 'lookup_patient', arguments: { patient_id: 12 } }]], includeSavedTrace: false });
  assert.equal((await runScenario({ scenario: scenarioWithCall, agentId: target.id }, noTrace)).status, 'incomplete');

  const exactTrace = fixtures({ replies: ['Found the chart.'], calls: [[{ name: 'lookup_patient', arguments: { patient_id: 12 } }]] });
  const exactTraceResult = await runScenario({ scenario: scenarioWithCall, agentId: target.id }, exactTrace);
  assert.equal(exactTraceResult.status, 'pass', JSON.stringify(exactTraceResult));
});

test('turn budget stops at the configured bound and records incomplete evidence', async () => {
  const fixture = fixtures({ replies: ['first', 'second'] });
  const twoTurns = scenario({ turns: [
    { name: 'first', input: 'One', assertions: { exactText: ['first'] } },
    { name: 'second', input: 'Two', assertions: { exactText: ['second'] } },
  ] });
  const result = await runScenario({ scenario: twoTurns, agentId: target.id, maxTurns: 1 }, fixture);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.turns.length, 1);
  assert.equal(fixture.chats.get(result.chatId).filter(line => line.role.toLowerCase() === 'user').length, 1);
});

test('invalid scenario schema fails before target inspection or chat creation', async () => {
  let inspected = false;
  const fixture = fixtures();
  const original = fixture.provider.listAgents;
  fixture.provider.listAgents = async () => { inspected = true; return original(); };
  assert.throws(() => parseScenario({ ...scenario(), turns: [] }), ScenarioSchemaError);
  await assert.rejects(() => runScenario({ scenario: { ...scenario(), turns: [] }, agentId: target.id }, fixture), ScenarioSchemaError);
  assert.equal(inspected, false);
});

test('CLI process lists validated example scenarios without provider credentials', () => {
  const child = spawnSync(process.execPath, [CLI, 'scenario', 'list', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, VOGENT_API_KEY: '', VOGENT_CHAT_HOME: '/tmp/vogent-scenario-list-test' },
  });
  assert.equal(child.status, 0, child.stderr);
  const rows = JSON.parse(child.stdout);
  assert.ok(rows.some(row => row.name === 'greeting and terminal response alignment'));
  assert.ok(rows.some(row => row.name === 'isolated Kyron booking with spoken consent and exact row reconciliation'));
});

test('CLI process reports malformed scenario schema before requesting provider credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vogent-invalid-scenario-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'invalid.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, name: 'broken', inputs: { callAgentInput: {} }, turns: [] }));
  const child = spawnSync(process.execPath, [CLI, 'scenario', 'run', '--scenario', file, '--output', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, VOGENT_API_KEY: '', VOGENT_CHAT_HOME: join(root, 'private-data') },
  });
  assert.notEqual(child.status, 0);
  const output = JSON.parse(child.stdout);
  assert.equal(output.error.kind, 'cli_error');
  assert.match(output.error.message, /turns must contain/);
});

test('scenario suites run sequentially, create separate chats, and stop at their scenario cap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vogent-suite-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'one.scenario.json'), JSON.stringify(scenario({ name: 'one' })));
  await writeFile(join(root, 'two.scenario.json'), JSON.stringify(scenario({ name: 'two' })));
  const suitePath = join(root, 'suite.json');
  await writeFile(suitePath, JSON.stringify({ schemaVersion: 1, name: 'bounded', scenarios: ['one.scenario.json', 'two.scenario.json'] }));
  const fixture = fixtures({ delayMs: 5 });
  const result = await runSuite({ suitePath, agentId: target.id, maxScenarios: 1 }, fixture);

  assert.equal(result.status, 'incomplete');
  assert.equal(result.completed, 1);
  assert.equal(result.results[0].chatId, 'chat-1');
  assert.equal(fixture.maxActiveTurns, 1);
  assert.equal(fixture.journals.length, 2); // suite plus its independent scenario run
});

test('suite rejects concurrency greater than one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vogent-suite-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'one.scenario.json'), JSON.stringify(scenario()));
  const suitePath = join(root, 'suite.json');
  await writeFile(suitePath, JSON.stringify({ schemaVersion: 1, name: 'bounded', concurrency: 2, scenarios: ['one.scenario.json'] }));
  await assert.rejects(() => runSuite({ suitePath }, fixtures()), /concurrency 1 only/);
});

test('suite time budget stops uncertain provider work without replaying the turn', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vogent-suite-time-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'one.scenario.json'), JSON.stringify(scenario()));
  await writeFile(join(root, 'two.scenario.json'), JSON.stringify(scenario({ name: 'two' })));
  const suitePath = join(root, 'suite.json');
  await writeFile(suitePath, JSON.stringify({ schemaVersion: 1, name: 'short', limits: { timeoutMs: 1_000 }, scenarios: ['one.scenario.json', 'two.scenario.json'] }));
  const fixture = fixtures({ delayMs: 1_500 });
  const result = await runSuite({ suitePath, agentId: target.id }, fixture);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completed, 1);
  assert.equal(fixture.chats.get('chat-1').filter(line => line.role === 'user').length, 0);
});
