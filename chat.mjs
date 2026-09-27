#!/usr/bin/env node
// Dashboard-observed GraphQL chat API. This CLI keeps provider evidence local;
// chat remains stateful and may invoke linked functions.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProvider, getCredential, functionTarget } from './lib/provider.mjs';
import { createJournal, defaultDataDir, readJournal } from './lib/journal.mjs';
import { createConfigSnapshot, diffSnapshots, getProfile, loadProfiles, profileFilePath, readJson, saveJsonPrivate, saveProfile, targetAllowed } from './lib/config.mjs';
import { acquireSessionLock, loadSession, saveSession, sessionPath } from './lib/sessions.mjs';
import { buildDialTimeline } from './lib/dials.mjs';
import { redactForExport } from './lib/redaction.mjs';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const COMMANDS = new Set(['start', 'send', 'get', 'export', 'dial', 'doctor', 'profile', 'config', 'trace', 'diagnose-tools', 'control-preflight', 'scenario', 'suite']);
const PROFILE_ACTIONS = new Set(['inspect', 'set', 'list']);
const CONFIG_ACTIONS = new Set(['snapshot', 'diff']);

export function usage() {
  return [
    'Usage:',
    '  node chat.mjs [--list] [--agent ID|NAME] [--inspect] [--message TEXT ...] [--output human|json|jsonl]',
    '  Use --message=--flag to send a flag-looking literal or --message-file PATH to read an exact turn from a file.',
    '  node chat.mjs start --agent ID [--call-input JSON] [--message TEXT ...]',
    '  node chat.mjs send --chat-id ID --agent ID --message TEXT   (requires a locally created session)',
    '  node chat.mjs get --chat-id ID | export --chat-id ID [--redact] [--out FILE]',
    '  node chat.mjs dial export --dial-id ID [--redact] [--out FILE]',
    '  node chat.mjs doctor | profile inspect [--name NAME] | profile set NAME --agent-id ID [--allow-target HOST/PREFIX]',
    '  node chat.mjs config snapshot --agent ID [--out FILE] | config diff --before FILE --after FILE',
    '  node chat.mjs diagnose-tools --agent ID [--chat-id ID] | trace --chat-id ID | control-preflight ...',
    '  node chat.mjs scenario list | scenario run --scenario FILE --agent ID | scenario compare --before RUN --after RUN | suite run --scenario FILE',
    '',
    'Every chat requires per-run confirmation: type the exact agent name interactively, or use --allow-live / --ack-target EXACT_AGENT_ID.',
    'Set VOGENT_API_KEY or use --env-file PATH. Set VOGENT_CHAT_HOME to choose the private evidence directory.',
  ].join('\n');
}

