import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handleDiagnostics,
  prepareHarmlessControl,
  summarizeFunctionCompatibility,
  summarizeTraceCapability,
} from '../lib/diagnostics.mjs';

function inspection(overrides = {}) {
  return {
    agent: { id: 'agent-safe-1', name: 'Isolated control', defaultVersionedPromptId: 'prompt-safe-1' },
    prompt: {
      id: 'prompt-safe-1',
      agentType: 'CUSTOM_FLOW',
      flowDefinition: { nodes: [
        { id: 'node-lookup', type: 'function', nodeData: { functionId: 'function-safe-1', inputs: [
          { name: 'caller', value: '{{input.caller}}' },
          { name: 'Authorization', value: 'Bearer do-not-print-this-header' },
        ] } },
      ] },
    },
    functions: [{
      id: 'function-safe-1',
      name: 'safe_lookup',
      type: 'api',
      apiPath: 'https://staging.example.test/v1/safe-lookup?token=do-not-print-this-token',
      apiSchema: { headers: { Authorization: 'Bearer do-not-print-this-body-secret' } },
      inputSchema: { type: 'object', properties: { caller: { type: 'string' } }, required: ['caller'] },
    }],
    phoneLinkage: { status: 'unlinked', evidence: [{ phoneNumberId: 'private-phone-record' }] },
    provenance: 'read-only test fixture',
    ...overrides,
  };
}

test('function compatibility reports config and missing call inputs without values or secrets', () => {
  const report = summarizeFunctionCompatibility(inspection(), {
    callAgentInput: { privateToken: 'do-not-print-this-input' },
    expectedFunction: 'function-safe-1',
  });

  assert.equal(report.kind, 'function-compatibility');
  assert.equal(report.configuration.status, 'configuration-present');
  assert.deepEqual(report.configuration.referencedCallInputs, ['caller']);
  assert.deepEqual(report.configuration.missingCallInputs, ['caller']);
  assert.equal(report.configuration.expectedFunction.declaredInFlow, true);
  assert.equal(report.runtime.textChatFunctionSupport, 'unconfirmed-by-configuration-readback');
  const serialized = JSON.stringify(report);
  for (const secret of ['do-not-print-this-header', 'do-not-print-this-token', 'do-not-print-this-body-secret', 'do-not-print-this-input', 'private-phone-record']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('trace report separates internal calls, empty transitions, and endpoint evidence', () => {
  const report = summarizeTraceCapability({
    status: 'available',
    provenance: 'aiChat GraphQL readback',
    capabilities: { functionCalls: 'requested', nodeTransitionResult: 'requested' },
    data: { id: 'chat-1', transcript: [
      { role: 'AI', functionCalls: [{ id: 'call-1', name: 'commit_answer', arguments: '{"answer":"synthetic only"}' }], nodeTransitionResult: null },
    ] },
  }, { correlationEvidence: { timestamp: '2026-09-26T00:00:00Z' } });

  assert.equal(report.nativeProviderTrace.functionCalls.internalCommitAnswerCount, 1);
  assert.equal(report.nativeProviderTrace.functionCalls.otherTranscriptFunctionCallCount, 0);
  assert.equal(report.nativeProviderTrace.nodeTransitionResult.populatedCount, 0);
  assert.equal(report.nativeProviderTrace.functionResults, 'unavailable-in-observed-chat-schema');
  assert.equal(report.backendEvidence.endpointReceipt, 'not-proven-by-provider-chat-record');
  assert.equal(report.backendEvidence.correlation.status, 'timestamp-only-insufficient');
  assert.equal(JSON.stringify(report).includes('synthetic only'), false);
});

test('control preflight requires exact profile authorization and never sends a chat', async () => {
  const safeProfile = {
    name: 'isolated-test',
    agentId: 'agent-safe-1',
    harmlessControl: {
      expectedPromptId: 'prompt-safe-1',
      functionIds: ['function-safe-1'],
      allowedTargets: [{ host: 'staging.example.test', pathPrefix: '/v1/safe-lookup' }],
    },
  };
  const authorized = prepareHarmlessControl({
    rawInspection: inspection(),
    authorization: safeProfile,
    message: 'Run the synthetic lookup control.',
    callAgentInput: { caller: '5550000000' },
  });
  assert.equal(authorized.status, 'preflight-passed');
  assert.equal(authorized.action, 'preflight-only-no-chat-created-or-message-sent');
  assert.equal(authorized.execution, 'not-run');
  assert.equal(authorized.message.characterCount > 0, true);

  let createCalls = 0;
  let sendCalls = 0;
  const provider = {
    inspectAgent: async () => inspection(),
    createChat: async () => { createCalls += 1; throw new Error('must remain read-only'); },
    runChatTurn: async () => { sendCalls += 1; throw new Error('must remain read-only'); },
  };
  const blocked = await handleDiagnostics('control-preflight', {
    agentId: 'agent-safe-1',
    profile: 'isolated-test',
    message: 'Run the synthetic lookup control.',
  }, { provider, profiles: { 'isolated-test': { ...safeProfile, agentId: 'different-agent' } } });

  assert.equal(blocked.status, 'not-authorized');
  assert.equal(createCalls, 0);
  assert.equal(sendCalls, 0);
});

test('control preflight does not treat an unlinked agent or a generic profile target as harmless', () => {
  const report = prepareHarmlessControl({
    rawInspection: inspection(),
    authorization: { name: 'generic', agentId: 'agent-safe-1', allowedTargets: [{ host: 'staging.example.test', pathPrefix: '/v1' }] },
    message: 'Run the control.',
  });
  assert.equal(report.status, 'not-authorized');
  assert.ok(report.findings.includes('profile-does-not-authorize-this-exact-agent-for-control'));
  assert.ok(report.findings.includes('profile-has-no-explicit-harmless-control-function'));
});

test('diagnose-tools can inspect a saved chat without creating or sending one', async () => {
  const calls = [];
  const provider = {
    inspectAgent: async id => { calls.push(['inspect', id]); return inspection(); },
    readChat: async ({ chatId }) => {
      calls.push(['read', chatId]);
      return { data: { id: chatId, transcript: [{ role: 'AI', functionCalls: [{ name: 'commit_answer' }] }] } };
    },
    createChat: async () => { throw new Error('must remain read-only'); },
    runChatTurn: async () => { throw new Error('must remain read-only'); },
  };

  const report = await handleDiagnostics('diagnose-tools', { agentId: 'agent-safe-1', chatId: 'saved-chat-1' }, { provider });
  assert.equal(report.observedChat.chatId, 'saved-chat-1');
  assert.equal(report.control.status, 'not-run');
  assert.deepEqual(calls, [['inspect', 'agent-safe-1'], ['read', 'saved-chat-1']]);
});

test('doctor reports only read-only capability counts and runtime feature presence', async () => {
  const provider = {
    listAgents: async () => [{ id: 'agent-1', name: 'private-name' }],
    listPhones: async () => [{ phoneNumber: '+15550000000', agentId: 'agent-1' }],
    createChat: async () => { throw new Error('must remain read-only'); },
    runChatTurn: async () => { throw new Error('must remain read-only'); },
  };
  const report = await handleDiagnostics('doctor', {}, { provider });
  assert.equal(report.credential.status, 'accepted-for-read-only-agent-list');
  assert.equal(report.api.agentCount, 1);
  assert.equal(report.api.phoneCount, 1);
  assert.equal(report.api.effects, 'read-only GET requests; no chat created');
  assert.equal(JSON.stringify(report).includes('private-name'), false);
  assert.equal(JSON.stringify(report).includes('+15550000000'), false);
});
