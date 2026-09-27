import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRunEvidence, compareSavedRuns } from '../lib/comparison.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../chat.mjs');

function run({ prompt = 'prompt-a', status = 'pass', assertion = 'pass', reply = 'September 28 at 9:00 AM', outcome = 'stream_complete', effectId = 80, schemaVersion = 1 } = {}) {
  const runId = `run-${prompt}-${effectId}`;
  const header = {
    schemaVersion,
    kind: 'vogent-scenario-run',
    scenario: { name: 'date-offer', schemaVersion: 1 },
    configurationHash: prompt,
  };
  const result = {
    schemaVersion,
    kind: 'vogent-scenario-result',
    status,
    scenario: 'date-offer',
    configurationHash: prompt,
    assertions: [{ name: 'offer: exact text "September 28"', status: assertion }],
    turns: [{
      name: 'offer', input: 'Find an appointment.', reply, status,
      persisted: true, traceStatus: 'available', functionCalls: [],
      submittedAt: '2026-09-26T10:00:00.000Z', completedAt: '2026-09-26T10:00:01.250Z',
      transport: { status: status === 'incomplete' ? 'incomplete' : 'complete', outcome },
    }],
    effects: { status: 'pass', backend: { status: 'pass', appointmentId: effectId } },
  };
  return [
    { schema: 'vogent-run.v1', runId, type: 'run_started', data: header },
    { schema: 'vogent-run.v1', runId, type: 'turn_persisted', data: { name: 'offer', reply } },
    { schema: 'vogent-run.v1', runId, type: 'effects_reconciled', data: result.effects },
    { schema: 'vogent-run.v1', runId, type: 'scenario_result', data: result },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';
}

test('offline comparison exposes config changes, deterministic regressions, uncertainty, effects, and latency', () => {
  const before = run({ prompt: 'config-old', assertion: 'pass', reply: 'September 28 at 9:00 AM', effectId: 80 });
  const after = run({ prompt: 'config-new', assertion: 'fail', reply: 'September 29 at 9:00 AM', effectId: 81, status: 'incomplete', outcome: 'outcome_unknown' });
  const result = compareRunEvidence(before, after);

  assert.equal(result.status, 'regression');
  assert.equal(result.regression, true);
  assert.equal(result.configuration.changed, true);
  assert.equal(result.assertions[0].regression, true);
  assert.equal(result.utterances[0].replyChanged, true);
  assert.equal(result.uncertainty.changed, true);
  assert.equal(result.effects.statusAfter, 'pass');
  assert.equal(result.latency.before[0].milliseconds, 1250);
  assert.deepEqual(result.modelGrading, { status: 'not_requested', evidence: null });
});

test('incompatible saved evidence schema is explicitly inconclusive', () => {
  const result = compareRunEvidence(run(), run({ schemaVersion: 2 }));
  assert.equal(result.status, 'inconclusive');
  assert.match(result.limitations.join(' '), /schema mismatch/i);
});

test('malformed saved evidence is inconclusive instead of partially compared', () => {
  const result = compareRunEvidence('{bad json', run());
  assert.equal(result.status, 'inconclusive');
  assert.match(result.limitations.join(' '), /not a readable JSONL/);
});

test('saved comparison reads only local files and returns their paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vogent-compare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = join(root, 'before.jsonl');
  const after = join(root, 'after.jsonl');
  await writeFile(before, run());
  await writeFile(after, run({ prompt: 'changed' }));

  const result = await compareSavedRuns(before, after);
  assert.equal(result.status, 'comparable');
  assert.deepEqual(result.sourceFiles, { before, after });
});

test('CLI process compares saved files offline without Vogent credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vogent-compare-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = join(root, 'before.jsonl');
  const after = join(root, 'after.jsonl');
  await writeFile(before, run());
  await writeFile(after, run({ prompt: 'changed' }));
  const child = spawnSync(process.execPath, [CLI, 'scenario', 'compare', '--before', before, '--after', after, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, VOGENT_API_KEY: '', VOGENT_CHAT_HOME: join(root, 'private-data') },
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.status, 'comparable');
  assert.equal(result.configuration.changed, true);
});
