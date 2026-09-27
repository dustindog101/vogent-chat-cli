const SECRET_KEY = /(?:authorization|api.?key|token|secret|password|cookie|credential|private.?key|headers?)/i;
const INPUT_REFERENCE = /\{\{\s*(?:input|callAgentInput)\.([A-Za-z0-9_-]+)\s*\}\}/g;

function unwrap(value) {
  return value?.data ?? value;
}

function own(object, key) {
  return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
}

function parseObject(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function nodeData(node) {
  return node?.nodeData ?? node?.data ?? node ?? {};
}

function flowDefinition(prompt) {
  return prompt?.flowDefinition ?? prompt?.data?.flowDefinition ?? null;
}

function functionNodes(prompt) {
  const nodes = flowDefinition(prompt)?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.filter(node => String(node?.type ?? nodeData(node)?.type ?? '').toLowerCase() === 'function');
}

function functionNodeId(node) {
  const data = nodeData(node);
  return data.functionId ?? data.functionDefinitionId ?? node.functionId ?? node.functionDefinitionId ?? null;
}

function functionId(fn) {
  return fn?.id ?? fn?.functionDefinitionId ?? fn?.functionId ?? null;
}

function functionName(fn) {
  return fn?.name ?? fn?.displayName ?? fn?.slug ?? null;
}

function functionType(fn) {
  return String(fn?.type ?? fn?.functionType ?? 'unknown').toLowerCase();
}

function rawEndpoint(fn) {
  const candidate = fn?.apiPath ?? fn?.url ?? fn?.endpoint ?? fn?.apiUrl;
  if (typeof candidate !== 'string') return null;
  try {
    const url = new URL(candidate);
    return { host: url.hostname.toLowerCase(), path: url.pathname || '/' };
  } catch {
    return null;
  }
}

function redactPath(path) {
  const segments = path.split('/');
  let redactNext = false;
  return segments.map(segment => {
    if (redactNext) {
      redactNext = false;
      return '[redacted]';
    }
    if (/^(?:token|api[-_]?key|auth|secret|password|credential)$/i.test(segment)) {
      redactNext = true;
      return segment;
    }
    if (/^(?:[A-Fa-f0-9]{32,}|[A-Fa-f0-9-]{36}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.test(segment)) {
      return '[redacted]';
    }
    return segment;
  }).join('/');
}

function safeEndpoint(fn) {
  const endpoint = rawEndpoint(fn);
  return endpoint ? { ...endpoint, path: redactPath(endpoint.path) } : null;
}

function schemaRequiredNames(fn) {
  const names = new Set();
  for (const key of ['inputSchema', 'parameters', 'requestSchema', 'requestBodySchema', 'functionSchema']) {
    const schema = parseObject(fn?.[key]);
    if (Array.isArray(schema?.required)) {
      for (const name of schema.required) {
        if (typeof name === 'string') names.add(SECRET_KEY.test(name) ? '[redacted-field]' : name);
      }
    }
  }
  return [...names].sort();
}

function summarizeFunction(fn) {
  const endpoint = safeEndpoint(fn);
  return {
    id: functionId(fn),
    name: functionName(fn),
    type: functionType(fn),
    endpoint,
    requiredInputs: schemaRequiredNames(fn),
  };
}

function nodeInputSummary(node) {
  const inputs = nodeData(node)?.inputs;
  if (!Array.isArray(inputs)) return [];
  return inputs.filter(input => typeof input?.name === 'string').map(input => {
    const value = input?.value;
    return {
      name: SECRET_KEY.test(input.name) ? '[redacted-field]' : input.name,
      source: typeof value === 'string' && value.trim() === '' ? 'empty' :
        typeof value === 'string' && value.includes('{{') ? 'template' :
          value === undefined || value === null ? 'unset' : 'literal',
    };
  });
}

function referencedCallInputs(nodes) {
  const names = new Set();
  for (const node of nodes) {
    for (const input of nodeData(node)?.inputs ?? []) {
      if (typeof input?.value !== 'string') continue;
      for (const match of input.value.matchAll(INPUT_REFERENCE)) names.add(SECRET_KEY.test(match[1]) ? '[redacted-field]' : match[1]);
    }
  }
  return [...names].sort();
}

function phoneStatus(inspection) {
  const linkage = inspection?.phoneLinkage;
  if (typeof linkage === 'string') return linkage;
  return typeof linkage?.status === 'string' ? linkage.status : 'unknown';
}

function inspectionParts(raw) {
  const inspection = unwrap(raw) ?? {};
  const agent = inspection.agent ?? inspection;
  const prompt = inspection.prompt ?? null;
  const functions = Array.isArray(inspection.functions) ? inspection.functions.map(unwrap) : [];
  return { inspection, agent, prompt, functions };
}

/**
 * Summarize configuration evidence without returning function schemas, headers,
 * literal values, or transcript content. An absent call is never treated as proof
 * that the provider cannot execute a function.
 */
export function summarizeFunctionCompatibility(rawInspection, { callAgentInput = {}, expectedFunction = null } = {}) {
  const { inspection, agent, prompt, functions } = inspectionParts(rawInspection);
  const nodes = functionNodes(prompt);
  const linked = functions.map(summarizeFunction);
  const linkedById = new Map(linked.filter(fn => fn.id).map(fn => [fn.id, fn]));
  const nodeIds = new Set(nodes.map(functionNodeId).filter(Boolean));
  const declarations = nodes.map(node => {
    const id = functionNodeId(node);
    const definition = id ? linkedById.get(id) : null;
    return {
      nodeId: node?.id ?? null,
      functionId: id,
      linked: Boolean(definition),
      functionName: definition?.name ?? null,
      inputMappings: nodeInputSummary(node),
    };
  });
  const referencedInputs = referencedCallInputs(nodes);
  const suppliedInputs = Object.keys(parseObject(callAgentInput) ?? {})
    .map(name => SECRET_KEY.test(name) ? '[redacted-field]' : name).sort();
  const suppliedSet = new Set(suppliedInputs);
  const missingCallInputs = referencedInputs.filter(name => !suppliedSet.has(name));
  const findings = [];
  if (!prompt) findings.push('active-prompt-unavailable');
  for (const declaration of declarations) {
    if (declaration.functionId && !declaration.linked) findings.push(`flow-function-not-linked:${declaration.functionId}`);
  }
  for (const fn of linked) {
    if (fn.id && !nodeIds.has(fn.id)) findings.push(`linked-function-not-declared-in-flow:${fn.id}`);
  }
  if (missingCallInputs.length) findings.push('call-input-references-not-supplied');
  let expected = null;
  if (expectedFunction) {
    const matched = linked.find(fn => fn.id === expectedFunction || fn.name === expectedFunction);
    expected = {
      requested: expectedFunction,
      linked: Boolean(matched),
      declaredInFlow: Boolean(matched?.id && nodeIds.has(matched.id)),
    };
    if (!matched) findings.push('expected-function-not-linked');
    else if (!expected.declaredInFlow) findings.push('expected-function-not-declared-in-flow');
  }
  const hasConfigurationEvidence = linked.length > 0 || declarations.length > 0;
  const hasMismatch = findings.some(item => item.startsWith('flow-function-not-linked:') ||
    item.startsWith('linked-function-not-declared-in-flow:') || item.startsWith('expected-function-not-'));
  const configurationStatus = hasMismatch ? 'configuration-mismatch' :
    !prompt ? 'unknown' : hasConfigurationEvidence ? 'configuration-present' : 'unknown';

  return {
    kind: 'function-compatibility',
    target: {
      agentId: agent?.id ?? null,
      agentName: agent?.name ?? null,
      agentType: prompt?.agentType ?? agent?.agentType ?? 'unknown',
      promptId: agent?.defaultVersionedPromptId ?? prompt?.id ?? null,
      phoneLinkage: phoneStatus(inspection),
    },
    configuration: {
      status: configurationStatus,
      linkedFunctions: linked,
      flowFunctionNodes: declarations,
      referencedCallInputs: referencedInputs,
      suppliedCallInputNames: suppliedInputs,
      missingCallInputs,
      expectedFunction: expected,
      findings,
    },
    runtime: {
      textChatFunctionSupport: 'unconfirmed-by-configuration-readback',
      backendInvocation: 'not-tested',
      explanation: 'Configuration readback can expose missing links or inputs; it cannot prove text-chat runtime support or endpoint receipt.',
    },
    control: {
      status: 'not-run',
      reason: 'A control requires a profile-authorized isolated target and a declared harmless function endpoint.',
    },
    provenance: inspection.provenance ?? 'agent/prompt/function readback',
  };
}

function transcriptOf(rawChat) {
  const body = unwrap(rawChat) ?? {};
  if (Array.isArray(body?.data?.transcript)) return { body: body.data, transcript: body.data.transcript };
  if (Array.isArray(body?.transcript)) return { body, transcript: body.transcript };
  if (Array.isArray(body?.chat?.transcript)) return { body: body.chat, transcript: body.chat.transcript };
  return { body, transcript: [] };
}

function callsIn(line) {
  const calls = line?.functionCalls ?? line?.functionCall;
  if (Array.isArray(calls)) return calls;
  return calls && typeof calls === 'object' ? [calls] : [];
}

function transitionIn(line) {
  const transition = line?.nodeTransitionResult;
  if (Array.isArray(transition)) return transition;
  return transition && typeof transition === 'object' ? [transition] : [];
}

function argumentKeys(call) {
  const args = parseObject(call?.arguments);
  if (args) return Object.keys(args).map(key => SECRET_KEY.test(key) ? '[redacted-field]' : key).sort();
  if (typeof call?.arguments === 'string' && call.arguments.trim()) return ['<non-object-arguments-redacted>'];
  return [];
}

function summarizeCall(call) {
  return {
    id: call?.id ?? null,
    name: call?.name ?? null,
    argumentNames: argumentKeys(call),
    argumentValues: 'redacted',
    category: String(call?.name ?? '').toLowerCase() === 'commit_answer' ? 'internal-answer-commit' : 'other-transcript-function-call',
  };
}

function summarizeTransition(transition) {
  const result = transition?.result;
  const resultObject = parseObject(result);
  return {
    fromNodeId: transition?.fromNodeId ?? null,
    toNodeId: transition?.toNodeId ?? null,
    resultPresent: result !== undefined && result !== null,
    resultFieldNames: resultObject ? Object.keys(resultObject).sort() : [],
    resultValues: 'redacted',
  };
}

/**
 * Report the selected chat fields and their actual population. This intentionally
 * separates provider transcript calls, backend receipts, and inferred sequences.
 */
export function summarizeTraceCapability(rawChat, { correlationEvidence = null } = {}) {
  const { body, transcript } = transcriptOf(rawChat);
  const calls = transcript.flatMap(callsIn);
  const transitions = transcript.flatMap(transitionIn);
  const capabilities = body?.capabilities ?? rawChat?.capabilities ?? {};
  const requested = field => capabilities[field] === 'requested' || capabilities[field] === true;
  const chatId = body?.id ?? body?.chatId ?? rawChat?.id ?? null;
  const callSummaries = calls.map(summarizeCall);
  const internalCount = callSummaries.filter(call => call.category === 'internal-answer-commit').length;
  const otherCalls = callSummaries.length - internalCount;
  const correlation = summarizeCorrelation(correlationEvidence, chatId, calls);
  const functionFieldRequested = requested('functionCalls') || transcript.some(line => own(line, 'functionCalls'));
  const transitionFieldRequested = requested('nodeTransitionResult') || transcript.some(line => own(line, 'nodeTransitionResult'));

  return {
    kind: 'trace-capability',
    chatId,
    status: transitions.length > 0 || otherCalls > 0 ? 'partial-trace-observed' : 'partial-trace-fields-available-population-limited',
    nativeProviderTrace: {
      source: body?.provenance ?? rawChat?.provenance ?? 'aiChat transcript readback',
      functionCalls: {
        queryStatus: functionFieldRequested ? 'requested-or-returned' : 'unknown',
        populatedCount: calls.length,
        internalCommitAnswerCount: internalCount,
        otherTranscriptFunctionCallCount: otherCalls,
        records: callSummaries,
      },
      nodeTransitionResult: {
        queryStatus: transitionFieldRequested ? 'requested-or-returned' : 'unknown',
        populatedCount: transitions.length,
        records: transitions.map(summarizeTransition),
        emptyMeaning: transitions.length ? null : 'No populated node-transition records were returned for this chat; this does not establish that no flow nodes executed.',
      },
      functionResults: 'unavailable-in-observed-chat-schema',
      completeness: 'partial; full voice-style Flow Builder trace is not established',
    },
    backendEvidence: {
      status: correlation.status === 'matched-identifiers-reported' ? 'reported-correlated-records' : 'not-proven-by-chat-transcript',
      correlation,
      endpointReceipt: 'not-proven-by-provider-chat-record',
    },
    inferredSequence: {
      status: 'not-produced',
      reason: 'No sequence is inferred from timestamps or from transcript call records alone.',
    },
    provenance: body?.provenance ?? rawChat?.provenance ?? 'aiChat GraphQL readback',
  };
}

function summarizeCorrelation(evidence, chatId, calls) {
  if (!evidence) return { status: 'not-provided', timestampOnly: false, matchedIdentifiers: [] };
  const rows = Array.isArray(evidence) ? evidence : [evidence];
  const callIds = new Set(calls.map(call => call?.id).filter(Boolean));
  const matchedIdentifiers = [];
  let hasTimestamp = false;
  let hasJoinIdentifier = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.timestamp || row.createdAt || row.occurredAt) hasTimestamp = true;
    if (row.chatId || row.aiChatId || row.functionCallId || row.callId) hasJoinIdentifier = true;
    if (chatId && [row.chatId, row.aiChatId].includes(chatId)) matchedIdentifiers.push('chatId');
    if (row.functionCallId && callIds.has(row.functionCallId)) matchedIdentifiers.push('functionCallId');
  }
  const matches = [...new Set(matchedIdentifiers)];
  if (matches.length) return { status: 'matched-identifiers-reported', timestampOnly: false, matchedIdentifiers: matches };
  if (hasTimestamp && !hasJoinIdentifier) return { status: 'timestamp-only-insufficient', timestampOnly: true, matchedIdentifiers: [] };
  return { status: 'no-exact-identifier-match', timestampOnly: false, matchedIdentifiers: [] };
}