export function parseArgs(argv) {
  const args = {
    command: 'chat', action: null, agent: null, messages: [], chatId: null, dialId: null,
    list: false, inspect: false, allowLive: false, ackTarget: null, callAgentInput: {},
    callInputProvided: false, output: 'human', redact: false, out: null, name: null,
    profileName: null, dataDir: null, envFile: null, apiBase: null, wsUrl: null,
    expectedDefault: null, before: null, after: null, allowedTargets: [],
    harmlessFunctionIds: [], harmlessTargets: [], expectedPromptId: null,
    scenarioPath: null, maxTurns: null, maxScenarios: null,
  };
  let offset = 0;
  if (argv[0] && COMMANDS.has(argv[0])) {
    args.command = argv[offset++];
    if (['profile', 'config', 'dial', 'scenario', 'suite'].includes(args.command) && argv[offset] && !argv[offset].startsWith('--')) args.action = argv[offset++];
    if (args.command === 'profile' && args.action === 'set' && argv[offset] && !argv[offset].startsWith('--')) args.name = argv[offset++];
  }
  const valueFlags = new Map([
    ['--agent', 'agent'], ['--agent-id', 'agent'], ['--message', 'message'], ['--message-file', 'messageFile'], ['--chat-id', 'chatId'],
    ['--dial-id', 'dialId'], ['--call-input', 'callInput'], ['--output', 'output'], ['--out', 'out'],
    ['--name', 'name'], ['--profile', 'profileName'], ['--data-dir', 'dataDir'], ['--env-file', 'envFile'],
    ['--api-base', 'apiBase'], ['--ws-url', 'wsUrl'], ['--expected-default', 'expectedDefault'],
    ['--before', 'before'], ['--after', 'after'], ['--allow-target', 'allowTarget'],
    ['--harmless-function-id', 'harmlessFunctionId'], ['--harmless-target', 'harmlessTarget'],
    ['--expected-prompt-id', 'expectedPromptId'], ['--ack-target', 'ackTarget'],
    ['--scenario', 'scenarioPath'], ['--file', 'scenarioPath'], ['--max-turns', 'maxTurns'], ['--max-scenarios', 'maxScenarios'],
  ]);
  for (let i = offset; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') { args.help = true; continue; }
    if (token === '--list') { args.list = true; continue; }
    if (token === '--inspect') { args.inspect = true; continue; }
    if (token === '--allow-live') { args.allowLive = true; continue; }
    if (token === '--redact') { args.redact = true; continue; }
    if (token === '--json') { args.output = 'json'; continue; }
    if (token === '--jsonl') { args.output = 'jsonl'; continue; }
    const equalsAt = token.indexOf('=');
    const flag = equalsAt > 0 ? token.slice(0, equalsAt) : token;
    const field = valueFlags.get(flag);
    if (!field) throw new Error(`Unknown argument: ${token}`);
    let value;
    if (equalsAt > 0) value = token.slice(equalsAt + 1);
    else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${flag}. Use ${flag}=VALUE when the value begins with --.`);
      value = argv[++i];
    }
    if (field === 'message') args.messages.push(value);
    else if (field === 'messageFile') {
      try { args.messages.push(readFileSync(value, 'utf8').replace(/\r?\n$/, '')); }
      catch (error) { throw new Error(`Cannot read --message-file: ${error.message}`); }
    } else if (field === 'callInput') {
      if (args.callInputProvided) throw new Error('--call-input may be supplied only once.');
      try { args.callAgentInput = JSON.parse(value); }
      catch { throw new Error('--call-input must be valid JSON.'); }
      if (!args.callAgentInput || typeof args.callAgentInput !== 'object' || Array.isArray(args.callAgentInput)) throw new Error('--call-input must be a JSON object.');
      args.callInputProvided = true;
    } else if (field === 'allowTarget' || field === 'harmlessTarget') {
      const target = parseTarget(value);
      (field === 'allowTarget' ? args.allowedTargets : args.harmlessTargets).push(target);
    } else if (field === 'harmlessFunctionId') args.harmlessFunctionIds.push(value);
    else if (field === 'maxTurns' || field === 'maxScenarios') {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${token} must be a positive integer.`);
      args[field] = number;
    } else args[field] = value;
  }
  if (args.output && !['human', 'json', 'jsonl'].includes(args.output)) throw new Error('--output must be human, json or jsonl.');
  if (args.list && (args.inspect || args.messages.length)) throw new Error('--list cannot be combined with --inspect or --message.');
  if (args.inspect && args.messages.length) throw new Error('--inspect cannot be combined with --message.');
  if (args.command === 'profile' && !PROFILE_ACTIONS.has(args.action)) throw new Error('Use `profile inspect`, `profile list`, or `profile set`.');
  if (args.command === 'config' && !CONFIG_ACTIONS.has(args.action)) throw new Error('Use `config snapshot` or `config diff`.');
  if (args.command === 'dial' && args.action !== 'export') throw new Error('Use `dial export --dial-id ID`.');
  if (args.command === 'send' && (!args.chatId || args.messages.length !== 1)) throw new Error('send requires --chat-id ID and exactly one --message TEXT.');
  if (args.command === 'control-preflight' && args.messages.length !== 1) throw new Error('control-preflight requires exactly one --message TEXT.');
  if (args.command === 'scenario' && !['list', 'run', 'compare'].includes(args.action)) throw new Error('Use `scenario list`, `scenario run`, or `scenario compare`.');
  if (args.command === 'get' && !args.chatId) throw new Error('get requires --chat-id ID.');
  if (args.command === 'export' && !args.chatId) throw new Error('export requires --chat-id ID.');
  if (args.command === 'dial' && !args.dialId) throw new Error('dial export requires --dial-id ID.');
  return args;
}

function parseTarget(value) {
  let host, pathPrefix;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    host = url.host.toLowerCase();
    pathPrefix = url.pathname || '/';
  } catch { throw new Error(`Target must be HOST/PATH: ${value}`); }
  return { host, pathPrefix };
}

