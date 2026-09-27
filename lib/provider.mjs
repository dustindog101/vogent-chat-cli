import { readFileSync } from 'node:fs';
import { pathPrefixMatches } from './targets.mjs';

const DEFAULT_API = 'https://api.vogent.ai';
const DEFAULT_WS = 'wss://api.vogent.ai/query';

export const CHAT_READ_QUERY = `query ReadAiChat($id: ID!) {
  aiChat(id: $id) {
    id
    transcript {
      role
      text
      functionCalls { id name arguments }
      nodeTransitionResult { fromNodeId toNodeId result }
    }
  }
}`;

const CHAT_QUERY = `subscription RunChatMessage($input: RunChatQueryInput!) {
  runChatQueryStream(input: $input) {
    messageType
    text
    transcriptLine {
      role
      text
      functionCalls { id name arguments }
      nodeTransitionResult { fromNodeId toNodeId result }
    }
  }
}`;

export class ProviderError extends Error {
  constructor(message, { kind = 'provider_error', status, details } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.details = details;
  }
}

export function getCredential({ env = process.env, envFile, repoRoot } = {}) {
  const fromEnvironment = env.VOGENT_API_KEY;
  if (fromEnvironment) return { token: fromEnvironment, source: 'VOGENT_API_KEY environment variable' };
  const candidate = envFile || (repoRoot ? `${repoRoot}/.env.local` : null);
  if (candidate) {
    try {
      const line = requireEnvSync(candidate);
      if (line) return { token: line, source: envFile ? `env file ${envFile}` : 'repository .env.local' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { token: null, source: 'missing' };
}

function requireEnvSync(path) {
  // Avoid importing a package for a two-line dotenv format. Values are never logged.
  const source = readFileSync(path, 'utf8');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?VOGENT_API_KEY\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[1];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value || null;
  }
  return null;
}

function tokenRequired(token) {
  if (!token) throw new ProviderError('Set VOGENT_API_KEY or provide an env file with that variable.', { kind: 'missing_credential' });
}

function safeErrorDetail(value) {
  const detail = typeof value === 'string' ? value : JSON.stringify(value) || String(value);
  return detail.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 1000);
}

export function stablePhoneLinkage(agentId, phones, listingStatus = 'available') {
  if (listingStatus !== 'available' || !Array.isArray(phones)) {
    return { status: 'unknown', evidence: [], reason: listingStatus === 'denied' ? 'phone listing access denied' : 'phone linkage was not readable' };
  }
  const fields = ['agentId', 'linkedAgentId', 'assignedAgentId'];
  const evidence = [];
  let typedFieldSeen = false;
  for (const phone of phones) {
    if (!phone || typeof phone !== 'object') continue;
    for (const field of fields) {
      if (!Object.hasOwn(phone, field)) continue;
      typedFieldSeen = true;
      if (phone[field] === agentId) {
        evidence.push({ phoneId: phone.id ?? null, phoneNumber: phone.phoneNumber ?? phone.number ?? null, field, agentId: phone[field] });
      }
    }
    if (phone.agent && typeof phone.agent === 'object' && Object.hasOwn(phone.agent, 'id')) {
      typedFieldSeen = true;
      if (phone.agent.id === agentId) evidence.push({ phoneId: phone.id ?? null, phoneNumber: phone.phoneNumber ?? phone.number ?? null, field: 'agent.id', agentId: phone.agent.id });
    }
  }
  if (evidence.length) return { status: 'linked', evidence };
  if (phones.length === 0) return { status: 'unlinked', evidence: [], reason: 'complete phone listing contains no numbers' };
  if (!typedFieldSeen) return { status: 'unknown', evidence: [], reason: 'phone records contain no recognized typed agent-link field' };
  return { status: 'unlinked', evidence: [], reason: 'complete typed phone listing contains no link to this agent' };
}

export function functionTarget(fn) {
  if (fn?.type !== 'api') return fn?.type || 'unknown';
  try {
    const url = new URL(fn.apiPath);
    return { host: url.host, path: url.pathname };
  } catch {
    return { host: null, path: null, status: 'invalid_or_missing_url' };
  }
}

function collectTrace(events, selector) {
  const records = [];
  const seen = new Set();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const record = selector(events[eventIndex]);
    const values = Array.isArray(record) ? record : record == null ? [] : [record];
    for (const value of values) {
      const signature = value?.id || JSON.stringify(value);
      if (seen.has(signature)) continue;
      seen.add(signature);
      records.push({ ...value, provenance: 'runChatQueryStream transcriptLine', eventIndex });
    }
  }
  return records;
}

