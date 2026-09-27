import { isDeepStrictEqual } from 'node:util';

const REQUIRED_APPOINTMENT_FIELDS = [
  'patient_id', 'doctor_id', 'slot_id', 'location_code', 'body_part',
  'issue_type', 'appointment_time', 'formatted_time', 'doctor_name',
  'location_name', 'status',
];

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.appointments)) return value.appointments;
  return null;
}

function rowKey(row) {
  if (!row || (typeof row.id !== 'string' && typeof row.id !== 'number')) return null;
  if (typeof row.id === 'number' && (!Number.isInteger(row.id) || row.id < 1)) return null;
  if (typeof row.id === 'string' && !row.id.trim()) return null;
  return `${typeof row.id}:${String(row.id)}`;
}

function sameExpectedFields(actual, expected) {
  return Object.entries(expected).every(([key, value]) => isDeepStrictEqual(actual?.[key], value));
}

function changedRows(before, after) {
  const oldById = new Map(before.map(row => [rowKey(row), row]));
  const newById = new Map(after.map(row => [rowKey(row), row]));
  const added = after.filter(row => !oldById.has(rowKey(row)));
  const removed = before.filter(row => !newById.has(rowKey(row)));
  const updated = after.filter(row => oldById.has(rowKey(row)) &&
    !isDeepStrictEqual(oldById.get(rowKey(row)), row));
  return { added, removed, updated };
}