function print(value, output = 'human') {
  if (output === 'json') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (output === 'jsonl') process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorEnvelope(error, extra = {}) {
  const kind = error?.kind || 'cli_error';
  return { schema: 'vogent-cli-result.v1', status: kind === 'unsupported' ? 'unsupported' : 'failed', error: { kind, message: error.message }, ...extra };
}

function humanError(error) {
  process.stderr.write(`${error.message}\n`);
}

function matchesTarget(agent, profile, inspection) {
  if (!profile || profile.agentId !== agent.id || !inspection.functions.length) return { allowed: false, reason: 'no exact profile target authorization' };
  const allAllowed = inspection.functions.every(fn => fn.type === 'api' && targetAllowed(functionTarget(fn), profile.allowedTargets));
  return allAllowed ? { allowed: true, reason: `profile ${profile.name} authorizes exact agent and API targets` } : { allowed: false, reason: 'one or more function targets are outside the selected profile' };
}

export function traceChatReadback(readback) {
  const transcript = Array.isArray(readback.data?.transcript) ? readback.data.transcript : [];
  const functionCalls = [];
  const nodeTransitions = [];
  const lines = transcript.map((line, lineIndex) => {
    for (const call of Array.isArray(line.functionCalls) ? line.functionCalls : []) {
      functionCalls.push({ ...call, provenance: 'aiChat readback transcript.functionCalls', lineIndex,
        classification: call.name === 'commit_answer' ? 'internal_commit_answer' : 'provider_function_call_effect_unverified',
        backendApiInvocationProven: false });
    }
    if (line.nodeTransitionResult) nodeTransitions.push({ ...line.nodeTransitionResult, provenance: 'aiChat readback transcript.nodeTransitionResult', lineIndex });
    return { ...line, provenance: 'aiChat readback transcript', lineIndex };
  });
  return {
    schema: 'vogent-chat-trace.v1', chatId: readback.data.id,
    transcript: lines, functionCalls,
    nodeTransitions,
    availability: {
      functionCalls: functionCalls.length ? 'available' : 'no_records_returned_by_readback',
      nodeTransitions: nodeTransitions.length ? 'available' : 'unavailable',
      nodeTransitionResult: nodeTransitions.some(item => item.result != null) ? 'available' : 'unavailable',
      backendFunctionResults: 'unavailable_in_chat_schema',
    },
    provenance: readback.provenance,
    versionPinning: { requestedVersion: null, executedVersionProven: false },
  };
}

async function getPhoneResult(provider) {
  try { return { status: 'available', data: await provider.listPhones() }; }
  catch (error) { return { status: 'denied', data: [], error: { kind: error.kind || 'provider_error', message: error.message } }; }
}

async function selectAgent(args, provider, input) {
  const agents = await provider.listAgents();
  if (!agents.length) throw new Error('No Vogent agents were returned.');
  if (args.agent) {
    const query = args.agent.toLowerCase();
    const exact = agents.filter(agent => String(agent.id).toLowerCase() === query || String(agent.name).toLowerCase() === query);
    const matches = exact.length ? exact : agents.filter(agent => String(agent.name).toLowerCase().includes(query));
    if (matches.length !== 1) throw new Error(matches.length ? 'Agent name is ambiguous; use its ID.' : `Agent ${args.agent} was not found.`);
    return matches[0];
  }
  if (!input) throw new Error('Use --agent ID|NAME for noninteractive chat. Run --list to see agents.');
  agents.forEach((agent, i) => process.stdout.write(`${i + 1}. ${agent.name} (${agent.id})\n`));
  const answer = (await input.question('Choose an agent number: ')).trim();
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= agents.length) throw new Error('Choose a valid agent number.');
  return agents[index];
}

async function inspectSelected(provider, agent) {
  const phones = await getPhoneResult(provider);
  return provider.inspectAgent(agent, phones);
}

function expectedDefaultMatches(snapshot, expected) {
  return expected === snapshot.configurationHash || expected === snapshot.defaultPromptId;
}

function checkDefaultGuard(snapshot, explicit, profile) {
  const expected = explicit || profile?.expectedDefaultHash;
  if (!expected) return;
  if (!expectedDefaultMatches(snapshot, expected)) {
    const error = new Error(`Observed default configuration does not match the expected default (${expected}).`);
    error.kind = 'default_mismatch';
    throw error;
  }
}

