import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileKyronBooking, createKyronReadOnlyAdapter } from '../lib/effects.mjs';

const expected = {
  patient_id: 901,
  doctor_id: 7,
  slot_id: 41,
  location_code: 'EAST',
  body_part: 'knee',
  issue_type: 'follow_up',
  appointment_time: '2030-06-03T14:00:00+00:00',
  formatted_time: 'Monday, June 03 at 10:00 AM',
  doctor_name: 'Dr. Example',
  location_name: 'East Clinic',
  status: 'SCHEDULED',
};

function appointment(id, overrides = {}) {
  return { id, ...expected, ...overrides };
}

function speech(turnOverrides = {}) {
  const turns = [
    { name: 'offer', input: 'I need an appointment.', reply: 'Dr. Example at East Clinic has Monday, June 03 at 10:00 AM.', persisted: true },
    { name: 'choice', input: "I'll take the first one.", reply: 'Monday, June 03 at 10:00 AM with Dr. Example at East Clinic. Should I book that?', persisted: true },
    { name: 'confirmation', input: 'Yes, please book that appointment.', reply: 'Confirmed: Monday, June 03 at 10:00 AM with Dr. Example at East Clinic.', persisted: true },
  ].map(turn => ({ ...turn, ...(turnOverrides[turn.name] ?? {}) }));
  return {
    turns,
    offerTurn: 'offer',
    choiceTurn: 'choice',
    confirmationTurn: 'confirmation',
    choiceText: 'first one',
    confirmationText: 'Yes',
    confirmationPromptText: 'Should I book that?',
    offeredOptions: [{ time: expected.formatted_time, doctor: expected.doctor_name, location: expected.location_name }],
    selectedOptionIndex: 0,
  };
}

test('Kyron reconciliation proves exact row IDs/content and separately checks persisted offer, choice, and confirmation', () => {
  const before = [appointment(5, { patient_id: 902, slot_id: 30, doctor_id: 8 })];
  const after = [...before, appointment(92)];
  const result = reconcileKyronBooking({ before, after, expected, speech: speech() });

  assert.equal(result.status, 'pass');
  assert.equal(result.backend.status, 'pass');
  assert.equal(result.backend.appointmentId, 92);
  assert.deepEqual(result.changes.unrelatedAddedIds, []);
  assert.equal(result.speech.checks.callerGivesExplicitConfirmation, true);
  assert.equal(result.speech.checks.selectedOptionMatchesBackendAppointment, true);
});

test('unrelated concurrent row changes are preserved and do not get attributed by count', () => {
  const before = [appointment(5, { patient_id: 902, slot_id: 30, doctor_id: 8 })];
  const after = [
    ...before,
    appointment(92),
    appointment(93, { id: 93, patient_id: 901, slot_id: 42, doctor_id: 9, formatted_time: 'Tuesday, June 04 at 11:00 AM' }),
  ];
  const result = reconcileKyronBooking({ before, after, expected, speech: speech() });

  assert.equal(result.status, 'pass');
  assert.equal(result.backend.appointmentId, 92);
  assert.deepEqual(result.changes.unrelatedAddedIds, [93]);
});

test('an uncertain booking turn stays incomplete even when a matching backend row appeared', () => {
  const result = reconcileKyronBooking({ before: [], after: [appointment(92)], expected, speech: speech(), turnOutcome: 'incomplete' });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.backend.status, 'pass');
  assert.equal(result.speech.status, 'incomplete');
});

test('a spoken success with wrong appointment content fails', () => {
  const result = reconcileKyronBooking({
    before: [], after: [appointment(92, { slot_id: 42, formatted_time: 'Tuesday, June 04 at 11:00 AM' })],
    expected, speech: speech(),
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.backend.status, 'fail');
});

test('ambiguous or unidentified rows are incomplete', () => {
  assert.equal(reconcileKyronBooking({ before: [], after: [{ ...appointment(null) }], expected, speech: speech() }).status, 'incomplete');
  assert.equal(reconcileKyronBooking({ before: [], after: [appointment(92), appointment(92)], expected, speech: speech() }).status, 'incomplete');
});

test('missing caller confirmation is incomplete and an out-of-order confirmation cannot pass', () => {
  const missing = speech({ confirmation: { input: '', persisted: false } });
  assert.equal(reconcileKyronBooking({ before: [], after: [appointment(92)], expected, speech: missing }).status, 'incomplete');
  const reversed = speech();
  reversed.turns = [reversed.turns[0], reversed.turns[2], reversed.turns[1]];
  assert.equal(reconcileKyronBooking({ before: [], after: [appointment(92)], expected, speech: reversed }).status, 'incomplete');
});

test('a positive word followed by a negated booking instruction is not consent', () => {
  const denied = speech({ confirmation: { input: 'Yes, but do not book that appointment.' } });
  const result = reconcileKyronBooking({ before: [], after: [appointment(92)], expected, speech: denied });
  assert.equal(result.status, 'fail');
  assert.equal(result.speech.checks.callerGivesExplicitConfirmation, false);
});

test('Kyron HTTP observer is scoped to a local fixture and only performs GET reads', async () => {
  let requests = 0;
  const fetchImpl = async (url, init) => {
    requests++;
    assert.equal(init.method, 'GET');
    assert.equal(String(url), 'http://127.0.0.1:5000/api/appointments?patient_id=901');
    return { ok: true, json: async () => ({ appointments: [appointment(92)] }) };
  };
  const adapter = createKyronReadOnlyAdapter({ baseUrl: 'http://127.0.0.1:5000', patientId: 901, fetchImpl });
  const snapshot = await adapter.snapshot();
  assert.equal(requests, 1);
  assert.deepEqual(snapshot.appointments, [appointment(92)]);
});
