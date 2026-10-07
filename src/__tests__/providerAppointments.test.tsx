/**
 * My Appointments — the signed-in provider's own appointments (every one booked WITH them, across their
 * patients), by mouse and through the assistant: see who each is with, cancel with a note, reschedule with
 * a comment. Never another provider's, and never a double booking.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { store } from '@/store';
import { login } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchProviders } from '@/store/slices/providerSlice';
import { appointmentsSlice } from '@/store/slices/recordSlices';
import { voiceActions } from '@/store/slices/voiceSlice';
import { selectCurrentProvider } from '@/hooks/useProviderData';
import { call, type ScriptedLLM } from '@/services/ai/__tests__/fakes';
import type { Appointment } from '@/types/domain';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, useScriptedModel, wait, waitUntil } from './harness';

const TIMEOUT = 30000;
let model: ScriptedLLM;

beforeAll(installBrowserStubs);
afterEach(unmountApp);

beforeEach(async () => {
  store.dispatch(voiceActions.resetVoice());
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchProviders()).unwrap();
  await store.dispatch(appointmentsSlice.fetchAll()).unwrap();
  store.dispatch(setCurrentPatient(null));
  model = useScriptedModel();
});

const me = () => selectCurrentProvider(store.getState())!;
const all = () => appointmentsSlice.selectors.selectAll(store.getState());
const byId = (id: string) => all().find((a) => a.id === id)!;
/** One of my appointments that can still be changed (future, still booked). */
const changeable = (skip = 0): Appointment =>
  all()
    .filter((a) => a.providerId === me().id && !['Cancelled', 'No Show', 'Completed'].includes(a.status) && dayjs(`${a.date}T${a.startTime}`).isAfter(dayjs().add(1, 'hour')))
    .sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`))[skip];
const row = (id: string) => document.querySelector(`[data-appointment="${id}"]`) as HTMLElement | null;
const buttonIn = (el: ParentNode, text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const type = (el: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('My Appointments', () => {
  it('shows only my appointments — each with the patient it is with — never another provider’s', async () => {
    await renderAppAt('/schedule', () => pageText().includes('My Appointments'));
    (document.querySelector('.schedule-toolbar .ant-segmented-item input[value="all"]') as HTMLInputElement | null)?.click();
    const allView = [...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent === 'All') as HTMLElement;
    allView.click();
    await waitUntil(() => document.querySelectorAll('[data-appointment]').length > 0);
    const shown = [...document.querySelectorAll('[data-appointment]')].map((el) => el.getAttribute('data-appointment')!);
    const mine = all().filter((a) => a.providerId === me().id);
    expect(shown.length).toBe(mine.length);
    expect(shown.every((id) => byId(id).providerId === me().id)).toBe(true);
    const first = byId(shown[0]);
    expect(row(first.id)!.textContent).toContain(first.patientName);
  }, TIMEOUT);

  it('by mouse: Cancel asks for a note, and cancels with it', async () => {
    const target = changeable();
    await renderAppAt('/schedule', () => !!row(target.id));
    buttonIn(row(target.id)!, 'Cancel').click();
    await waitUntil(() => pageText().includes('Cancel appointment') && !!document.querySelector('#cancellationNote'));
    type(document.querySelector('#cancellationNote') as HTMLTextAreaElement, 'Patient admitted to hospital');
    await wait(60);
    buttonIn(document.querySelector('.app-modal')!.closest('.ant-modal')!, 'Cancel appointment').click();
    await waitUntil(() => byId(target.id).status === 'Cancelled');
    expect(byId(target.id).cancellationNote).toBe('Patient admitted to hospital');
    // The patient is told, with the same reason.
    const told = byId(target.id).patientNotices!.at(-1)!;
    expect(told).toMatchObject({ kind: 'cancelled' });
    expect(told.message).toContain('has been cancelled. Reason: Patient admitted to hospital');
    // On the grid (the Cancelled view): the flag, the note, and that the patient was told.
    ([...document.querySelectorAll('.ant-segmented-item')].find((el) => el.textContent === 'Cancelled') as HTMLElement).click();
    await waitUntil(() => !!row(target.id));
    expect(row(target.id)!.querySelector('.appt-flag')?.textContent).toContain('Cancelled');
    expect(row(target.id)!.textContent).toContain('Cancellation note: Patient admitted to hospital');
    expect(row(target.id)!.textContent).toMatch(/Patient told by (SMS|Email)/);
  }, TIMEOUT);

  it('through the assistant: list, then cancel one with a note — saved on the provider’s yes', async () => {
    const target = changeable(1);
    await renderAppAt('/dashboard');
    model.calls([call('list_my_appointments', {})], 'Here are your appointments.');
    await say('show my appointments');
    await waitUntil(() => window.location.pathname === '/schedule' || !!document.querySelector('.schedule-card'));
    const listed = model.lastToolResults()[0].data as Array<{ id: string; patient: string }>;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((a) => byId(a.id).providerId === me().id)).toBe(true);

    model.then({ calls: [call('cancel_my_appointment', { appointment: target.id, note: 'The clinic is closed' })] });
    await say(`cancel my appointment with ${target.patientName}, the clinic is closed`);
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'appointment_cancel');
    expect(byId(target.id).status).not.toBe('Cancelled'); // not before the yes
    // The dialog is the confirmation — no second card in the assistant panel.
    expect(document.querySelector('.va-card.is-confirm')).toBeNull();

    model.calls([call('confirm_pending_action')], 'Cancelled.');
    await say('yes');
    await waitUntil(() => byId(target.id).status === 'Cancelled');
    expect(byId(target.id).cancellationNote).toBe('The clinic is closed');
  }, TIMEOUT);

  it('through the assistant: reschedule with a comment; a slot where I am already booked is refused', async () => {
    // Two appointments of mine, booked for this test on free days ahead.
    const patients = patientSelectors.selectAll(store.getState());
    const book = (i: number, date: string, startTime: string) =>
      store
        .dispatch(
          appointmentsSlice.create({
            code: `APT-T${i}`, patientId: patients[i].id, patientName: patients[i].fullName, patientMrn: patients[i].mrn, providerId: me().id, providerName: me().fullName,
            date, startTime, endTime: dayjs(`2000-01-01T${startTime}`).add(30, 'minute').format('HH:mm'), durationMinutes: 30, type: 'Follow-up', locationId: 'loc-1',
            locationName: 'Riverside Medical Center', status: 'Scheduled', reason: 'Review', priority: 'Routine', createdAt: new Date().toISOString(), isTelehealth: false, reminderSent: false,
          } as never),
        )
        .unwrap() as Promise<Appointment>;
    const day = dayjs().add(40, 'day').format('YYYY-MM-DD');
    const target = await book(10, day, '07:10');
    const other = await book(11, day, '07:50');
    await renderAppAt('/schedule', () => !!row(target.id));

    // Onto another of my appointments: a double booking — refused, nothing staged.
    model.then({ calls: [call('reschedule_my_appointment', { appointment: target.id, to_date: other.date, to_time: other.startTime, comment: 'Patient asked' })] });
    await say('move it onto the other slot, the patient asked');
    expect(model.lastToolResults()[0].message).toMatch(/Not bookable: .*already/);
    expect(store.getState().voice.pendingConfirmation).toBeNull();

    // A free evening slot a few days out.
    const free = dayjs(target.date).add(3, 'day').format('YYYY-MM-DD');
    model.then({ calls: [call('reschedule_my_appointment', { appointment: target.id, to_date: free, to_time: '21:40', comment: 'Patient asked for an evening slot' })] });
    await say('then move it to three days later at 9:40 pm, the patient asked for an evening slot');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'appointment_reschedule');
    model.calls([call('confirm_pending_action')], 'Moved.');
    await say('yes');
    await waitUntil(() => byId(target.id).date === free);
    const moved = byId(target.id);
    expect(moved.startTime).toBe('21:40');
    expect(moved.rescheduleHistory?.at(-1)).toMatchObject({ fromDate: target.date, fromTime: target.startTime, toDate: free, toTime: '21:40', comment: 'Patient asked for an evening slot' });
    expect(moved.patientNotices!.at(-1)!.message).toMatch(/has been moved from .* to .*9:40 PM\. Reason: Patient asked for an evening slot/);
    await waitUntil(() => !!row(target.id)?.querySelector('.appt-flag'));
    expect(row(target.id)!.querySelector('.appt-flag')!.textContent).toContain('Rescheduled');
    expect(row(target.id)!.textContent).toContain('Reschedule note:');
    expect(row(target.id)!.textContent).toContain('Patient asked for an evening slot');
  }, TIMEOUT);

  it('adding a record by voice shows no confirmation card in the assistant panel — the form is where it is reviewed and saved', async () => {
    store.dispatch(setCurrentPatient(changeable().patientId));
    await renderAppAt('/summary/diagnosis');
    model.then({ calls: [call('add_diagnoses', { diagnoses: [{ description: 'Hypertension' }] })] });
    await say('add hypertension');
    await waitUntil(() => store.getState().voice.pendingConfirmation?.kind === 'form');
    expect(pageText()).toContain('Add Diagnosis');
    expect(document.querySelector('.va-card.is-confirm')).toBeNull();
  }, TIMEOUT);

  describe("the patient's Appointments tab (Summary)", () => {
    /** An upcoming appointment of one patient, with any provider, booked for this test. */
    const bookFor = async (i: number, date: string, startTime: string) => {
      const patient = patientSelectors.selectAll(store.getState())[i];
      const created = (await store
        .dispatch(
          appointmentsSlice.create({
            code: `APT-P${i}`, patientId: patient.id, patientName: patient.fullName, patientMrn: patient.mrn, providerId: me().id, providerName: me().fullName,
            date, startTime, endTime: dayjs(`2000-01-01T${startTime}`).add(30, 'minute').format('HH:mm'), durationMinutes: 30, type: 'Follow-up', locationId: 'loc-1',
            locationName: 'Riverside Medical Center', status: 'Scheduled', reason: 'Blood pressure review', priority: 'Routine', createdAt: new Date().toISOString(), isTelehealth: false, reminderSent: false,
          } as never),
        )
        .unwrap()) as Appointment;
      store.dispatch(setCurrentPatient(patient.id));
      return created;
    };
    /** The grid row of an appointment on the tab. */
    const tabRow = (_a: Appointment) => [...document.querySelectorAll('.record-tab tr, .record-tab .mobile-card')].find((r) => r.textContent?.includes('Blood pressure review') && r.textContent?.includes('Reschedule')) as HTMLElement | undefined;

    it('by mouse: Cancel on the row asks for a note; the grid then shows the Cancelled flag, the note, and that the patient was told', async () => {
      const a = await bookFor(17, dayjs().add(41, 'day').format('YYYY-MM-DD'), '08:10');
      await renderAppAt('/summary/appointment', () => !!tabRow(a));
      buttonIn(tabRow(a)!, 'Cancel').click();
      await waitUntil(() => !!document.querySelector('#cancellationNote'));
      type(document.querySelector('#cancellationNote') as HTMLTextAreaElement, 'Doctor on leave');
      await wait(60);
      buttonIn(document.querySelector('.app-modal')!.closest('.ant-modal')!, 'Cancel appointment').click();
      await waitUntil(() => byId(a.id).status === 'Cancelled');
      await waitUntil(() => !!document.querySelector('.record-tab .appt-flag'));
      const text = document.querySelector('.record-tab')!.textContent!;
      expect(text).toContain('Cancellation note: Doctor on leave');
      expect(text).toMatch(/Patient told by (SMS|Email)/);
      expect(byId(a.id).patientNotices!.at(-1)!.message).toContain('Reason: Doctor on leave');
    }, TIMEOUT);

    it("through the assistant: reschedule the selected patient's appointment with a comment; the tab shows the Rescheduled flag and note", async () => {
      const a = await bookFor(18, dayjs().add(42, 'day').format('YYYY-MM-DD'), '08:40');
      await renderAppAt('/summary/appointment', () => !!tabRow(a));
      const to = dayjs().add(44, 'day').format('YYYY-MM-DD');
      model.then({ calls: [call('reschedule_patient_appointment', { appointment: a.id, to_date: to, to_time: '09:20', comment: 'Lab results not back yet' })] });
      await say('move her appointment two days later at 9:20, the lab results are not back yet');
      await waitUntil(() => store.getState().voice.pendingConfirmation?.formId === 'appointment_reschedule');
      model.calls([call('confirm_pending_action')], 'Moved.');
      await say('yes');
      await waitUntil(() => byId(a.id).date === to);
      await waitUntil(() => !!document.querySelector('.record-tab .appt-flag'));
      const text = document.querySelector('.record-tab')!.textContent!;
      expect(text).toContain('Rescheduled');
      expect(text).toContain('Reschedule note:');
      expect(text).toContain('Lab results not back yet');
      expect(byId(a.id).patientNotices!.at(-1)!.kind).toBe('rescheduled');
    }, TIMEOUT);

    it('an appointment is never moved or cancelled by editing it — the assistant is sent to Reschedule / Cancel, and the edit form locks date, time and status', async () => {
      const a = await bookFor(19, dayjs().add(43, 'day').format('YYYY-MM-DD'), '10:10');
      await renderAppAt('/summary/appointment', () => !!tabRow(a));
      model.then({ calls: [call('update_record', { kind: 'appointment', record: a.id, changes: { date: dayjs().add(45, 'day').format('YYYY-MM-DD') } })] }, { content: 'Use reschedule.' });
      // The provider names the appointment and the new date — what the model sends must come from them.
      await say(`change the date of that follow-up appointment to ${dayjs().add(45, 'day').format('D MMMM YYYY')}`);
      expect(model.lastToolResults()[0].message).toMatch(/moved or cancelled with a reason/);
      expect(byId(a.id).date).toBe(a.date);

      tabRow(a)!.click(); // the row opens the edit form
      await waitUntil(() => pageText().includes('Edit Appointment'));
      expect((document.querySelector('.ant-modal #date') as HTMLInputElement).disabled).toBe(true);
      expect(pageText()).toContain('To move it, use Reschedule');
    }, TIMEOUT);
  });
});