async function acknowledgeTarget(args, agent, inspection, profile, input) {
  const authorization = matchesTarget(agent, profile, inspection);
  if (args.ackTarget === agent.id) return { allowed: true, reason: `explicit per-run --ack-target ${agent.id}` };
  if (args.ackTarget) throw new Error(`--ack-target must exactly match the selected agent ID (${agent.id}).`);
  if (input) {
    const answer = (await input.question(`This chat can invoke ${inspection.functions.map(fn => functionTarget(fn).host || fn.type).join(', ') || 'unverified functions'} for ${agent.name} (${agent.id}). Type the exact agent name to confirm this chat: `)).trim();
    if (answer === agent.name) return { allowed: true, reason: `interactive acknowledgment for ${agent.name} (${agent.id})` };
    throw new Error('Chat cancelled because the target name did not match.');
  }
  if (args.allowLive) return { allowed: true, reason: 'explicit per-run --allow-live confirmation' };
  if (authorization.allowed) {
    throw new Error(`Profile ${profile.name} authorizes this exact target, but each chat still needs confirmation. Use --allow-live or --ack-target ${agent.id}.`);
  }
  throw new Error(`Target ${agent.name} (${agent.id}) has no matching profile authorization. Inspect it, then use --allow-live or --ack-target ${agent.id} to confirm this chat.`);
}

function buildRunResult({ journal, agent, inspection, snapshot, chat, turns, drift, status, sessionMode = 'created' }) {
  return {
    schema: 'vogent-chat-run.v1', status, runId: journal.runId, journalPath: journal.filePath,
    agent: { id: agent.id, name: agent.name, identityProvenance: 'selected from GET /api/agents' },
    chat: { id: chat.id, agentIdObservedFromRequest: agent.id, providerProvenAgentBinding: false },
    sessionMode,
    resumeEvidence: sessionMode === 'resumed' ? { status: turns.some(turn => turn.status === 'complete') ? 'stream_completed_on_existing_chat_id' : 'not_established', chatId: chat.id, providerAgentBinding: false } : null,
    callAgentInputAtCreation: journal.callAgentInput,
    observedDefaultPromptId: inspection.agent.defaultVersionedPromptId || null,
    requestedVersion: null, executedVersionProven: false,
    configurationHash: snapshot.configurationHash,
    turns, postRunConfigurationDrift: drift,
    scope: { createdDial: false, phoneAudioTested: false },
  };
}