function targetHostPath(value) {
  if (typeof value === 'string') {
    const parsed = safeEndpoint({ apiPath: value });
    return parsed;
  }
  if (!value || typeof value !== 'object') return null;
  const host = typeof value.host === 'string' ? value.host.toLowerCase() : null;
  const pathPrefix = typeof value.pathPrefix === 'string' ? value.pathPrefix : null;
  return host ? { host, pathPrefix } : null;
}

/**
 * Check whether an explicitly named agent/function is allowed as a harmless
 * control. This is a read-only gate: it never creates a chat or sends a turn.
 */
export function prepareHarmlessControl({ rawInspection, authorization, message, callAgentInput = {} }) {
  const { inspection, agent, prompt, functions } = inspectionParts(rawInspection);
  const nodes = functionNodes(prompt);
  const targetId = agent?.id ?? null;
  const promptId = agent?.defaultVersionedPromptId ?? prompt?.id ?? null;
  const phone = phoneStatus(inspection);
  const profile = authorization ?? {};
  const harmless = profile.harmlessControl ?? {};
  const allowedTargets = (harmless.allowedTargets ?? []).map(targetHostPath).filter(Boolean);
  const allowedFunctionIds = new Set((harmless.functionIds ?? []).filter(x => typeof x === 'string'));
  const linkedById = new Map(functions.map(fn => [functionId(fn), fn]).filter(([id]) => id));
  const referencedInputs = referencedCallInputs(nodes);
  const suppliedInputs = new Set(Object.keys(parseObject(callAgentInput) ?? {}).map(name =>
    SECRET_KEY.test(name) ? '[redacted-field]' : name));
  const missingInputs = referencedInputs.filter(name => !suppliedInputs.has(name));
  const findings = [];
  const hasExactProfile = Boolean(profile.agentId === targetId &&
    harmless.expectedPromptId && allowedFunctionIds.size && allowedTargets.length);
  if (!hasExactProfile) findings.push('profile-does-not-authorize-this-exact-agent-for-control');
  if (phone !== 'unlinked') findings.push('typed-phone-linkage-is-not-confirmed-unlinked');
  if (!promptId || !harmless.expectedPromptId || promptId !== harmless.expectedPromptId) findings.push('active-prompt-does-not-match-profile-control-prompt');
  if (typeof message !== 'string' || !message.trim()) findings.push('exact-nonempty-control-message-required');
  if (missingInputs.length) findings.push('call-inputs-required-for-control-missing');

  const controlFunctions = [];
  for (const id of allowedFunctionIds) {
    const fn = linkedById.get(id);
    if (!fn || !nodes.some(node => functionNodeId(node) === id)) {
      findings.push(`profile-control-function-not-linked-and-declared:${id}`);
      continue;
    }
    const endpoint = rawEndpoint(fn);
    const targetAllowed = endpoint && allowedTargets.some(target => target.host === endpoint.host &&
      pathPrefixMatches(endpoint.path, target.pathPrefix || '/'));
    if (!targetAllowed || functionType(fn) !== 'api') {
      findings.push(`control-function-endpoint-outside-profile-allowlist:${id}`);
      continue;
    }
    controlFunctions.push({ id, name: functionName(fn), endpoint: safeEndpoint(fn) });
  }
  if (!allowedFunctionIds.size) findings.push('profile-has-no-explicit-harmless-control-function');
  const ready = findings.length === 0 && controlFunctions.length > 0;
  return {
    kind: 'control-preflight',
    status: ready ? 'preflight-passed' : 'not-authorized',
    target: { agentId: targetId, promptId, phoneLinkage: phone, profile: profile.name ?? null },
    functionTargets: controlFunctions,
    message: typeof message === 'string' ? { present: Boolean(message.trim()), characterCount: message.trim().length } : { present: false },
    callAgentInputNames: Object.keys(parseObject(callAgentInput) ?? {})
      .map(name => SECRET_KEY.test(name) ? '[redacted-field]' : name).sort(),
    missingCallAgentInputNames: missingInputs,
    findings,
    execution: 'not-run',
    action: 'preflight-only-no-chat-created-or-message-sent',
  };
}

