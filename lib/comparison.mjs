import { readFile } from 'node:fs/promises';

const JOURNAL_SCHEMA = 'vogent-run.v1';
const COMPARISON_SCHEMA = 1;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return stable(left) === stable(right);
}

function parseSavedRun(source, label) {
  let records;
  try {
    records = source.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    return { value: null, limitations: [`${label} is not a readable JSONL evidence file: ${error.message}`] };
  }
  if (!records.length) return { value: null, limitations: [`${label} contains no evidence records.`] };
  const unsupported = [...new Set(records.map(record => record?.schema).filter(schema => schema && schema !== JOURNAL_SCHEMA))];
  if (unsupported.length) return { value: null, limitations: [`${label} uses unsupported evidence schema ${unsupported.join(', ')}.`] };
  if (records.some(record => record?.schema !== JOURNAL_SCHEMA)) {
    return { value: null, limitations: [`${label} mixes evidence schemas or has records without a schema tag.`] };
  }
  const header = records.find(record => record.type === 'run_started')?.data;
  const result = records.findLast(record => record.type === 'scenario_result')?.data;
  if (!header || !result || result.kind !== 'vogent-scenario-result') {
    return { value: null, limitations: [`${label} is not a completed saved scenario run.`] };
  }
  const assertions = new Map((result.assertions ?? []).map(item => [item.name, item.status]));
  const turns = (result.turns ?? []).map(turn => ({
    name: turn.name,
    input: turn.input,
    reply: turn.reply,
    status: turn.status,
    persisted: turn.persisted,
    traceStatus: turn.traceStatus,
    functionCalls: turn.functionCalls,
    submittedAt: turn.submittedAt,
    completedAt: turn.completedAt,
    transport: turn.transport,
  }));
  return {
    value: {
      schema: JOURNAL_SCHEMA,
      runId: records[0].runId,
      header,
      result,
      assertions,
      turns,
      effectEvidence: records.filter(record => ['effects_before', 'effects_after', 'effects_reconciled', 'effects_before_incomplete', 'effects_after_incomplete'].includes(record.type)).map(record => ({ type: record.type, data: record.data })),
      uncertainty: result.status === 'incomplete' || turns.some(turn => turn.status === 'incomplete'),
    },
    limitations: [],
  };
}

function assertionDiff(before, after) {
  const keys = new Set([...before.assertions.keys(), ...after.assertions.keys()]);
  return [...keys].sort().map(name => {
    const oldStatus = before.assertions.get(name) ?? 'absent';
    const newStatus = after.assertions.get(name) ?? 'absent';
    const regression = oldStatus === 'pass' && newStatus !== 'pass';
    const improvement = oldStatus !== 'pass' && newStatus === 'pass';
    return { name, before: oldStatus, after: newStatus, changed: oldStatus !== newStatus, regression, improvement };
  });
}

function turnDiff(before, after) {
  const names = new Set([...before.turns.map(turn => turn.name), ...after.turns.map(turn => turn.name)]);
  return [...names].sort().map(name => {
    const oldTurn = before.turns.find(turn => turn.name === name);
    const newTurn = after.turns.find(turn => turn.name === name);
    return {
      name,
      beforeInput: oldTurn?.input ?? null,
      afterInput: newTurn?.input ?? null,
      inputChanged: oldTurn?.input !== newTurn?.input,
      beforeReply: oldTurn?.reply ?? null,
      afterReply: newTurn?.reply ?? null,
      replyChanged: oldTurn?.reply !== newTurn?.reply,
      beforeTransport: oldTurn?.transport ?? null,
      afterTransport: newTurn?.transport ?? null,
      uncertaintyChanged: (oldTurn?.status === 'incomplete') !== (newTurn?.status === 'incomplete'),
    };
  });
}

function latency(turns) {
  return turns.map(turn => {
    const start = Date.parse(turn.submittedAt ?? '');
    const end = Date.parse(turn.completedAt ?? '');
    return { name: turn.name, milliseconds: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null };
  });
}