function reduceText(events) {
  let transcript = '';
  let hasTranscript = false;
  let chunks = '';
  let activeSpeaker = false;
  for (const event of events) {
    const line = event.transcriptLine;
    if (line && ['AI', 'assistant'].includes(line.role) && typeof line.text === 'string') {
      hasTranscript = true;
      const next = line.text;
      if (!transcript || next.startsWith(transcript)) transcript = next;
      else if (!transcript.startsWith(next) && !transcript.endsWith(next)) transcript += next;
    }
    if (event.messageType === 'NEW_SPEAKER_RES') {
      activeSpeaker = true;
      if (!hasTranscript && typeof event.text === 'string') chunks = reconcileChunk(chunks, event.text);
    } else if (event.messageType === 'APPEND_TEXT' && typeof event.text === 'string') {
      if (!hasTranscript || !line) chunks = reconcileChunk(chunks, event.text);
      activeSpeaker = true;
    }
  }
  return { text: hasTranscript ? transcript : chunks, source: hasTranscript ? 'transcriptLine.text' : (activeSpeaker ? 'stream text events' : 'none') };
}

function reconcileChunk(current, next) {
  if (!next) return current;
  if (!current || next.startsWith(current)) return next;
  if (current.startsWith(next) || current.endsWith(next)) return current;
  return current + next;
}

function typedTurnError(message, kind, events, onEvent) {
  return new ProviderError(message, { kind, details: { events, onEvent } });
}