async function runTurns({ args, provider, agent, inspection, snapshot, chat, dataDir, profile, input, output, sessionMode = 'created', previousSession = null }) {
  const release = acquireSessionLock(dataDir, chat.id);
  const journal = createJournal({ dataDir, header: {
    kind: sessionMode === 'resumed' ? 'chat_resume' : 'chat', agentId: agent.id, agentName: agent.name, chatId: chat.id,
    callAgentInputAtCreation: previousSession?.callAgentInput ?? args.callAgentInput, observedDefaultPromptId: agent.defaultVersionedPromptId || null,
    configurationHash: snapshot.configurationHash, profileName: profile?.name || null,
    providerVersionPinning: 'unsupported', sessionMode,
  } });
  journal.callAgentInput = args.callAgentInput;
  const session = {
    ...(previousSession || {}),
    schema: 'vogent-local-chat-session.v1', chatId: chat.id, agentId: agent.id,
    agentName: agent.name, providerAgentBinding: 'local association only',
    observedDefaultPromptId: agent.defaultVersionedPromptId || null,
    requestedVersion: null, executedVersionProven: false,
    configurationHash: snapshot.configurationHash,
    callAgentInput: args.callAgentInput,
    createdAt: previousSession?.createdAt || new Date().toISOString(), lastRunId: journal.runId,
  };
  saveSession(dataDir, session);
  const turns = [];
  let finished = false;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  const push = (type, data) => {
    const record = journal.append(type, data);
    if (output === 'jsonl') process.stdout.write(`${JSON.stringify(record)}\n`);
  };
  try {
    for (let index = 0; index < args.messages.length; index++) {
      const text = args.messages[index];
      const submittedAt = new Date().toISOString();
      push('turn_request_started', { index, text, submittedAt, chatId: chat.id });
      const onEvent = event => {
        if (event.type === 'turn_submitted') push('turn_submitted', { index, ...event });
        else if (event.type === 'stream_event') push('stream_event', { index, ...event });
        else if (event.type === 'provider_frame') push('provider_frame', { index, ...event });
        else if (event.type === 'malformed_frame') push('malformed_frame', { index, ...event });
      };
      try {
        const result = await provider.runChatTurn({ chatId: chat.id, text, signal: controller.signal, onEvent });
        turns.push({ index, input: text, status: result.status, outcome: result.outcome, reply: result.text,
          functionCalls: result.functionCalls, nodeTransitions: result.nodeTransitions, traceStatus: result.traceStatus,
          textReduction: result.textReduction, completedAt: new Date().toISOString() });
        push('turn_complete', turns.at(-1));
        if (output === 'human') {
          process.stdout.write(`You: ${text}\nAgent: ${result.text}\n`);
          if (result.functionCalls.length) process.stdout.write(`Function calls recorded: ${result.functionCalls.map(call => call.name || call.id || 'unknown').join(', ')}\n`);
        }
      } catch (error) {
        const submitted = error.details?.submitted === true;
        const outcome = submitted ? 'outcome_unknown' : 'not_submitted';
        const failure = { index, input: text, status: 'incomplete', outcome, failureKind: error.kind || 'provider_error',
          message: error.message, partialEvents: error.details?.events || [], failedAt: new Date().toISOString() };
        turns.push(failure);
        push('turn_incomplete', failure);
        const envelope = buildRunResult({ journal, agent, inspection, snapshot, chat, turns, drift: { status: 'not_checked_after_incomplete_turn' }, status: 'incomplete', sessionMode });
        journal.finalize('incomplete', { finalOutcome: outcome });
        finished = true;
        if (output === 'json') print({ ...envelope, journalPath: journal.filePath }, 'json');
        if (output === 'jsonl') process.stdout.write(`${JSON.stringify({ schema: 'vogent-chat-run.v1', status: 'incomplete', runId: journal.runId, outcome, journalPath: journal.filePath })}\n`);
        if (output === 'human') humanError(error);
        process.exitCode = 1;
        return;
      }
    }
    let drift = { status: 'unavailable' };
    try {
      const postInspection = await inspectSelected(provider, agent);
      const postSnapshot = createConfigSnapshot(postInspection);
      drift = diffSnapshots(snapshot, postSnapshot);
    } catch (error) { drift = { status: 'unavailable', reason: error.message }; }
    push('post_run_configuration_drift', drift);
    session.lastRunId = journal.runId;
    session.lastTurnAt = turns.length ? turns.at(-1).completedAt : null;
    saveSession(dataDir, session);
    const envelope = buildRunResult({ journal, agent, inspection, snapshot, chat, turns, drift, status: 'complete', sessionMode });
    journal.finalize('complete', { postRunConfigurationDrift: drift });
    finished = true;
    if (output === 'json') print(envelope, 'json');
    else if (output === 'jsonl') process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else if (!args.messages.length) process.stdout.write(`Chat ID: ${chat.id}\nPrivate evidence: ${journal.filePath}\n`);
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (!finished) journal.close();
    release();
  }
  return { journal, turns };
}