function compareEffectEvidence(before, after) {
  const changed = !same(before.effectEvidence, after.effectEvidence);
  const statusBefore = before.result.effects?.status ?? 'not_recorded';
  const statusAfter = after.result.effects?.status ?? 'not_recorded';
  return {
    changed,
    before: before.effectEvidence,
    after: after.effectEvidence,
    statusBefore,
    statusAfter,
    regression: statusBefore === 'pass' && statusAfter !== 'pass',
  };
}

function latencyDelta(before, after) {
  const oldValues = new Map(latency(before.turns).map(item => [item.name, item.milliseconds]));
  return latency(after.turns).map(item => ({
    name: item.name,
    beforeMilliseconds: oldValues.get(item.name) ?? null,
    afterMilliseconds: item.milliseconds,
    deltaMilliseconds: oldValues.get(item.name) === null || oldValues.get(item.name) === undefined || item.milliseconds === null
      ? null : item.milliseconds - oldValues.get(item.name),
  }));
}

export function compareRunEvidence(beforeInput, afterInput) {
  const beforeParsed = typeof beforeInput === 'string' ? parseSavedRun(beforeInput, 'before run') : { value: beforeInput, limitations: [] };
  const afterParsed = typeof afterInput === 'string' ? parseSavedRun(afterInput, 'after run') : { value: afterInput, limitations: [] };
  const limitations = [...beforeParsed.limitations, ...afterParsed.limitations];
  const before = beforeParsed.value;
  const after = afterParsed.value;
  if (!before || !after) {
    return { schemaVersion: COMPARISON_SCHEMA, kind: 'vogent-scenario-comparison', status: 'inconclusive', limitations };
  }
  if (before.schema !== after.schema || before.result.schemaVersion !== after.result.schemaVersion) {
    return {
      schemaVersion: COMPARISON_SCHEMA,
      kind: 'vogent-scenario-comparison',
      status: 'inconclusive',
      limitations: [`Evidence schema mismatch (${before.schema}/${before.result.schemaVersion} vs ${after.schema}/${after.result.schemaVersion}); deterministic run comparison is unavailable.`],
    };
  }
  if (before.header.scenario?.name !== after.header.scenario?.name) {
    limitations.push('Scenario names differ; assertion and utterance deltas are descriptive and may not represent a regression.');
  }
  const assertions = assertionDiff(before, after);
  const turns = turnDiff(before, after);
  const effects = compareEffectEvidence(before, after);
  const configBefore = before.header.configurationHash ?? before.result.configurationHash ?? null;
  const configAfter = after.header.configurationHash ?? after.result.configurationHash ?? null;
  const incompatible = limitations.some(item => item.includes('schema mismatch')) || !Array.isArray(before.result.assertions) || !Array.isArray(after.result.assertions);
  const regression = assertions.some(item => item.regression) || effects.regression || (!before.uncertainty && after.uncertainty);
  const status = incompatible ? 'inconclusive' : regression ? 'regression' : 'comparable';
  return {
    schemaVersion: COMPARISON_SCHEMA,
    kind: 'vogent-scenario-comparison',
    status,
    scenario: { before: before.header.scenario?.name ?? null, after: after.header.scenario?.name ?? null },
    configuration: { before: configBefore, after: configAfter, changed: configBefore !== configAfter },
    assertions,
    utterances: turns,
    uncertainty: { before: before.uncertainty, after: after.uncertainty, changed: before.uncertainty !== after.uncertainty },
    effects,
    latency: { before: latency(before.turns), after: latency(after.turns), delta: latencyDelta(before, after) },
    regression,
    modelGrading: { status: 'not_requested', evidence: null },
    limitations,
  };
}

export async function compareSavedRuns(beforePath, afterPath) {
  const [before, after] = await Promise.all([readFile(beforePath, 'utf8'), readFile(afterPath, 'utf8')]);
  const result = compareRunEvidence(before, after);
  return { ...result, sourceFiles: { before: beforePath, after: afterPath } };
}