/** Dispatch diagnostics using only provider read operations. */
export async function handleDiagnostics(command, args = {}, context = {}) {
  const provider = context.provider;
  if (!provider) throw new Error('Diagnostics require an initialized Vogent provider.');
  if (command === 'doctor') {
    let agents = null;
    let agentError = null;
    try { agents = await provider.listAgents(); }
    catch (error) { agentError = error; }
    let phones = null;
    let phoneError = null;
    if (agents) {
      try { phones = await provider.listPhones(); }
      catch (error) { phoneError = error; }
    }
    const credentialStatus = agents ? 'accepted-for-read-only-agent-list' :
      agentError?.kind === 'missing_credential' ? 'missing' :
        ['http_error', 'unauthorized'].includes(agentError?.kind) || [401, 403].includes(agentError?.status) ? 'rejected' : 'unknown';
    return {
      kind: 'doctor',
      runtime: {
        nodeVersion: process.version,
        fetch: typeof globalThis.fetch === 'function' ? 'available' : 'unavailable',
        webSocket: typeof globalThis.WebSocket === 'function' ? 'available' : 'unavailable',
      },
      credential: { status: credentialStatus, value: 'never displayed' },
      api: {
        agentList: agents ? 'available' : 'unavailable',
        agentCount: agents?.length ?? null,
        phoneList: phones ? 'available' : phoneError ? 'denied-or-unavailable' : agents ? 'not-attempted' : 'not-attempted',
        phoneCount: phones?.length ?? null,
        agentErrorKind: agentError?.kind ?? null,
        phoneErrorKind: phoneError?.kind ?? null,
        effects: 'read-only GET requests; no chat created',
      },
    };
  }
  if (command === 'trace') {
    if (!args.chatId) throw new Error('trace requires --chat-id.');
    const chat = await provider.readChat({ chatId: args.chatId });
    return summarizeTraceCapability(chat, { correlationEvidence: args.correlationEvidence ?? null });
  }
  if (!['diagnose-tools', 'control-preflight'].includes(command)) {
    throw new Error(`Unknown diagnostics command: ${command}`);
  }
  const agentId = args.agentId ?? args.agent;
  if (!agentId) throw new Error(`${command} requires --agent ID.`);
  const inspection = await provider.inspectAgent(agentId);
  if (command === 'control-preflight') {
    const profileName = args.profile ?? context.profileName ?? null;
    const profile = context.profile ?? context.profiles?.[profileName] ?? null;
    const authorization = profile ? { ...profile, name: profileName ?? profile.name } : null;
    return prepareHarmlessControl({
      rawInspection: inspection,
      authorization,
      message: args.message ?? (args.messages?.length === 1 ? args.messages[0] : undefined),
      callAgentInput: args.callAgentInput,
    });
  }
  const report = summarizeFunctionCompatibility(inspection, {
    callAgentInput: args.callAgentInput,
    expectedFunction: args.expectedFunction ?? null,
  });
  if (args.chatId) {
    const chat = await provider.readChat({ chatId: args.chatId });
    report.observedChat = summarizeTraceCapability(chat, { correlationEvidence: args.correlationEvidence ?? null });
    const traceCalls = report.observedChat.nativeProviderTrace.functionCalls;
    report.control.status = traceCalls.otherTranscriptFunctionCallCount > 0 ? 'non-internal-call-observed-control-not-run' : 'not-run';
    report.control.reason = 'A saved chat can provide context but is not a harmless control; no new chat or turn was created.';
  }
  return report;
}
import { pathPrefixMatches } from './targets.mjs';
