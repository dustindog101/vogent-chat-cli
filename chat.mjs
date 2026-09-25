#!/usr/bin/env node
// Text-only agent chat. Vogent's chat GraphQL operations are observed dashboard
// behavior, not a documented public API; recheck them if this helper stops working.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.vogent.ai';
const TURN_TIMEOUT_MS = Math.min(180_000, Math.max(5_000,
  Number(process.env.VOGENT_CHAT_TIMEOUT_MS) || 45_000));
const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const CHAT_QUERY = `subscription RunChatMessage($input: RunChatQueryInput!) {
  runChatQueryStream(input: $input) {
    messageType
    text
    transcriptLine { role text }
  }
}`;

function credential() {
  if (process.env.VOGENT_API_KEY) return process.env.VOGENT_API_KEY;
  try {
    const line = readFileSync(resolve(REPO_ROOT, '.env.local'), 'utf8').split('\n')
      .find(x => x.startsWith('VOGENT_API_KEY='));
    if (line) {
      const value = line.slice('VOGENT_API_KEY='.length).trim();
      return value.replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  throw new Error('Set VOGENT_API_KEY or create an ignored .env.local in the repository root.');
}

function options(argv) {
  const result = { agent: null, messages: [], list: false, inspect: false, allowLive: false };
  for (let i = 0; i < argv.length; i++) {
    if (['--agent', '--agent-id'].includes(argv[i]) && argv[i + 1]) result.agent = argv[++i];
    else if (argv[i] === '--message' && argv[i + 1]) result.messages.push(argv[++i]);
    else if (argv[i] === '--list') result.list = true;
    else if (argv[i] === '--inspect') result.inspect = true;
    else if (argv[i] === '--allow-live') result.allowLive = true;
    else if (argv[i] === '--help') {
      console.log('Usage: node chat.mjs [--list] [--agent ID|NAME] [--inspect] [--message TEXT ...] [--allow-live]');
      console.log('Without --agent, choose from a numbered menu. Without --message, type turns interactively; /quit ends the chat.');
      console.log('--inspect reads the selected agent without creating a chat. --allow-live permits a chat that may invoke live functions.');
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if (result.list && (result.inspect || result.messages.length)) throw new Error('--list cannot be combined with --inspect or --message.');
  if (result.inspect && result.messages.length) throw new Error('--inspect cannot be combined with --message.');
  return result;
}

async function jsonRequest(path, token, init = {}) {
  const response = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors.map(x => x.message).join('; '));
  return body;
}

async function getPages(path, token) {
  let cursor;
  const items = [];
  const seen = new Set();
  do {
    const page = await jsonRequest(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, token);
    if (!Array.isArray(page.data)) throw new Error(`${path} returned an unexpected response.`);
    items.push(...page.data);
    cursor = page.cursor;
    if (cursor) {
      if (seen.has(cursor)) throw new Error(`${path} repeated a pagination cursor.`);
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

function phoneLinked(agentId, phones) {
  return phones.some(phone => JSON.stringify(phone).includes(agentId));
}

function showAgents(agents, phones) {
  agents.forEach((agent, index) => {
    const linked = phoneLinked(agent.id, phones) ? 'phone-linked' : 'no linked phone found';
    console.log(`${index + 1}. ${agent.name} (${agent.id}) — ${linked}`);
  });
}

async function chooseAgent(agents, phones, selector, input) {
  if (selector) {
    const query = selector.toLowerCase();
    const exact = agents.filter(agent => agent.id.toLowerCase() === query || agent.name.toLowerCase() === query);
    const matches = exact.length ? exact : agents.filter(agent => agent.name.toLowerCase().includes(query));
    if (matches.length !== 1) throw new Error(matches.length ? 'Agent name is ambiguous; use its ID.' : `Agent ${selector} was not found.`);
    return matches[0];
  }
  if (!input) throw new Error('Use --agent ID|NAME for noninteractive chat. Run --list to see agents.');
  showAgents(agents, phones);
  const answer = (await input.question('Choose an agent number: ')).trim();
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= agents.length) throw new Error('Choose a valid agent number.');
  return agents[index];
}

function functionTarget(fn) {
  if (fn.type !== 'api') return fn.type || 'unknown type';
  try {
    const url = new URL(fn.apiPath);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'invalid or missing API URL';
  }
}

async function inspectAgent(agent, phones, token) {
  const linked = agent.linkedFunctionDefinitions || [];
  const functions = await Promise.all(linked.map(link => jsonRequest(`/api/functions/${link.functionDefinitionId}`, token)));
  const promptId = agent.defaultVersionedPromptId;
  const prompt = promptId ? await jsonRequest(`/api/agents/${agent.id}/versioned_prompts/${promptId}`, token) : null;
  console.log(`Agent: ${agent.name} (${agent.id})`);
  console.log(`Active prompt: ${promptId || 'none'}; type: ${prompt?.agentType || 'unknown'}; flow nodes: ${prompt?.flowDefinition?.nodes?.length ?? 'unknown'}`);
  console.log(`Phone-linked: ${phoneLinked(agent.id, phones) ? 'yes' : 'no linked phone found'}`);
  if (!functions.length) console.log('Functions: none linked');
  for (const fn of functions) {
    console.log(`Function: ${fn.name} (${fn.id}) -> ${functionTarget(fn)}`);
  }
  console.log('Review linked function targets before starting a chat; turns may have live effects.');
}

async function createChat(agentId, token) {
  const query = 'mutation CreateChat($input: CreateChatInput!) { createAiChat(input: $input) { id } }';
  const body = await jsonRequest('/query', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { input: { agentId, callAgentInput: {} } } }),
  });
  const id = body.data?.createAiChat?.id;
  if (!id) throw new Error('Vogent did not return a chat ID.');
  return id;
}

function sendTurn(chatId, text, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.vogent.ai/query', ['graphql-transport-ws']);
    const events = [];
    let finished = false;
    const timer = setTimeout(() => finish(new Error('Vogent chat turn timed out.')), TURN_TIMEOUT_MS);

    function finish(error, response) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(response);
    }

    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: { authToken: token } }));
    ws.onmessage = async event => {
      let message;
      try { message = JSON.parse(typeof event.data === 'string' ? event.data : await event.data.text()); }
      catch { return; }
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else if (message.type === 'connection_ack') {
        ws.send(JSON.stringify({
          id: '1', type: 'subscribe',
          payload: { query: CHAT_QUERY, variables: { input: { aiChatId: chatId, text } } },
        }));
      } else if (message.id === '1' && message.type === 'next') {
        const item = message.payload?.data?.runChatQueryStream;
        if (item) events.push(item);
      } else if (message.id === '1' && message.type === 'error') {
        finish(new Error(`Vogent chat error: ${JSON.stringify(message.payload).slice(0, 300)}`));
      } else if (message.id === '1' && message.type === 'complete') {
        const lines = events.filter(x => ['AI', 'assistant'].includes(x.transcriptLine?.role))
          .map(x => x.transcriptLine.text).filter(Boolean);
        const chunks = events.map(x => x.text).filter(Boolean);
        finish(null, lines.join('') || chunks.join(''));
      }
    };
    ws.onerror = () => finish(new Error('Vogent chat WebSocket failed.'));
    ws.onclose = event => {
      if (!finished) finish(new Error(`Vogent closed the chat connection (${event.code}).`));
    };
  });
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args.list && !args.inspect && !args.messages.length && !process.stdin.isTTY) {
    throw new Error('Interactive chat requires a terminal. Use --message for scripted turns.');
  }
  const token = credential();
  const [agents, phones] = await Promise.all([
    getPages('/api/agents', token), getPages('/api/phone_numbers', token),
  ]);
  if (!agents.length) throw new Error('No Vogent agents were returned.');
  if (args.list) {
    showAgents(agents, phones);
    return;
  }

  const input = process.stdin.isTTY && !args.messages.length
    ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const agent = await chooseAgent(agents, phones, args.agent, input);
    await inspectAgent(agent, phones, token);
    if (args.inspect) return;
    if (!args.allowLive) {
      if (!input) throw new Error('Chat may invoke live functions. Re-run with --allow-live after reviewing the agent.');
      const answer = (await input.question('This chat may invoke live functions. Type the agent name to continue: ')).trim();
      if (answer !== agent.name) {
        console.log('Chat cancelled.');
        return;
      }
    }
    console.log('Text chat creates a chat record and can invoke linked functions. It does not test phone audio or ASR.');
    const chatId = await createChat(agent.id, token);
    console.log(`Chat ID: ${chatId}`);

    if (args.messages.length) {
      for (const message of args.messages) {
        console.log(`You: ${message}`);
        console.log(`Agent: ${await sendTurn(chatId, message, token)}`);
      }
      return;
    }

    while (true) {
      const message = (await input.question('You (/quit to end): ')).trim();
      if (message === '/quit') break;
      if (!message) continue;
      console.log(`Agent: ${await sendTurn(chatId, message, token)}`);
    }
  } finally {
    input?.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
