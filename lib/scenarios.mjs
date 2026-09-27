import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createKyronReadOnlyAdapter, effectSnapshotFailure, finishEffects, snapshotEffects } from './effects.mjs';
import { createConfigSnapshot } from './config.mjs';
import { compareSavedRuns } from './comparison.mjs';

const DEFAULT_MAX_TURNS = 12;
const HARD_MAX_TURNS = 30;
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
const HARD_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_SUITE_MAX_SCENARIOS = 10;
const HARD_SUITE_MAX_SCENARIOS = 30;
const DEFAULT_SUITE_TIMEOUT_MS = 300_000;
const HARD_SUITE_TIMEOUT_MS = 600_000;
const MAX_SCENARIO_BYTES = 256 * 1024;
const MAX_SUITE_BYTES = 128 * 1024;

export class ScenarioSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScenarioSchemaError';
    this.exitCode = 2;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withinInteger(value, { min, max, fallback, label }) {
  const parsed = value === undefined ? fallback : value;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ScenarioSchemaError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ScenarioSchemaError(`${label} must be a non-empty string.`);
}

function assertStringList(value, label, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.length)) {
    throw new ScenarioSchemaError(`${label} must be an array of non-empty strings.`);
  }
}

function validateAssertions(assertions, turnName) {
  if (!isObject(assertions)) throw new ScenarioSchemaError(`Turn ${turnName} needs an assertions object.`);
  assertStringList(assertions.exactText, `Turn ${turnName} assertions.exactText`);
  assertStringList(assertions.forbiddenText, `Turn ${turnName} assertions.forbiddenText`);
  if (assertions.functionCalls !== undefined) {
    if (!Array.isArray(assertions.functionCalls) || assertions.functionCalls.some(call =>
      !isObject(call) || typeof call.name !== 'string' || !call.name.trim() ||
      (Object.hasOwn(call, 'arguments') && !isObject(call.arguments) && !Array.isArray(call.arguments) && typeof call.arguments !== 'string' && call.arguments !== null))) {
      throw new ScenarioSchemaError(`Turn ${turnName} assertions.functionCalls must contain named calls with optional JSON arguments.`);
    }
  }
  if (!(assertions.exactText?.length || assertions.forbiddenText?.length || assertions.functionCalls?.length)) {
    throw new ScenarioSchemaError(`Turn ${turnName} must have at least one exactText, forbiddenText, or functionCalls assertion.`);
  }
}

function validateEffects(effects) {
  if (effects === undefined) return;
  if (!isObject(effects) || effects.adapter !== 'kyron-readonly-http') {
    throw new ScenarioSchemaError('effects.adapter must be "kyron-readonly-http".');
  }
  assertNonEmptyString(effects.baseUrl, 'effects.baseUrl');
  if (!Number.isInteger(effects.patientId) || effects.patientId < 1) {
    throw new ScenarioSchemaError('effects.patientId must be a positive integer.');
  }
  if (!isObject(effects.expectedAppointment)) throw new ScenarioSchemaError('effects.expectedAppointment must be an object.');
  const required = ['patient_id', 'doctor_id', 'slot_id', 'location_code', 'body_part', 'issue_type', 'appointment_time', 'formatted_time', 'doctor_name', 'location_name', 'status'];
  const missing = required.filter(key => !Object.hasOwn(effects.expectedAppointment, key));
  if (missing.length) throw new ScenarioSchemaError(`effects.expectedAppointment is missing: ${missing.join(', ')}.`);
  for (const key of ['patient_id', 'doctor_id', 'slot_id']) {
    if (!Number.isInteger(effects.expectedAppointment[key]) || effects.expectedAppointment[key] < 1) {
      throw new ScenarioSchemaError(`effects.expectedAppointment.${key} must be a positive integer.`);
    }
  }
  for (const key of ['location_code', 'body_part', 'issue_type', 'appointment_time', 'formatted_time', 'doctor_name', 'location_name', 'status']) {
    assertNonEmptyString(effects.expectedAppointment[key], `effects.expectedAppointment.${key}`);
  }
  if (effects.expectedAppointment.patient_id !== effects.patientId) {
    throw new ScenarioSchemaError('effects.expectedAppointment.patient_id must match effects.patientId.');
  }
  if (!isObject(effects.speech)) throw new ScenarioSchemaError('effects.speech must define offer, choice, and confirmation turn names.');
  for (const key of ['offerTurn', 'choiceTurn', 'confirmationTurn', 'choiceText', 'confirmationPromptText', 'confirmationText']) {
    assertNonEmptyString(effects.speech[key], `effects.speech.${key}`);
  }
  if (!Array.isArray(effects.speech.offeredOptions) || effects.speech.offeredOptions.length < 1 ||
      effects.speech.offeredOptions.some(option => !isObject(option) || ['time', 'doctor', 'location'].some(key => typeof option[key] !== 'string' || !option[key].trim()))) {
    throw new ScenarioSchemaError('effects.speech.offeredOptions must list the exact time, doctor, and location text for each option.');
  }
  if (!Number.isInteger(effects.speech.selectedOptionIndex) || effects.speech.selectedOptionIndex < 0 || effects.speech.selectedOptionIndex >= effects.speech.offeredOptions.length) {
    throw new ScenarioSchemaError('effects.speech.selectedOptionIndex must identify one offered option.');
  }
  if (effects.expectedAppointment.formatted_time !== effects.speech.offeredOptions[effects.speech.selectedOptionIndex].time) {
    throw new ScenarioSchemaError('The selected spoken option must exactly match expectedAppointment.formatted_time.');
  }
  const selected = effects.speech.offeredOptions[effects.speech.selectedOptionIndex];
  if (selected.doctor !== effects.expectedAppointment.doctor_name || selected.location !== effects.expectedAppointment.location_name) {
    throw new ScenarioSchemaError('The selected spoken option doctor and location must match the expected appointment.');
  }
}