async function createAndRun(args, provider, dataDir, input, output) {
  const agent = await selectAgent(args, provider, input);
  const firstInspection = await inspectSelected(provider, agent);
  const firstSnapshot = createConfigSnapshot(firstInspection);
  const profile = args.profileName ? getProfile(dataDir, args.profileName) : null;
  if (args.profileName && !profile) throw new Error(`Profile ${args.profileName} was not found.`);
  checkDefaultGuard(firstSnapshot, args.expectedDefault, profile);
  const authorization = await acknowledgeTarget(args, agent, firstInspection, profile, input);
  // Re-read immediately before creation to detect a changed provider default/configuration.
  const secondInspection = await inspectSelected(provider, agent);
  const snapshot = createConfigSnapshot(secondInspection);
  if (snapshot.configurationHash !== firstSnapshot.configurationHash) {
    const error = new Error('Agent configuration changed between inspection and chat creation; no chat was created.');
    error.kind = 'configuration_race';
    throw error;
  }
  checkDefaultGuard(snapshot, args.expectedDefault, profile);
  const chat = await provider.createChat({ agentId: agent.id, callAgentInput: args.callAgentInput });
  const announce = {
    schema: 'vogent-chat-start.v1', status: 'created', chatId: chat.id, agentId: agent.id,
    callAgentInput: args.callAgentInput, targetAuthorization: authorization,
    observedDefaultPromptId: snapshot.defaultPromptId, requestedVersion: null,
    executedVersionProven: false,
  };
  if (output === 'human') {
    process.stdout.write('Text chat creates a persisted chat record and may invoke linked functions. It does not test phone audio or ASR.\n');
    process.stdout.write(`Chat ID: ${chat.id}\n`);
  }
  if (args.messages.length) {
    return runTurns({ args, provider, agent, inspection: secondInspection, snapshot, chat, dataDir, profile, input, output });
  }
  if (args.command === 'start' || !input) {
    const journal = createJournal({ dataDir, header: { kind: 'chat_created', agentId: agent.id, chatId: chat.id, requestedCallAgentInput: args.callAgentInput, configurationHash: snapshot.configurationHash } });
    journal.append('chat_created', announce);
    const path = sessionPath(dataDir, chat.id);
    const session = { schema: 'vogent-local-chat-session.v1', chatId: chat.id, agentId: agent.id, agentName: agent.name,
      providerAgentBinding: 'local association only', observedDefaultPromptId: snapshot.defaultPromptId,
      requestedVersion: null, executedVersionProven: false, configurationHash: snapshot.configurationHash,
      callAgentInput: args.callAgentInput, createdAt: new Date().toISOString(), lastRunId: journal.runId };
    saveSession(dataDir, session);
    journal.finalize('created', { sessionPath: path });
    const result = { ...announce, runId: journal.runId, journalPath: journal.filePath, sessionPath: path, configurationHash: snapshot.configurationHash };
    if (output === 'json') print(result, 'json');
    else if (output === 'jsonl') print(result, 'jsonl');
    return result;
  }
  while (true) {
    const message = (await input.question('You (/quit to end): ')).trim();
    if (message === '/quit') break;
    if (!message) continue;
    args.messages = [message];
    await runTurns({ args, provider, agent, inspection: secondInspection, snapshot, chat, dataDir, profile, input, output: 'human' });
    args.messages = [];
    if (process.exitCode) break;
  }
  return announce;
}

async function handleReadback(args, provider, output) {
  const readback = await provider.readChat(args.chatId);
  const trace = traceChatReadback(readback);
  const value = args.redact ? redactForExport(trace) : trace;
  if (args.out) writeStructured(args.out, value);
  else if (output === 'human') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else print(value, output);
  return value;
}

function writeStructured(path, value) {
  const destination = isAbsolute(path) ? path : resolve(path);
  const data = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(destination, data, { mode: 0o600, flag: 'wx' });
}

async function handleDialExport(args, provider, output) {
  const raw = await provider.getDial(args.dialId);
  const timeline = buildDialTimeline(raw);
  const value = args.redact ? redactForExport(timeline) : timeline;
  if (args.out) writeStructured(args.out, value);
  else if (output === 'human') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else print(value, output);
  return value;
}

async function handleProfile(args, dataDir, output) {
  if (args.action === 'list' || args.action === 'inspect') {
    const config = loadProfiles(dataDir);
    const value = args.name ? ({ name: args.name, ...(config.profiles[args.name] || null) }) : config;
    if (args.name && !config.profiles[args.name]) throw new Error(`Profile ${args.name} was not found.`);
    if (output === 'human') process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    else print(value, output);
    return value;
  }
  const name = args.name || args.profileName;
  if (!name || !args.agent) throw new Error('profile set requires NAME and --agent-id ID.');
  const profile = saveProfile(dataDir, name, {
    agentId: args.agent, allowedTargets: args.allowedTargets,
    expectedDefaultHash: args.expectedDefault,
    harmlessControl: args.harmlessFunctionIds.length ? {
      functionIds: args.harmlessFunctionIds, allowedTargets: args.harmlessTargets, expectedPromptId: args.expectedPromptId,
    } : undefined,
  });
  if (output === 'human') process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
  else print(profile, output);
  return profile;
}

async function handleConfig(args, provider, dataDir, input, output) {
  if (args.action === 'diff') {
    if (!args.before || !args.after) throw new Error('config diff requires --before FILE --after FILE.');
    const result = diffSnapshots(readJson(args.before), readJson(args.after));
    if (output === 'human') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else print(result, output);
    return result;
  }
  if (!args.agent) throw new Error('config snapshot requires --agent ID.');
  const agent = await selectAgent(args, provider, input);
  const inspection = await inspectSelected(provider, agent);
  const snapshot = createConfigSnapshot(inspection);
  if (args.out) saveJsonPrivate(resolve(args.out), snapshot);
  if (output === 'human') process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  else print(snapshot, output);
  return snapshot;
}