function uniqueIdentifiers(rows) {
  const seen = new Set();
  for (const row of rows) {
    const key = rowKey(row);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function getNamedTurn(turns, name) {
  return turns?.find(turn => turn.name === name) ?? null;
}

function speechContains(turn, expected) {
  if (!turn || turn.persisted !== true || typeof turn.reply !== 'string') return false;
  return turn.reply.includes(expected);
}

function givesUnambiguousConsent(input, expectedPhrase) {
  if (typeof input !== 'string' || !input.includes(expectedPhrase)) return false;
  // A positive token followed by a refusal or caveat must never authorize a
  // booking. Keep this deliberately conservative and deterministic.
  return !/\b(?:no|not|never|cancel(?:led)?|stop|wait|hold\s+off|do\s+not|don't|dont|cannot|can't|decline|refuse)\b/i.test(input);
}

/**
 * Reconcile read-only appointment snapshots with deterministic speech evidence.
 * `expected` describes the exact appointment fields (except generated `id`).
 * Speech claims are taken from the persisted named turn replies, while the
 * selected caller choice is taken from the persisted caller utterance.
 */
export function reconcileKyronBooking({ before, after, expected, speech, turnOutcome = 'complete' }) {
  const oldRows = asArray(before);
  const newRows = asArray(after);
  const missing = REQUIRED_APPOINTMENT_FIELDS.filter(key => !Object.hasOwn(expected ?? {}, key));
  if (!oldRows || !newRows || missing.length) {
    return {
      status: 'incomplete',
      backend: { status: 'incomplete', reason: !oldRows || !newRows ? 'appointment snapshots are missing or malformed' : `expected appointment is missing fields: ${missing.join(', ')}` },
      speech: { status: 'incomplete', reason: 'speech expectations cannot be reconciled without complete booking evidence' },
      changes: null,
    };
  }

  if (!uniqueIdentifiers(oldRows) || !uniqueIdentifiers(newRows)) {
    return {
      status: 'incomplete',
      backend: { status: 'incomplete', reason: 'before/after snapshots contain a missing or duplicate appointment identifier' },
      speech: { status: 'incomplete', reason: 'ambiguous appointment evidence cannot be reconciled to speech' },
      changes: null,
    };
  }

  const changes = changedRows(oldRows, newRows);
  const priorTarget = oldRows.filter(row => row.patient_id === expected.patient_id && row.slot_id === expected.slot_id);
  const matchingAdded = changes.added.filter(row => row.patient_id === expected.patient_id &&
    row.slot_id === expected.slot_id && sameExpectedFields(row, expected));
  const targetAdded = changes.added.filter(row => row.patient_id === expected.patient_id &&
    row.slot_id === expected.slot_id);

  let backend;
  if (priorTarget.length) {
    backend = { status: 'incomplete', reason: 'the expected patient and slot already existed in the before snapshot' };
  } else if (targetAdded.length > 1 || matchingAdded.length > 1) {
    backend = {
      status: 'incomplete',
      reason: 'multiple new appointment rows match the expected patient and slot',
      matchingRows: targetAdded,
    };
  } else if (targetAdded.length !== 1 || matchingAdded.length !== 1) {
    backend = {
      status: 'fail',
      reason: targetAdded.length === 0 ? 'no new appointment exists for the expected patient and slot' :
        'the patient and slot delta is ambiguous or its row content differs from expectations',
      matchingRows: targetAdded,
    };
  } else {
    backend = { status: 'pass', appointmentId: matchingAdded[0].id, appointment: matchingAdded[0] };
  }

  const offer = getNamedTurn(speech?.turns, speech?.offerTurn);
  const choice = getNamedTurn(speech?.turns, speech?.choiceTurn);
  const confirmation = getNamedTurn(speech?.turns, speech?.confirmationTurn);
  const requiredSpeech = [offer, choice, confirmation];
  let spoken;
  const speechTurnIndexes = requiredSpeech.map(turn => speech?.turns?.indexOf(turn) ?? -1);
  const speechTurnsOrdered = requiredSpeech.every((turn, index) => turn &&
    (index === 0 || speechTurnIndexes[index] > speechTurnIndexes[index - 1]));
  const confirmationImmediatelyFollowsChoice = speechTurnIndexes[2] === speechTurnIndexes[1] + 1;
  if (requiredSpeech.some(turn => !turn || turn.persisted !== true || turnOutcome !== 'complete') || !speechTurnsOrdered || !confirmationImmediatelyFollowsChoice) {
    spoken = {
      status: 'incomplete',
      reason: turnOutcome !== 'complete' ? 'booking turn outcome was uncertain' :
        !speechTurnsOrdered || !confirmationImmediatelyFollowsChoice ? 'offer, caller choice, and explicit confirmation are not three ordered persisted turns' :
          'offer, caller choice, or confirmation is absent from saved chat evidence',
    };
  } else {
    const options = Array.isArray(speech.offeredOptions) ? speech.offeredOptions : [];
    const selectedIndex = speech.selectedOptionIndex;
    const selectedOption = Number.isInteger(selectedIndex) ? options[selectedIndex] : null;
    const offerOptions = options.map(option => [option?.time, option?.doctor, option?.location]);
    const expectedTime = expected.formatted_time;
    const checks = {
      offerIncludesEveryExpectedOption: options.length > 0 && offerOptions.every(parts => parts.every(text => typeof text === 'string' && text.length > 0 && speechContains(offer, text))),
      selectedOptionMatchesBackendAppointment: Boolean(selectedOption && selectedOption.time === expectedTime &&
        selectedOption.doctor === expected.doctor_name && selectedOption.location === expected.location_name),
      callerSelectedExpectedOption: speechContains({ persisted: true, reply: choice.input }, speech.choiceText),
      offerIncludesExpectedDoctor: speechContains(offer, expected.doctor_name),
      confirmationIncludesExpectedDoctor: speechContains(confirmation, expected.doctor_name),
      offerIncludesExpectedLocation: speechContains(offer, expected.location_name),
      confirmationIncludesExpectedLocation: speechContains(confirmation, expected.location_name),
      confirmationIncludesSelectedTime: speechContains(confirmation, expectedTime),
      choiceReplyRepeatsSelectedTime: speechContains(choice, expectedTime),
      choiceReplyRepeatsExpectedDoctor: speechContains(choice, expected.doctor_name),
      choiceReplyRepeatsExpectedLocation: speechContains(choice, expected.location_name),
      choiceReplyRequestsSeparateConfirmation: speechContains(choice, speech.confirmationPromptText),
      callerGivesExplicitConfirmation: confirmation.persisted === true && givesUnambiguousConsent(confirmation.input, speech.confirmationText),
    };
    spoken = {
      status: Object.values(checks).every(Boolean) ? 'pass' : 'fail',
      checks,
      claims: {
        offer: offer.reply,
        offeredOptions: options,
        selectedOptionIndex: selectedIndex,
        callerChoice: choice.input,
        confirmation: confirmation.reply,
      },
    };
  }

  let status = 'pass';
  if (backend.status === 'fail' || spoken.status === 'fail') status = 'fail';
  else if (backend.status !== 'pass' || spoken.status !== 'pass' || turnOutcome !== 'complete') status = 'incomplete';

  return {
    status,
    backend,
    speech: spoken,
    changes: {
      addedIds: changes.added.map(row => row.id),
      removedIds: changes.removed.map(row => row.id),
      updatedIds: changes.updated.map(row => row.id),
      // Concurrent rows are retained as evidence and do not get attributed to
      // this scenario unless both patient_id and slot_id match the expectation.
      unrelatedAddedIds: changes.added.filter(row => row.patient_id !== expected.patient_id || row.slot_id !== expected.slot_id).map(row => row.id),
    },
  };
}

function localHost(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

/**
 * Create the built-in Kyron observer. It only issues GET requests to
 * /api/appointments; booking and cleanup are never performed by this adapter.
 */
export function createKyronReadOnlyAdapter({ baseUrl, patientId, fetchImpl = globalThis.fetch, allowRemote = false, timeoutMs = 10_000 } = {}) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) throw new Error('Kyron effect adapter needs an explicit baseUrl.');
  if (!Number.isInteger(patientId) || patientId < 1) throw new Error('Kyron effect adapter needs a positive integer patientId.');
  if (typeof fetchImpl !== 'function') throw new Error('Kyron effect adapter requires fetch.');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Kyron effect adapter baseUrl must use HTTP or HTTPS.');
  if (!localHost(url.hostname) && !allowRemote) {
    throw new Error('Remote Kyron effect reads require the explicit --allow-live guard.');
  }

  return {
    id: 'kyron-readonly-http-v1',
    async snapshot() {
      const endpoint = new URL(`/api/appointments?patient_id=${encodeURIComponent(patientId)}`, url);
      const response = await fetchImpl(endpoint, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error(`Kyron appointment read returned HTTP ${response.status}.`);
      const body = await response.json();
      if (!body || !Array.isArray(body.appointments)) throw new Error('Kyron appointment read returned an unexpected shape.');
      return { patientId, appointments: body.appointments };
    },
    reconcile({ before, after, expected, speech, turnOutcome }) {
      if (before?.patientId !== patientId || after?.patientId !== patientId) {
        return {
          status: 'incomplete',
          backend: { status: 'incomplete', reason: 'snapshot patient IDs do not match the adapter scope' },
          speech: { status: 'incomplete', reason: 'snapshot scope mismatch' },
          changes: null,
        };
      }
      return reconcileKyronBooking({ before, after, expected, speech, turnOutcome });
    },
  };
}

export async function snapshotEffects(adapter) {
  if (!adapter) return { status: 'not_requested' };
  if (typeof adapter.snapshot !== 'function' || typeof adapter.reconcile !== 'function') {
    throw new Error('Effect adapter must implement snapshot() and reconcile().');
  }
  return { status: 'ready', adapterId: String(adapter.id || 'custom') , value: await adapter.snapshot() };
}

export function finishEffects(adapter, before, after, { expected, speech, turnOutcome } = {}) {
  if (!adapter) return { status: 'not_requested' };
  if (before?.status !== 'ready' || after?.status !== 'ready') {
    return {
      status: 'incomplete', adapterId: before?.adapterId || after?.adapterId || adapter.id || 'custom',
      reason: before?.reason || after?.reason || 'before/after effect snapshot is unavailable',
    };
  }
  const result = adapter.reconcile({ before: before.value, after: after.value, expected, speech, turnOutcome });
  return { ...result, adapterId: before.adapterId };
}

export function effectSnapshotFailure(adapter, error) {
  return { status: 'incomplete', adapterId: adapter?.id || 'custom', reason: error?.message || String(error) };
}