export function validateScenario(scenario) {
  if (!isObject(scenario)) throw new ScenarioSchemaError('Scenario document must be a JSON object.');
  if (scenario.schemaVersion !== 1) throw new ScenarioSchemaError('Scenario schemaVersion must be 1.');
  assertNonEmptyString(scenario.name, 'Scenario name');
  if (scenario.agentId !== undefined) assertNonEmptyString(scenario.agentId, 'Scenario agentId');
  if (!isObject(scenario.inputs) || !isObject(scenario.inputs.callAgentInput)) {
    throw new ScenarioSchemaError('Scenario inputs.callAgentInput must be an explicit JSON object.');
  }
  if (!Array.isArray(scenario.turns) || scenario.turns.length < 1 || scenario.turns.length > HARD_MAX_TURNS) {
    throw new ScenarioSchemaError(`Scenario turns must contain between 1 and ${HARD_MAX_TURNS} named turns.`);
  }
  const names = new Set();
  for (const [index, turn] of scenario.turns.entries()) {
    if (!isObject(turn)) throw new ScenarioSchemaError(`Turn ${index + 1} must be an object.`);
    assertNonEmptyString(turn.name, `Turn ${index + 1} name`);
    assertNonEmptyString(turn.input, `Turn ${turn.name} input`);
    if (names.has(turn.name)) throw new ScenarioSchemaError(`Turn name ${turn.name} is duplicated.`);
    names.add(turn.name);
    validateAssertions(turn.assertions, turn.name);
  }
  const limits = scenario.limits ?? {};
  if (!isObject(limits)) throw new ScenarioSchemaError('Scenario limits must be an object.');
  withinInteger(limits.maxTurns, { min: 1, max: HARD_MAX_TURNS, fallback: DEFAULT_MAX_TURNS, label: 'limits.maxTurns' });
  withinInteger(limits.timeoutMs, { min: 1_000, max: HARD_TURN_TIMEOUT_MS, fallback: DEFAULT_TURN_TIMEOUT_MS, label: 'limits.timeoutMs' });
  validateEffects(scenario.effects);
  return scenario;
}