async function handleDiagnostic(args, provider, dataDir, output) {
  const module = await import('./lib/diagnostics.mjs');
  const profiles = loadProfiles(dataDir).profiles;
  const profile = args.profileName ? getProfile(dataDir, args.profileName) : null;
  const result = await module.handleDiagnostics(args.command, { ...args, message: args.messages[0] }, { provider, profile, profileName: args.profileName, profiles });
  if (output === 'human') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else print(result, output);
  return result;
}

async function handleScenario(args, provider, dataDir, input, output) {
  if (args.command === 'suite' || ['list', 'run', 'compare'].includes(args.action)) {
    const agent = args.agent ? await selectAgent(args, provider, input) : null;
    let configSnapshot = null;
    let profile = args.profileName ? getProfile(dataDir, args.profileName) : null;
    if (args.agent) {
      if (args.profileName && !profile) throw new Error(`Profile ${args.profileName} was not found.`);
      const inspection = await inspectSelected(provider, agent);
      configSnapshot = createConfigSnapshot(inspection);
      if (args.action === 'run') await acknowledgeTarget(args, agent, inspection, profile, input);
    }
    const scenarios = await import('./lib/scenarios.mjs');
    const result = await scenarios.handleScenarios({ ...args, scenarioPath: args.scenarioPath, agentId: agent?.id }, {
      provider, createJournal, dataDir, configSnapshot, profile,
    });
    if (output === 'human') process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else print(result, output);
    return result;
  }
  throw new Error('Use `scenario list` or `scenario run --scenario FILE --agent ID`.');
}

async function unsupportedResume(args, provider, dataDir, output, reason, readbackStatus = 'not_attempted') {
  const journal = createJournal({ dataDir, header: { kind: 'resume_preflight', chatId: args.chatId } });
  journal.append('resume_unsupported', { requestedInput: args.messages[0], readbackStatus, providerResumeContract: 'unverified', replayAttempted: false, reason });
  journal.finalize('unsupported', { reason });
  const error = new Error(reason);
  error.kind = 'unsupported';
  if (output === 'human') humanError(error);
  else print(errorEnvelope(error, { chatId: args.chatId, journalPath: journal.filePath, replayAttempted: false }), output);
  process.exitCode = 2;
}

async function resumeExistingChat(args, provider, dataDir, input, output) {
  const localSession = loadSession(dataDir, args.chatId);
  let readback;
  try { readback = await provider.readChat(args.chatId); }
  catch (error) {
    if (!localSession) return unsupportedResume(args, provider, dataDir, output, `Saved chat could not be read back; no message was submitted. ${error.message}`);
    throw error;
  }
  if (!localSession) return unsupportedResume(args, provider, dataDir, output,
    `Saved chat ${args.chatId} is readable, but it has no local session association. Create a session locally before sending later turns. No message was submitted.`, readback.status);
  if (!args.agent) throw new Error('send requires --agent ID so the locally associated target can be checked.');
  const agent = await selectAgent(args, provider, input);
  if (agent.id !== localSession.agentId) throw new Error(`Chat session is locally associated with agent ${localSession.agentId}; refusing to send using ${agent.id}.`);
  if (readback.data?.id !== args.chatId) throw new Error('Provider readback did not return the requested chat ID; no message was submitted.');
  const inspection = await inspectSelected(provider, agent);
  const snapshot = createConfigSnapshot(inspection);
  if (localSession.configurationHash && snapshot.configurationHash !== localSession.configurationHash) {
    const error = new Error('The agent configuration differs from the local session snapshot; refusing to continue the chat.');
    error.kind = 'configuration_drift';
    throw error;
  }
  const profile = args.profileName ? getProfile(dataDir, args.profileName) : null;
  if (args.profileName && !profile) throw new Error(`Profile ${args.profileName} was not found.`);
  checkDefaultGuard(snapshot, args.expectedDefault, profile);
  await acknowledgeTarget(args, agent, inspection, profile, input);
  args.callAgentInput = localSession.callAgentInput || {};
  return runTurns({ args, provider, agent, inspection, snapshot, chat: { id: args.chatId }, dataDir, profile, input, output,
    sessionMode: 'resumed', previousSession: localSession });
}

