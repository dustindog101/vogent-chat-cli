const timestampOf = item => item?.timestamp || item?.createdAt || item?.time || item?.date || null;

function itemsOf(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

export function buildDialTimeline(readback) {
  const data = readback?.data || readback || {};
  const transcript = itemsOf(data.transcript);
  const functions = itemsOf(data.functionCalls || data.functions);
  const transitions = itemsOf(data.nodeTransition || data.nodeTransitions || data.nodeTransitionResults);
  const timeline = [];
  const add = (kind, records, field) => records.forEach((record, index) => timeline.push({
    kind,
    timestamp: timestampOf(record),
    sourceIndex: index,
    provenance: `${readback?.provenance || 'GET /api/dials/{id}'}.${field}`,
    data: record,
  }));
  add('transcript', transcript, 'transcript');
  add('function_call', functions, data.functionCalls ? 'functionCalls' : 'functions');
  add('node_transition', transitions, data.nodeTransition ? 'nodeTransition' : (data.nodeTransitions ? 'nodeTransitions' : 'nodeTransitionResults'));
  const hasAllTimestamps = timeline.every(item => item.timestamp && Number.isFinite(Date.parse(item.timestamp)));
  if (hasAllTimestamps) timeline.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const versionedPromptId = data.versionedPromptId || data.executedVersionedPromptId || data.agentVersionedPromptId || null;
  const recordingRefs = [
    ...itemsOf(data.recordings).map(item => typeof item === 'string' ? item : item.url || item.recordingUrl || item.id || null),
    data.recordingUrl || data.recording || null,
  ].filter(Boolean);
  const gaps = [];
  if (!transcript.length) gaps.push('transcript_unavailable');
  if (!functions.length) gaps.push('function_calls_unavailable');
  if (!transitions.length) gaps.push('node_transitions_unavailable');
  if (!versionedPromptId) gaps.push('executed_prompt_id_unavailable');
  if (!timeline.every(item => item.timestamp)) gaps.push('one_or_more_timestamps_unavailable');
  return {
    schema: 'vogent-dial-timeline.v1',
    dialId: data.id || null,
    status: data.status || null,
    result: data.result || data.aiResult || null,
    executedVersionedPromptId: versionedPromptId,
    requestedOrCurrentDefaultPromptId: null,
    timelineOrdering: hasAllTimestamps ? 'timestamp' : 'provider_field_order_with_source_indices',
    timeline,
    recordingReferences: recordingRefs,
    recordingInspected: false,
    gaps,
    provenance: readback?.provenance || 'GET /api/dials/{id}',
  };
}