export function parseScenario(input) {
  let parsed;
  try { parsed = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (error) { throw new ScenarioSchemaError(`Scenario is not valid JSON: ${error.message}`); }
  return validateScenario(parsed);
}

async function readJsonFile(filePath, limit, kind) {
  const bytes = await readFile(filePath);
  if (bytes.byteLength > limit) throw new ScenarioSchemaError(`${kind} file exceeds the ${limit}-byte limit.`);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw new ScenarioSchemaError(`${kind} file is not valid JSON: ${error.message}`); }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hashObject(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function appendJournal(journal, type, data) {
  if (typeof journal?.append === 'function') journal.append(type, data);
}

function writeSummary(journal, status, details) {
  if (typeof journal?.finalize === 'function') journal.finalize(status, details);
}

function markAssertion(outcomes, { name, pass, detail, incomplete = false }) {
  outcomes.push({ name, status: incomplete ? 'incomplete' : pass ? 'pass' : 'fail', detail });
}

function normalizeRole(line) {
  const raw = line?.role ?? line?.speaker ?? line?.author ?? line?.messageType;
  if (typeof raw !== 'string') return '';
  const role = raw.toLowerCase();
  if (['ai', 'assistant', 'agent', 'bot'].includes(role) || role.includes('assistant')) return 'assistant';
  if (['user', 'human', 'caller', 'patient'].includes(role) || role.includes('user')) return 'user';
  return '';
}

function normalizeLine(line) {
  const value = line?.transcriptLine ?? line?.line ?? line;
  const role = normalizeRole(value);
  const text = typeof value?.text === 'string' ? value.text : typeof value?.content === 'string' ? value.content : '';
  const functionCalls = Array.isArray(value?.functionCalls) ? value.functionCalls : [];
  return { role, text, functionCalls, raw: value };
}

function flattenLines(root) {
  const candidates = [
    root?.transcriptLines,
    root?.transcript?.lines,
    root?.transcript?.messages,
    root?.transcript,
    root?.data?.transcriptLines,
    root?.data?.transcript?.lines,
    root?.data?.transcript?.messages,
    root?.data?.transcript,
    root?.data?.aiChat?.transcript?.lines,
    root?.data?.aiChat?.transcript?.messages,
    root?.data?.aiChat?.transcript,
    root?.chat?.transcript?.lines,
    root?.chat?.transcript?.messages,
    root?.chat?.transcript,
  ];
  const lines = candidates.find(Array.isArray);
  return Array.isArray(lines) ? lines.map(normalizeLine) : [];
}

function persistedTurn(lines, input, previousAssistantCount) {
  const assistant = lines.filter(line => line.role === 'assistant');
  const newLines = assistant.slice(previousAssistantCount);
  let reply = newLines.map(line => line.text).join('');
  if (!reply) {
    const userIndex = lines.findLastIndex(line => line.role === 'user' && line.text.trim() === input.trim());
    if (userIndex >= 0) {
      reply = lines.slice(userIndex + 1).filter(line => line.role === 'assistant').map(line => line.text).join('');
    }
  }
  return { reply: reply.trim(), assistantCount: assistant.length };
}

function persistedCallsForLatestTurn(lines, input) {
  const userIndex = lines.findLastIndex(line => line.role === 'user' && line.text.trim() === input.trim());
  if (userIndex < 0) return null;
  const nextUser = lines.findIndex((line, index) => index > userIndex && line.role === 'user');
  const end = nextUser < 0 ? lines.length : nextUser;
  return lines.slice(userIndex, end).flatMap(line => line.functionCalls);
}

function getTraceStatus(snapshot, lines = []) {
  const value = snapshot?.traceStatus ?? snapshot?.data?.traceStatus ?? snapshot?.data?.aiChat?.traceStatus ?? snapshot?.transcript?.traceStatus;
  if (typeof value === 'string') return value.toLowerCase();
  return lines.some(line => Array.isArray(line.raw?.functionCalls)) ? 'available' : null;
}

function matchFunctionCall(actual, expected) {
  const actualName = actual?.name ?? actual?.functionName ?? actual?.function?.name;
  if (actualName !== expected.name) return false;
  if (!Object.hasOwn(expected, 'arguments')) return true;
  const actualArgs = actual?.arguments ?? actual?.args ?? actual?.input;
  if (typeof actualArgs === 'string' && typeof expected.arguments !== 'string') {
    try { return stableJson(JSON.parse(actualArgs)) === stableJson(expected.arguments); } catch { return false; }
  }
  return stableJson(actualArgs) === stableJson(expected.arguments);
}

function runAssertions(turn, reply, calls, traceStatus, persisted) {
  const result = [];
  for (const text of turn.assertions.exactText ?? []) {
    markAssertion(result, { name: `${turn.name}: exact text ${JSON.stringify(text)}`, pass: reply.includes(text), detail: reply.includes(text) ? 'persisted assistant reply contains the exact required text' : 'persisted assistant reply is missing the required exact text' });
  }
  for (const text of turn.assertions.forbiddenText ?? []) {
    markAssertion(result, { name: `${turn.name}: forbidden text ${JSON.stringify(text)}`, pass: !reply.includes(text), detail: reply.includes(text) ? 'persisted assistant reply contains forbidden text' : 'persisted assistant reply does not contain forbidden text' });
  }
  for (const expected of turn.assertions.functionCalls ?? []) {
    const available = traceStatus === 'available' || traceStatus === 'complete' || traceStatus === 'supported';
    if (!persisted || !available || !Array.isArray(calls)) {
      markAssertion(result, { name: `${turn.name}: function call ${expected.name}`, incomplete: true, detail: 'saved function trace is absent or unsupported; no call is inferred from conversation text' });
      continue;
    }
    const matched = calls.some(call => matchFunctionCall(call, expected));
    markAssertion(result, { name: `${turn.name}: function call ${expected.name}`, pass: matched, detail: matched ? 'saved function-call name and requested arguments match' : 'the saved function-call trace does not contain the expected exact call' });
  }
  return result;
}

function statusFromAssertions(assertions) {
  if (assertions.some(item => item.status === 'incomplete')) return 'incomplete';
  if (assertions.some(item => item.status === 'fail')) return 'fail';
  return 'pass';
}

function normalizeInspection(value) {
  if (!isObject(value)) return null;
  const inspection = value.inspection ?? value;
  if (!isObject(inspection) || typeof inspection.knownStaging !== 'boolean') return null;
  return inspection;
}

async function inspectTarget(provider, agentId) {
  if (typeof provider?.inspectAgent !== 'function' || typeof provider?.listAgents !== 'function') throw new Error('Provider does not support safe agent inspection.');
  const agents = await provider.listAgents();
  if (!Array.isArray(agents)) throw new Error('Provider agent listing returned an unexpected response.');
  const agent = agents.find(item => item?.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} was not found in the exact agent listing.`);
  let phonesResult = { status: 'unavailable', data: [] };
  if (typeof provider.listPhones === 'function') {
    try { phonesResult = { status: 'available', data: await provider.listPhones() }; }
    catch (error) { phonesResult = { status: 'unavailable', data: [], error: error.message }; }
  }
  const inspection = normalizeInspection(await provider.inspectAgent(agent, phonesResult));
  if (!inspection) throw new Error('Provider agent inspection returned no guard classification.');
  return inspection;
}

function createEffectAdapter(scenario, allowLive) {
  if (!scenario.effects) return null;
  return createKyronReadOnlyAdapter({
    baseUrl: scenario.effects.baseUrl,
    patientId: scenario.effects.patientId,
    allowRemote: allowLive,
  });
}

function invokeWithDeadline(promiseOrThunk, deadline, label) {
  const left = deadline - Date.now();
  if (left <= 0) return Promise.reject(new Error(`${label} exceeded the scenario time budget.`));
  const operation = typeof promiseOrThunk === 'function' ? Promise.resolve().then(promiseOrThunk) : Promise.resolve(promiseOrThunk);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded the scenario time budget.`)), left);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function readSavedChat(provider, chatId, deadline) {
  const read = provider.readChat ?? provider.getChat;
  if (typeof read !== 'function') throw new Error('Provider does not support persisted chat readback.');
  return invokeWithDeadline(() => read.call(provider, chatId), deadline, 'Persisted chat readback');
}