export function createProvider({ token, apiBase = process.env.VOGENT_API_BASE_URL || DEFAULT_API, wsUrl = process.env.VOGENT_WS_URL || DEFAULT_WS, timeoutMs = 45_000 } = {}) {
  const request = async (path, init = {}) => {
    tokenRequired(token);
    const response = await fetch(new URL(path, apiBase), {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
      signal: init.signal || AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ProviderError(`${path} returned HTTP ${response.status}.`, { kind: 'http_error', status: response.status });
    let body;
    try { body = await response.json(); }
    catch { throw new ProviderError(`${path} returned malformed JSON.`, { kind: 'malformed_http_json' }); }
    if (body.errors?.length) throw new ProviderError(`Vogent GraphQL error: ${safeErrorDetail(body.errors)}`, { kind: 'graphql_error', details: body.errors });
    return body;
  };

  const graphql = async (query, variables) => request('/query', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }),
  });

  const getPages = async path => {
    let cursor;
    const items = [];
    const seen = new Set();
    do {
      const url = new URL(path, apiBase);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await request(`${url.pathname}${url.search}`);
      if (!Array.isArray(response.data)) throw new ProviderError(`${path} returned an unexpected response.`, { kind: 'schema_mismatch' });
      items.push(...response.data);
      cursor = response.cursor;
      if (cursor) {
        if (seen.has(cursor)) throw new ProviderError(`${path} repeated a pagination cursor.`, { kind: 'pagination_error' });
        seen.add(cursor);
      }
    } while (cursor);
    return items;
  };

  const inspectAgent = async (agentOrId, phonesResult = null) => {
    let agent = agentOrId;
    if (typeof agentOrId === 'string') {
      const agents = await getPages('/api/agents');
      agent = agents.find(item => item.id === agentOrId);
      if (!agent) throw new ProviderError(`Agent ${agentOrId} was not found.`, { kind: 'not_found' });
    }
    if (!phonesResult) {
      try { phonesResult = { status: 'available', data: await getPages('/api/phone_numbers') }; }
      catch { phonesResult = { status: 'denied', data: [] }; }
    }
    const linked = Array.isArray(agent?.linkedFunctionDefinitions) ? agent.linkedFunctionDefinitions : [];
    const functions = await Promise.all(linked.map(async link => {
      const body = await request(`/api/functions/${encodeURIComponent(link.functionDefinitionId)}`);
      return body.data || body;
    }));
    const promptId = agent?.defaultVersionedPromptId || null;
    let prompt = null;
    if (promptId) {
      const body = await request(`/api/agents/${encodeURIComponent(agent.id)}/versioned_prompts/${encodeURIComponent(promptId)}`);
      prompt = body.data || body;
    }
    const phoneLinkage = stablePhoneLinkage(agent.id, phonesResult.data, phonesResult.status);
    return {
      classification: 'target_requires_explicit_acknowledgment',
      agent,
      prompt,
      functions,
      phoneLinkage,
      provenance: { agent: 'GET /api/agents', prompt: promptId ? 'GET /api/agents/{id}/versioned_prompts/{promptId}' : 'no default prompt ID', functions: 'GET /api/functions/{id}', phoneLinkage: phonesResult.status === 'available' ? 'GET /api/phone_numbers typed relationship fields' : phonesResult.status },
    };
  };

  const createChat = async ({ agentId, callAgentInput = {} }) => {
    const body = await graphql('mutation CreateChat($input: CreateChatInput!) { createAiChat(input: $input) { id } }', {
      input: { agentId, callAgentInput },
    });
    const id = body.data?.createAiChat?.id;
    if (!id) throw new ProviderError('Vogent did not return a chat ID.', { kind: 'schema_mismatch' });
    return { id, providerProvenance: 'createAiChat response', agentIdObservedFromRequest: agentId, versionPinSupported: false };
  };

  const runChatTurn = ({ chatId, text, signal, onEvent = () => {} }) => new Promise((resolve, reject) => {
    tokenRequired(token);
    const WebSocketImpl = globalThis.WebSocket;
    if (!WebSocketImpl) return reject(new ProviderError('This Node.js runtime does not provide WebSocket.', { kind: 'unsupported_runtime' }));
    const ws = new WebSocketImpl(wsUrl, ['graphql-transport-ws']);
    const events = [];
    let finished = false;
    let submitted = false;
    const timer = setTimeout(() => finish(new ProviderError('Vogent chat turn timed out after submission; backend effects are unknown.', { kind: 'timeout' })), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { ws.close(); } catch {}
    };
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) {
        error.details = { ...(error.details || {}), submitted, events };
        reject(error);
      } else resolve(value);
    };
    const abort = () => finish(new ProviderError('Chat turn was interrupted after submission; backend effects are unknown.', { kind: 'interrupted' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();

    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'connection_init', payload: { authToken: token } })));
    ws.addEventListener('message', async messageEvent => {
      let message;
      let rawFrame;
      try {
        rawFrame = typeof messageEvent.data === 'string' ? messageEvent.data : await messageEvent.data.text();
        message = JSON.parse(rawFrame);
      } catch {
        try { onEvent({ type: 'malformed_frame', raw: rawFrame ?? '[unreadable binary frame]' }); } catch {}
        return finish(new ProviderError('Vogent returned a malformed WebSocket frame; turn outcome is unknown.', { kind: 'malformed_frame' }));
      }
      try { onEvent({ type: 'provider_frame', frame: message, submitted }); } catch {}
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (message.type === 'connection_ack') {
        submitted = true;
        try { onEvent({ type: 'turn_submitted', chatId, text }); } catch {}
        ws.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: { query: CHAT_QUERY, variables: { input: { aiChatId: chatId, text } } },
        }));
      } else if (message.id === '1' && message.type === 'next') {
        if (message.payload?.errors?.length) {
          return finish(new ProviderError(`Vogent stream GraphQL error; turn outcome is unknown: ${safeErrorDetail(message.payload.errors)}`, { kind: 'stream_graphql_error', details: { errors: message.payload.errors } }));
        }
        const item = message.payload?.data?.runChatQueryStream;
        if (!item || typeof item !== 'object') return finish(new ProviderError('Vogent returned a malformed stream payload; turn outcome is unknown.', { kind: 'malformed_stream_payload' }));
        events.push(item);
        try { onEvent({ type: 'stream_event', event: item, index: events.length - 1 }); } catch {}
      } else if (message.id === '1' && message.type === 'error') {
        finish(new ProviderError(`Vogent chat stream error; turn outcome is unknown: ${safeErrorDetail(message.payload)}`, { kind: 'stream_error', details: message.payload }));
      } else if (message.id === '1' && message.type === 'complete') {
        if (!events.length) return finish(new ProviderError('Vogent completed an empty chat stream; turn outcome is unknown.', { kind: 'empty_completion' }));
        const reduced = reduceText(events);
        if (!reduced.text.trim()) return finish(new ProviderError('Vogent completed without assistant text; tool effects and reply outcome are unknown.', { kind: 'empty_reply' }));
        const functionCalls = collectTrace(events, item => item.transcriptLine?.functionCalls);
        const nodeTransitions = collectTrace(events, item => item.transcriptLine?.nodeTransitionResult);
        finish(null, {
          status: 'complete', outcome: 'stream_complete', text: reduced.text,
          transcriptLines: events.map((item, eventIndex) => item.transcriptLine ? ({ ...item.transcriptLine, provenance: 'runChatQueryStream', eventIndex }) : null).filter(Boolean),
          functionCalls, nodeTransitions,
          traceStatus: { functionCalls: functionCalls.length ? 'available' : 'unavailable_in_stream', nodeTransitions: nodeTransitions.length ? 'available' : 'unavailable_in_stream' },
          events, textReduction: { source: reduced.source, policy: 'prefer latest cumulative assistant transcriptLine; otherwise reconcile stream chunks without repeated prefixes' },
        });
      }
    });
    ws.addEventListener('error', () => finish(new ProviderError(
      submitted ? 'Vogent chat connection ended before stream completion; turn outcome is unknown.' : 'Vogent chat WebSocket failed before turn submission.',
      { kind: submitted ? 'premature_close' : 'websocket_error' },
    )));
    ws.addEventListener('close', event => {
      if (!finished) finish(new ProviderError(`Vogent closed the chat connection (${event.code}) before completion; turn outcome is unknown.`, { kind: 'premature_close' }));
    });
  });

  const readChat = async chatIdOrOptions => {
    const chatId = typeof chatIdOrOptions === 'string' ? chatIdOrOptions : chatIdOrOptions?.chatId;
    if (!chatId) throw new ProviderError('readChat requires a chat ID.', { kind: 'argument_error' });
    const body = await graphql(CHAT_READ_QUERY, { id: chatId });
    const data = body.data?.aiChat;
    if (!data) throw new ProviderError('Vogent returned no saved chat record.', { kind: 'schema_mismatch' });
    return {
      status: 'available', data,
      transcriptLines: Array.isArray(data.transcript) ? data.transcript.map((line, index) => ({ ...line, provenance: 'aiChat readback', lineIndex: index })) : null,
      capabilities: { functionCalls: 'requested', nodeTransitionResult: 'requested' },
      provenance: 'aiChat GraphQL readback',
    };
  };

  const getDial = async dialId => {
    const body = await request(`/api/dials/${encodeURIComponent(dialId)}`);
    const data = body.data || body;
    return { status: 'available', data, provenance: 'GET /api/dials/{id}' };
  };

  return { request, graphql, listAgents: () => getPages('/api/agents'), listPhones: () => getPages('/api/phone_numbers'), inspectAgent, createChat, runChatTurn, readChat, getDial };
}
