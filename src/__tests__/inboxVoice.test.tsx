/**
 * The Inbox, operated through the assistant in the real application. A
 * scripted model makes the tool calls; the real Inbox page carries them out:
 * find and select a patient, open the Inbox on them, change category, open
 * records by position, file and unfile with a confirmation, step to the next
 * record — and sign out, which must leave no patient and no conversation behind.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { store } from '@/store';
import { router } from '@/app/router';
import { login, logout } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchInbox, inboxActions } from '@/store/slices/inboxSlice';
import { voiceActions } from '@/store/slices/voiceSlice';
import { InboxVoiceRegistry, setConfirmFiling } from '@/services/inbox/inboxVoice';
import { call, type ScriptedLLM } from '@/services/ai/__tests__/fakes';
import { installBrowserStubs, pageText, renderAppAt, say, unmountApp, useScriptedModel, wait, waitUntil } from './harness';

const TIMEOUT = 60000;
let model: ScriptedLLM;

beforeAll(installBrowserStubs);
afterEach(unmountApp);

beforeEach(async () => {
  setConfirmFiling(true);
  store.dispatch(voiceActions.resetVoice());
  store.dispatch(inboxActions.markUnreviewed(store.getState().inbox.reviewedIds));
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchInbox()).unwrap();
  model = useScriptedModel();
});

const liam = () => patientSelectors.selectAll(store.getState()).find((p) => p.fullName === 'Liam Thompson')!;
const inbox = () => InboxVoiceRegistry.get()!;
const openItemId = () => new URLSearchParams(router.state.location.search).get('item');

describe('patient context and sign-in', () => {
  it('a new sign-in starts with no patient, and signing out clears the selection', async () => {
    store.dispatch(setCurrentPatient(liam().id));
    await store.dispatch(logout()).unwrap();
    expect(store.getState().patients.currentPatientId).toBeNull();
    expect(localStorage.getItem('careflow.selectedPatientId')).toBeNull();

    store.dispatch(setCurrentPatient(liam().id));
    await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
    expect(store.getState().patients.currentPatientId).toBeNull();
    expect(store.getState().patients.recentPatientIds).toEqual([]);
  }, TIMEOUT);

  it('only provider accounts can sign in', async () => {
    await store.dispatch(logout()).unwrap();
    const admin = await store.dispatch(login({ username: 'mreed', password: 'demo' }));
    expect(admin.meta.requestStatus).toBe('rejected');
    expect(store.getState().auth.error).toMatch(/not a provider account/);
    const unknown = await store.dispatch(login({ username: 'nobody', password: 'demo' }));
    expect(unknown.meta.requestStatus).toBe('rejected');
  }, TIMEOUT);

  it('signing out ends the assistant and forgets the conversation', async () => {
    store.dispatch(setCurrentPatient(liam().id));
    await renderAppAt('/inbox/all', () => !!InboxVoiceRegistry.get());
    model.calls([call('inbox_open_item', { target: 1 })], 'Opened it.');
    await say('open the first record');
    expect(store.getState().voice.history.length).toBeGreaterThan(0);

    await store.dispatch(logout()).unwrap();
    await waitUntil(() => pageText().includes('Sign in'));
    expect(store.getState().patients.currentPatientId).toBeNull();
    expect(store.getState().voice.history).toEqual([]);
    expect(store.getState().voice.micActive).toBe(false);
    expect(store.getState().voice.pendingConfirmation).toBeNull();
  }, TIMEOUT);
});

describe('the Inbox through the assistant', () => {
  it('patient → Inbox → category → record → file → unfile → next → close', async () => {
    await renderAppAt('/patients', () => pageText().includes('Add patient'));
    expect(store.getState().patients.currentPatientId).toBeNull();

    // Patient: search, then select by position in the list on screen.
    model.calls([call('search_patients', { query: 'Liam Thompson' })], 'Found Liam Thompson.');
    await say('find Liam Thompson');
    await waitUntil(() => router.state.location.search.includes('q='));
    expect((model.lastToolResults()[0].data as Array<{ name: string }>)[0].name).toBe('Liam Thompson');
    model.calls([call('select_patient', { list_position: 1 })], 'Liam Thompson selected.');
    await say('open the first one');
    await waitUntil(() => store.getState().patients.currentPatientId === liam().id);

    // The Inbox opens on that patient.
    model.calls([call('inbox_show', { category: 'all' })], 'Here is the Inbox.');
    await say('open my inbox');
    await waitUntil(() => !!InboxVoiceRegistry.get() && !inbox().snapshot().loading);
    expect(router.state.location.pathname).toBe('/inbox/all');
    expect(new URLSearchParams(router.state.location.search).get('patient')).toBe(liam().id);
    expect(inbox().snapshot().items.every((i) => i.patientId === liam().id)).toBe(true);

    model.calls([call('inbox_show', { category: 'lab' })], 'Showing lab results.');
    await say('show the lab results');
    await waitUntil(() => router.state.location.pathname === '/inbox/lab');
    expect(inbox().snapshot().view).toBe('lab');

    // A record by position — its content goes back to the model.
    const first = inbox().snapshot().items[0];
    model.calls([call('inbox_open_item', { target: 1 })], 'Opened the first result.');
    await say('open the first one');
    await waitUntil(() => openItemId() === first.id);
    expect((model.lastToolResults()[0].data as { subject: string }).subject).toBe(first.subject);

    // File: staged, shown, and done only after the user's yes.
    model.then({ calls: [call('inbox_file_item', { file: true })] });
    await say('file this');
    expect(store.getState().voice.pendingConfirmation?.kind).toBe('inbox_file');
    expect(pageText()).toContain('File this record?');
    expect(store.getState().inbox.reviewedIds).not.toContain(first.id);
    model.calls([call('confirm_pending_action')], 'Filed.');
    await say('yes');
    await waitUntil(() => store.getState().inbox.reviewedIds.includes(first.id));

    model.then({ calls: [call('inbox_file_item', { file: false })] });
    await say('unfile it');
    model.calls([call('confirm_pending_action')], 'Moved back.');
    await say('yes');
    await waitUntil(() => !store.getState().inbox.reviewedIds.includes(first.id));

    const second = inbox().snapshot().items[1];
    if (second) {
      model.calls([call('inbox_open_item', { target: 'next' })], 'Next one.');
      await say('next');
      await waitUntil(() => openItemId() === second.id);
    }

    model.calls([call('go_back')], 'Closed.');
    await say('close it');
    await waitUntil(() => !openItemId());

    model.calls([call('stop_listening')], 'Microphone off.');
    await say('stop listening');
    expect(store.getState().voice.micActive).toBe(false);
  }, TIMEOUT);

  it('files any patient\'s record — with nobody selected, or someone else', async () => {
    for (const selected of [null, liam().id]) {
      await unmountApp();
      store.dispatch(inboxActions.markUnreviewed(store.getState().inbox.reviewedIds));
      store.dispatch(setCurrentPatient(selected));
      setConfirmFiling(false);
      await renderAppAt('/inbox/all', () => !!InboxVoiceRegistry.get());
      await waitUntil(() => !inbox().snapshot().loading);
      const target = inbox().snapshot().items.find((i) => i.patientId !== liam().id)!;
      const position = inbox().snapshot().items.indexOf(target) + 1;
      model.then({ calls: [call('inbox_open_item', { target: position })] }, { calls: [call('inbox_file_item', { file: true })] }, { content: 'Filed.' });
      await say(`file record number ${position}`);
      await waitUntil(() => store.getState().inbox.reviewedIds.includes(target.id));
      expect(model.lastToolResults().at(-1)?.message).toBe(`Filed "${target.subject}" for ${target.patientName}.`);
      expect(store.getState().patients.currentPatientId).toBe(selected); // nobody was selected for it
    }
  }, TIMEOUT);

  it('explains a position that is not in the list', async () => {
    store.dispatch(setCurrentPatient(liam().id));
    await renderAppAt(`/inbox/referral?patient=${liam().id}`, () => !!InboxVoiceRegistry.get());
    await waitUntil(() => !inbox().snapshot().loading);
    const count = inbox().snapshot().items.length;
    model.calls([call('inbox_open_item', { target: count + 1 })], 'There are not that many.');
    await say(`open record number ${count + 1}`);
    expect(openItemId()).toBeNull();
    expect(model.lastToolResults()[0].message).toMatch(/There is no .* record — the list has/);
  }, TIMEOUT);

  it('every patient\'s records, whoever is selected — one patient only through the patient filter', async () => {
    const patientIds = () => new Set(inbox().snapshot().items.map((i) => i.patientId));
    const filter = () => document.querySelector('.ibx-patient-filter') as HTMLElement;

    // A patient selected elsewhere changes nothing: every patient's records are listed.
    store.dispatch(setCurrentPatient(liam().id));
    await renderAppAt('/inbox/all', () => !!document.querySelector('.ibx-msg'));
    expect(patientIds().size).toBeGreaterThan(1);
    expect(filter()).not.toBeNull();
    expect(filter().textContent).toContain('All patients');

    // The filter: one patient's records — chosen from the list, typed to find them.
    filter().querySelector('.ant-select-selector')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    const option = () => [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.textContent?.includes('Liam Thompson')) as HTMLElement | undefined;
    await waitUntil(() => !!option());
    option()!.click();
    await waitUntil(() => patientIds().size === 1);
    expect([...patientIds()]).toEqual([liam().id]);

    // Selecting someone else elsewhere does not move the filter.
    store.dispatch(setCurrentPatient(null));
    await wait(200);
    expect([...patientIds()]).toEqual([liam().id]);

    // Cleared: every patient's again.
    (filter().querySelector('.ant-select-clear') as HTMLElement | null)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    (filter().querySelector('.ant-select-clear') as HTMLElement | null)?.click();
    await waitUntil(() => patientIds().size > 1);
    expect(patientIds().size).toBeGreaterThan(1);
  }, TIMEOUT);

  it('every Inbox record is Abnormal or Normal — nothing else', async () => {
    const items = store.getState().inbox.items;
    expect(new Set(items.map((i) => i.status))).toEqual(new Set(['Abnormal', 'Normal']));
    // Every kind of record can be abnormal, not only lab results.
    expect(new Set(items.filter((i) => i.status === 'Abnormal').map((i) => i.category))).toEqual(new Set(['lab', 'radiology', 'referral', 'discharge']));
    // Exactly 25: Lab 7, Radiology 6, Referrals 6, Discharge 6 — 13 normal, 12 abnormal.
    expect(items).toHaveLength(25);
    expect(items.filter((i) => i.status === 'Normal')).toHaveLength(13);
    expect(items.filter((i) => i.status === 'Abnormal')).toHaveLength(12);
    const count = (c: string) => items.filter((i) => i.category === c).length;
    expect([count('lab'), count('radiology'), count('referral'), count('discharge')]).toEqual([7, 6, 6, 6]);
  });

  it('"Add comment hello world to all abnormal records": added at once, no confirmation, and the reply says how many', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/dashboard', () => pageText().length > 0);
    const count = (id: string, text: string) => (store.getState().inbox.comments[id] ?? []).filter((c) => c.text === text).length;
    for (const which of ['abnormal', 'normal'] as const) {
      const text = `hello world ${which}`;
      const matching = store.getState().inbox.items.filter((i) => i.status === (which === 'abnormal' ? 'Abnormal' : 'Normal'));
      expect(matching.length).toBeGreaterThan(1);

      model.calls([call('inbox_add_comment', { text, which })], `Added to ${matching.length} records.`);
      await say(`Add comment ${text} to all ${which} records`);
      await waitUntil(() => matching.every((i) => count(i.id, text) === 1));
      expect(store.getState().voice.pendingConfirmation).toBeNull();
      expect(model.lastToolResults()[0].message).toBe(`Comment "${text}" added to ${matching.length} ${which} records.`);
      // Nothing else was commented on.
      const others = store.getState().inbox.items.filter((i) => !matching.includes(i));
      expect(others.every((i) => count(i.id, text) === 0)).toBe(true);
    }
    const abnormal = store.getState().inbox.items.filter((i) => i.status === 'Abnormal');
    expect(store.getState().inbox.comments[abnormal[0].id].at(-1)?.author).not.toBe('You'); // signed by the provider

    // The comment shows on the record (every record now has one of the two).
    model.calls([call('inbox_open_item', { target: 1 })], 'Opened.');
    await say('open the first record');
    await waitUntil(() => !!openItemId());
    const opened = openItemId()!;
    await waitUntil(() => pageText().includes(abnormal.some((i) => i.id === opened) ? 'hello world abnormal' : 'hello world normal'));
  }, TIMEOUT);

  it('keeps mouse filing exactly as it was', async () => {
    store.dispatch(setCurrentPatient(liam().id));
    await renderAppAt('/inbox/all', () => !!document.querySelector('.ibx-msg'));
    (document.querySelector('.ibx-msg') as HTMLElement).click();
    await waitUntil(() => !!openItemId());
    const id = openItemId()!;
    const fileButton = Array.from(document.querySelectorAll('.ibx-dbar-actions button')).find((b) => b.textContent?.trim() === 'File') as HTMLButtonElement;
    fileButton.click();
    await waitUntil(() => store.getState().inbox.reviewedIds.includes(id));
    expect(store.getState().inbox.reviewedIds).toContain(id);
    // No assistant confirmation is involved in a click.
    expect(store.getState().voice.pendingConfirmation).toBeNull();
  }, TIMEOUT);
});