async function runTurnWithDeadline(provider, chatId, text, deadline) {
  const left = deadline - Date.now();
  if (left <= 0) throw new Error('Turn exceeded the scenario time budget before submission.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), left);
  try {
    return await provider.runChatTurn({ chatId, text, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && !error.message.includes('budget')) {
      error.message = `Turn exceeded the scenario time budget; provider outcome is unknown. ${error.message}`;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function asChatId(value) {
  if (typeof value === 'string' && value) return value;
  if (typeof value?.id === 'string' && value.id) return value.id;
  if (typeof value?.chatId === 'string' && value.chatId) return value.chatId;
  return null;
}

function configEvidence(inspection, supplied) {
  const snapshot = supplied?.configurationHash ? supplied : createConfigSnapshot(inspection);
  return { value: { ...snapshot, knownStaging: inspection.knownStaging }, sha256: snapshot.configurationHash ?? hashObject(snapshot) };
}

function requestedCallInput(args, scenario) {
  if (args.callInputProvided === true) return args.callAgentInput;
  if (isObject(args.callAgentInput) && Object.keys(args.callAgentInput).length > 0) return args.callAgentInput;
  return scenario.inputs.callAgentInput;
}

function resultForTurn(turn, stream, reply, calls, traceStatus, assertions) {
  return {
    name: turn.name,
    input: turn.input,
    status: stream?.status === 'incomplete' ? 'incomplete' : statusFromAssertions(assertions),
    reply,
    streamedReply: typeof stream?.text === 'string' ? stream.text : null,
    persisted: typeof reply === 'string' && reply.length > 0,
    traceStatus,
    functionCalls: Array.isArray(calls) ? calls : null,
    assertions,
    submittedAt: stream?.submittedAt ?? null,
    completedAt: stream?.completedAt ?? null,
    transport: {
      status: stream?.status ?? 'unknown',
      outcome: stream?.outcome ?? null,
      failure: stream?.failure ?? null,
    },
  };
}

/** Run one validated, fresh-chat scenario and save its evidence through journal. */
export async function runScenario(args, deps = {}) {
  const scenario = args.scenario ? parseScenario(args.scenario) : parseScenario(await readJsonFile(args.scenarioPath, MAX_SCENARIO_BYTES, 'Scenario'));
  const agentId = args.agentId ?? scenario.agentId;
  if (typeof agentId !== 'string' || !agentId.trim()) throw new ScenarioSchemaError('Scenario run requires an explicit target agent ID.');
  if (scenario.agentId && scenario.agentId !== agentId) throw new ScenarioSchemaError('The requested agent ID does not match scenario.agentId.');
  const provider = deps.provider;
  if (!provider) throw new Error('Scenario runner needs an injected Vogent provider.');
  const turnBudget = withinInteger(args.maxTurns ?? scenario.limits?.maxTurns, { min: 1, max: HARD_MAX_TURNS, fallback: DEFAULT_MAX_TURNS, label: 'maxTurns' });
  const maxTurns = Math.min(turnBudget, scenario.turns.length);
  const timeoutMs = withinInteger(args.timeoutMs ?? scenario.limits?.timeoutMs, { min: 1_000, max: HARD_TURN_TIMEOUT_MS, fallback: DEFAULT_TURN_TIMEOUT_MS, label: 'timeoutMs' });
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + timeoutMs;
  const inspection = await inspectTarget(provider, agentId);
  const liveAcknowledged = args.allowLive === true || args.ackTarget === agentId;
  if (!inspection.knownStaging && !liveAcknowledged) {
    throw new Error('Scenario target is not classified as an unlinked staging configuration. Inspect it, then acknowledge the exact target with --ack-target <agent ID>.');
  }

  const config = configEvidence(inspection, deps.configSnapshot);
  const effectsAdapter = deps.effectAdapter ?? createEffectAdapter(scenario, liveAcknowledged);
  const callAgentInput = requestedCallInput(args, scenario);
  const header = {
    schemaVersion: 1,
    kind: 'vogent-scenario-run',
    scenario: { name: scenario.name, schemaVersion: scenario.schemaVersion, source: args.scenarioPath ? resolve(args.scenarioPath) : 'inline' },
    agentId,
    startedAt,
    limits: { maxTurns: turnBudget, timeoutMs },
    configuration: config.value,
    configurationHash: config.sha256,
    callAgentInput,
  };
  const journal = deps.createJournal ? deps.createJournal({ dataDir: deps.dataDir, header }) : deps.journal;
  if (!journal) throw new Error('Scenario runner needs a private evidence journal.');
  appendJournal(journal, 'scenario_started', { scenario: header.scenario, limits: header.limits, configurationHash: config.sha256 });

  let beforeEffects = null;
  let afterEffects = null;
  let chatId = null;
  let transportIncomplete = false;
  let budgetStopped = false;
  let status = 'pass';
  const turns = [];
  const assertions = [];
  let assistantLineCount = 0;
  let lastSnapshot = null;

  if (effectsAdapter) {
    try {
      beforeEffects = await invokeWithDeadline(() => snapshotEffects(effectsAdapter), deadline, 'Before-effect snapshot');
      appendJournal(journal, 'effects_before', { adapterId: beforeEffects.adapterId, snapshot: beforeEffects.value });
    } catch (error) {
      beforeEffects = effectSnapshotFailure(effectsAdapter, error);
      appendJournal(journal, 'effects_before_incomplete', beforeEffects);
      status = 'incomplete';
    }
    if (beforeEffects?.status !== 'ready') {
      const result = {
        schemaVersion: 1, kind: 'vogent-scenario-result', status: 'incomplete',
        scenario: scenario.name, agentId, runId: journal.runId ?? null,
        evidencePath: journal.filePath ?? null, chatId: null,
        configurationHash: config.sha256, limits: { maxTurns: turnBudget, timeoutMs },
        turns: [], assertions: [], effects: beforeEffects,
        reason: 'baseline effect snapshot unavailable; no chat was created',
        startedAt, finishedAt: new Date().toISOString(),
      };
      appendJournal(journal, 'scenario_result', result);
      writeSummary(journal, result.status, result);
      return result;
    }
  }

  try {
    if (Date.now() >= deadline) throw new Error('Scenario time budget expired before chat creation.');
    const created = await invokeWithDeadline(() => provider.createChat({
      agentId,
      callAgentInput,
    }), deadline, 'Chat creation');
    chatId = asChatId(created);
    if (!chatId) throw new Error('Provider did not return a persisted chat ID.');
    appendJournal(journal, 'chat_created', { chatId, createdAt: new Date().toISOString() });

    for (const [index, turn] of scenario.turns.slice(0, maxTurns).entries()) {
      if (Date.now() >= deadline) {
        budgetStopped = true;
        transportIncomplete = true;
        appendJournal(journal, 'budget_stop', { reason: 'scenario time budget expired', nextTurn: turn.name, turnsCompleted: index });
        break;
      }
      const submittedAt = new Date().toISOString();
      appendJournal(journal, 'turn_submitted', { index: index + 1, name: turn.name, input: turn.input, submittedAt });
      let stream;
      try {
        stream = await runTurnWithDeadline(provider, chatId, turn.input, deadline);
      } catch (error) {
        transportIncomplete = true;
        const record = { name: turn.name, input: turn.input, status: 'incomplete', failure: error.message, submittedAt };
        turns.push(record);
        appendJournal(journal, 'turn_incomplete', record);
        break;
      }
      if (!stream || stream.status !== 'complete') transportIncomplete = true;
      const streamText = typeof stream?.text === 'string' ? stream.text : '';
      appendJournal(journal, stream?.status === 'incomplete' ? 'turn_transport_incomplete' : 'turn_stream_complete', {
        index: index + 1, name: turn.name, text: streamText,
        status: stream?.status ?? 'unknown', outcome: stream?.outcome ?? null,
        functionCalls: stream?.functionCalls ?? null, nodeTransitions: stream?.nodeTransitions ?? null,
        traceStatus: stream?.traceStatus ?? null, submittedAt: stream?.submittedAt ?? submittedAt,
        completedAt: stream?.completedAt ?? null, failure: stream?.failure ?? null,
      });

      let snapshot;
      try {
        snapshot = await readSavedChat(provider, chatId, deadline);
        lastSnapshot = snapshot;
      } catch (error) {
        transportIncomplete = true;
        const record = resultForTurn(turn, stream, '', null, null, [{ name: 'persisted readback', status: 'incomplete', detail: error.message }]);
        turns.push(record);
        appendJournal(journal, 'turn_readback_incomplete', { index: index + 1, name: turn.name, error: error.message });
        break;
      }
      const lines = flattenLines(snapshot);
      const saved = persistedTurn(lines, turn.input, assistantLineCount);
      assistantLineCount = saved.assistantCount;
      const savedCalls = persistedCallsForLatestTurn(lines, turn.input);
      const traceStatus = getTraceStatus(snapshot, lines);
      const hasReply = saved.reply.length > 0;
      const agrees = hasReply && streamText ? saved.reply === streamText.trim() : hasReply;
      const outcomeUnknown = stream?.status !== 'complete' || stream?.outcome === 'outcome_unknown';
      const turnAssertions = hasReply ? runAssertions(turn, saved.reply, savedCalls, traceStatus, true) : [];
      if (!hasReply) {
        transportIncomplete = true;
        turnAssertions.push({ name: `${turn.name}: persisted reply`, status: 'incomplete', detail: 'saved chat has no assistant reply for this submitted turn' });
      } else if (!agrees) {
        transportIncomplete = true;
        turnAssertions.push({ name: `${turn.name}: stream/readback agreement`, status: 'incomplete', detail: 'streamed and persisted replies differ; outcome cannot be treated as settled' });
      }
      if (outcomeUnknown) {
        transportIncomplete = true;
        turnAssertions.push({ name: `${turn.name}: transport outcome`, status: 'incomplete', detail: 'provider marked the turn outcome uncertain' });
      }
      const record = resultForTurn(turn, stream, saved.reply, savedCalls, traceStatus, turnAssertions);
      turns.push(record);
      assertions.push(...turnAssertions);
      appendJournal(journal, 'turn_persisted', {
        index: index + 1, name: turn.name, input: turn.input, reply: saved.reply, persisted: hasReply,
        functionCalls: savedCalls, traceStatus, assertions: turnAssertions,
      });
    }

    if (scenario.turns.length > maxTurns) {
      budgetStopped = true;
      transportIncomplete = true;
      appendJournal(journal, 'budget_stop', { reason: 'turn budget reached', maxTurns, scenarioTurns: scenario.turns.length });
    }
  } catch (error) {
    transportIncomplete = true;
    status = 'incomplete';
    appendJournal(journal, 'scenario_transport_error', { error: error.message, chatId });
  } finally {
    if (effectsAdapter && chatId) {
      try {
        afterEffects = await invokeWithDeadline(() => snapshotEffects(effectsAdapter), deadline, 'After-effect snapshot');
        appendJournal(journal, 'effects_after', { adapterId: afterEffects.adapterId, snapshot: afterEffects.value });
      } catch (error) {
        afterEffects = effectSnapshotFailure(effectsAdapter, error);
        appendJournal(journal, 'effects_after_incomplete', afterEffects);
      }
    }
  }

  if (chatId && typeof (provider.readChat ?? provider.getChat) === 'function' && !lastSnapshot) {
    try { lastSnapshot = await readSavedChat(provider, chatId, deadline); }
    catch (error) { transportIncomplete = true; appendJournal(journal, 'final_readback_incomplete', { error: error.message }); }
  }

  let effectResult = { status: 'not_requested' };
  if (effectsAdapter) {
    const speech = scenario.effects ? {
      ...scenario.effects.speech,
      turns: turns.map(turn => ({ name: turn.name, input: turn.input, reply: turn.reply, persisted: turn.persisted })),
    } : null;
    const expected = scenario.effects?.expectedAppointment;
    try {
      effectResult = finishEffects(effectsAdapter, beforeEffects, afterEffects, {
        expected, speech, turnOutcome: transportIncomplete ? 'incomplete' : 'complete',
      });
    } catch (error) {
      effectResult = { status: 'incomplete', adapterId: effectsAdapter.id ?? 'custom', reason: error.message };
    }
    appendJournal(journal, 'effects_reconciled', effectResult);
  }

  if (transportIncomplete || budgetStopped || assertions.some(item => item.status === 'incomplete') || effectResult.status === 'incomplete') status = 'incomplete';
  else if (assertions.some(item => item.status === 'fail') || effectResult.status === 'fail') status = 'fail';
  else status = 'pass';

  const result = {
    schemaVersion: 1,
    kind: 'vogent-scenario-result',
    status,
    scenario: scenario.name,
    agentId,
    runId: journal.runId ?? null,
    evidencePath: journal.filePath ?? null,
    chatId,
    configurationHash: config.sha256,
    limits: { maxTurns: turnBudget, timeoutMs },
    turns,
    assertions,
    effects: effectResult,
    reason: budgetStopped ? 'scenario budget exhausted' : undefined,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  appendJournal(journal, 'scenario_result', result);
  writeSummary(journal, status, result);
  return result;
}

function aggregateStatus(results, exhausted = false) {
  if (results.some(result => result.status === 'fail')) return 'fail';
  if (exhausted || results.some(result => result.status === 'incomplete')) return 'incomplete';
  return 'pass';
}

/** Run suite members one at a time; concurrency is deliberately fixed at 1. */
export async function runSuite(args, deps = {}) {
  const suitePath = resolve(args.suitePath ?? args.scenarioPath ?? args.file ?? '');
  const suite = await readJsonFile(suitePath, MAX_SUITE_BYTES, 'Suite');
  if (!isObject(suite) || suite.schemaVersion !== 1 || typeof suite.name !== 'string' || !suite.name.trim() || !Array.isArray(suite.scenarios)) {
    throw new ScenarioSchemaError('Suite must have schemaVersion 1, a name, and a scenarios array.');
  }
  if (suite.scenarios.length < 1 || suite.scenarios.some(file => typeof file !== 'string' || !file.trim())) {
    throw new ScenarioSchemaError('Suite scenarios must contain scenario file paths.');
  }
  const limits = suite.limits ?? {};
  const maxScenarios = withinInteger(args.maxScenarios ?? limits.maxScenarios, { min: 1, max: HARD_SUITE_MAX_SCENARIOS, fallback: DEFAULT_SUITE_MAX_SCENARIOS, label: 'suite maxScenarios' });
  const timeoutMs = withinInteger(args.timeoutMs ?? limits.timeoutMs, { min: 1_000, max: HARD_SUITE_TIMEOUT_MS, fallback: DEFAULT_SUITE_TIMEOUT_MS, label: 'suite timeoutMs' });
  const concurrency = args.concurrency ?? suite.concurrency ?? 1;
  if (concurrency !== 1) throw new ScenarioSchemaError('Scenario suites currently support concurrency 1 only.');
  const journal = deps.createJournal ? deps.createJournal({
    dataDir: deps.dataDir,
    header: { schemaVersion: 1, kind: 'vogent-scenario-suite', name: suite.name, source: suitePath, concurrency, limits: { maxScenarios, timeoutMs } },
  }) : deps.journal;
  if (!journal) throw new Error('Scenario suite needs an evidence journal.');
  appendJournal(journal, 'suite_started', { name: suite.name, concurrency, limits: { maxScenarios, timeoutMs } });
  const startedAt = Date.now();
  const results = [];
  const count = Math.min(suite.scenarios.length, maxScenarios);
  let exhausted = count < suite.scenarios.length;
  for (const [index, relativePath] of suite.scenarios.slice(0, count).entries()) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining < 1_000) {
      exhausted = true;
      appendJournal(journal, 'suite_budget_stop', { reason: 'suite time budget exhausted', nextScenario: relativePath });
      break;
    }
    const scenarioPath = resolve(dirname(suitePath), relativePath);
    let child;
    try {
      child = await runScenario({ ...args, scenarioPath, timeoutMs: Math.min(remaining, HARD_TURN_TIMEOUT_MS) }, deps);
    } catch (error) {
      child = { status: error instanceof ScenarioSchemaError ? 'fail' : 'incomplete', scenarioPath, error: error.message, runId: null };
    }
    results.push(child);
    appendJournal(journal, 'suite_scenario', { index: index + 1, scenarioPath, status: child.status, runId: child.runId, chatId: child.chatId ?? null, evidencePath: child.evidencePath ?? null });
    if (Date.now() - startedAt >= timeoutMs && index + 1 < count) {
      exhausted = true;
      appendJournal(journal, 'suite_budget_stop', { reason: 'suite time budget exhausted', completed: index + 1 });
      break;
    }
  }
  if (results.some(result => result.status === 'incomplete')) exhausted = exhausted || results.some(result => result.reason === 'scenario budget exhausted');
  const result = {
    schemaVersion: 1, kind: 'vogent-scenario-suite-result', name: suite.name,
    status: aggregateStatus(results, exhausted), concurrency: 1,
    runId: journal.runId ?? null, evidencePath: journal.filePath ?? null,
    completed: results.length, requested: suite.scenarios.length, results,
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
  };
  appendJournal(journal, 'suite_result', result);
  writeSummary(journal, result.status, result);
  return result;
}

export async function listScenarios(directory = new URL('../examples/', import.meta.url)) {
  const dirPath = directory instanceof URL ? resolve(new URL('.', directory).pathname) : resolve(directory);
  const entries = await readdir(dirPath, { withFileTypes: true });
  const scenarios = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.scenario.json')) continue;
    const file = resolve(dirPath, entry.name);
    try {
      const scenario = parseScenario(await readJsonFile(file, MAX_SCENARIO_BYTES, 'Scenario'));
      scenarios.push({ name: scenario.name, file, turns: scenario.turns.length });
    } catch (error) {
      scenarios.push({ name: null, file, error: error.message });
    }
  }
  return scenarios.sort((left, right) => left.file.localeCompare(right.file));
}

/** Stable CLI command seam imported lazily by chat.mjs. */
export async function handleScenarios(args, deps = {}) {
  if (args.action === 'list') return listScenarios(args.directory);
  let result;
  if (args.action === 'compare') {
    if (typeof args.before !== 'string' || typeof args.after !== 'string') throw new ScenarioSchemaError('scenario compare requires --before RUN.jsonl --after RUN.jsonl.');
    result = await compareSavedRuns(args.before, args.after);
  } else if (args.command === 'suite' || args.action === 'suite') {
    result = await runSuite(args, deps);
  } else if (args.action === 'run') {
    result = await runScenario(args, deps);
  } else {
    throw new ScenarioSchemaError('Use scenario list, scenario run, scenario compare, or suite run.');
  }
  if (['fail', 'regression'].includes(result.status)) process.exitCode = 1;
  else if (['incomplete', 'inconclusive'].includes(result.status) && !process.exitCode) process.exitCode = 2;
  return result;
}