async function dispatch(args, provider, dataDir, input, output) {
  if (args.help) { process.stdout.write(`${usage()}\n`); return; }
  if (args.command === 'profile') return handleProfile(args, dataDir, output);
  if (args.command === 'config') return handleConfig(args, provider, dataDir, input, output);
  if (['doctor', 'trace', 'diagnose-tools', 'control-preflight'].includes(args.command)) return handleDiagnostic(args, provider, dataDir, output);
  if (args.command === 'scenario' || args.command === 'suite') return handleScenario(args, provider, dataDir, input, output);
  if (args.command === 'dial') return handleDialExport(args, provider, output);
  if (args.command === 'get' || args.command === 'export') return handleReadback(args, provider, output);
  if (args.command === 'send') return resumeExistingChat(args, provider, dataDir, input, output);
  if (args.list) {
    const agents = await provider.listAgents();
    const phones = await getPhoneResult(provider);
    const rows = agents.map(agent => {
      const inspectionLike = { agent, functions: [] };
      return { id: agent.id, name: agent.name, phoneLinkage: phones.status === 'available' ? 'listed; typed per-agent inspection required' : 'unknown' };
    });
    if (output === 'human') rows.forEach((item, i) => process.stdout.write(`${i + 1}. ${item.name} (${item.id}) — phone linkage ${item.phoneLinkage}\n`));
    else print({ schema: 'vogent-agent-list.v1', agents: rows }, output);
    return;
  }
  if (args.inspect) {
    const agent = await selectAgent(args, provider, input);
    const inspection = await inspectSelected(provider, agent);
    const snapshot = createConfigSnapshot(inspection);
    const value = {
      schema: 'vogent-agent-inspection.v1',
      status: 'available',
      agent: snapshot.agent,
      classification: inspection.classification,
      phoneLinkage: snapshot.phoneLinkage,
      prompt: snapshot.prompt,
      functions: snapshot.functions,
      configurationSnapshot: snapshot,
      provenance: inspection.provenance,
    };
    if (output === 'human') {
      process.stdout.write(`Agent: ${agent.name} (${agent.id})\n`);
      process.stdout.write(`Active prompt: ${inspection.agent.defaultVersionedPromptId || 'none'}; type: ${inspection.prompt?.agentType || 'unknown'}; flow nodes: ${inspection.prompt?.flowDefinition?.nodes?.length ?? 'unknown'}\n`);
      process.stdout.write(`Phone linkage: ${inspection.phoneLinkage.status}${inspection.phoneLinkage.reason ? ` (${inspection.phoneLinkage.reason})` : ''}\n`);
      for (const fn of inspection.functions) process.stdout.write(`Function: ${fn.name} (${fn.id}) -> ${functionTarget(fn).host || 'unknown'}${functionTarget(fn).path || ''}\n`);
      process.stdout.write(`Classification: ${inspection.classification}\nConfiguration hash: ${snapshot.configurationHash}\n`);
    } else print(value, output);
    return value;
  }
  if (args.command === 'start' || args.command === 'chat') return createAndRun(args, provider, dataDir, input, output);
  if (args.command !== 'chat') throw new Error(`Unsupported command ${args.command}.`);
  throw new Error('No command or message was provided.');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try { args = parseArgs(argv); }
  catch (error) { error.kind = 'argument_error'; throw error; }
  const dataDir = args.dataDir ? resolve(args.dataDir) : defaultDataDir(env);
  const credential = getCredential({ env, envFile: args.envFile, repoRoot: REPO_ROOT });
  const provider = createProvider({ token: credential.token, apiBase: args.apiBase || env.VOGENT_API_BASE_URL, wsUrl: args.wsUrl || env.VOGENT_WS_URL,
    timeoutMs: Number(env.VOGENT_CHAT_TIMEOUT_MS) || 45_000 });
  const input = process.stdin.isTTY && !args.messages.length ? (await import('node:readline/promises')).createInterface({ input: process.stdin, output: process.stdout }) : null;
  try { return await dispatch(args, provider, dataDir, input, args.output); }
  finally { input?.close(); }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) main().catch(error => {
  const output = (() => {
    const argv = process.argv.slice(2);
    if (argv.includes('--json')) return 'json';
    if (argv.includes('--jsonl')) return 'jsonl';
    const outputAt = argv.indexOf('--output');
    if (outputAt >= 0 && argv[outputAt + 1]) return argv[outputAt + 1];
    try { return parseArgs(argv).output; } catch { return 'human'; }
  })();
  if (output === 'human') humanError(error);
  else print(errorEnvelope(error), output);
  if (!process.exitCode) process.exitCode = error.kind === 'unsupported' ? 2 : 1;
});
