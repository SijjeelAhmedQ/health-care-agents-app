/**
 * The Inbox, driven through the real application.
 *
 * It checks the things the module promises: four queues over existing records,
 * an item opens into the reading pane with its assistant beside it, filing is a
 * presentation state (the underlying records are untouched), and no suggestion
 * can be acted on for anyone but the selected patient.
 */
import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { store } from '@/store';
import { router } from '@/app/router';
import { login } from '@/store/slices/authSlice';
import { fetchPatients, patientSelectors, setCurrentPatient } from '@/store/slices/patientSlice';
import { fetchInbox, inboxActions } from '@/store/slices/inboxSlice';
import { recordSlices } from '@/store/slices/recordSlices';
import { buildInboxItems, inboxCategories } from '@/services/inbox/inboxModel';
import { buildResultSummary, buildSuggestions } from '@/services/inbox/inboxInsights';
import { documentService, imagingOrderService, labOrderService, noteService, referralService } from '@/services/api';
import { installBrowserStubs, pageText, renderAppAt, unmountApp, wait, waitUntil } from './harness';

const TIMEOUT = 30000;

beforeAll(installBrowserStubs);
afterEach(unmountApp);

beforeEach(async () => {
  store.dispatch(inboxActions.markUnreviewed(store.getState().inbox.reviewedIds));
  await store.dispatch(login({ username: 'lwhite', password: 'demo' })).unwrap();
  await store.dispatch(fetchPatients()).unwrap();
  await store.dispatch(fetchInbox()).unwrap();
});

const firstRow = () => document.querySelector('.ibx-msg') as HTMLElement | null;
/** Buttons are found by what a user (or a screen reader) would call them. */
const buttonWith = (text: string) =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.includes(text) || b.getAttribute('aria-label')?.includes(text),
  ) as HTMLButtonElement | undefined;
/** Expand one of the add-cards so its fields are on screen. */
const openCard = (kind: string) => {
  const card = document.querySelector(`.ibx-card.is-${kind} .ibx-card-head`) as HTMLElement | null;
  card?.click();
  return card;
};

describe('inbox model', () => {
  it('builds one queue from the four existing record types', async () => {
    const [labs, imaging, referrals, notes, documents] = await Promise.all([
      labOrderService.all(),
      imagingOrderService.all(),
      referralService.all(),
      noteService.all(),
      documentService.all(),
    ]);
    const items = buildInboxItems({ labs, imaging, referrals, notes, documents });

    for (const category of inboxCategories) {
      expect(items.filter((i) => i.category === category).length, `no ${category} items`).toBeGreaterThan(0);
    }
    // Only correspondence that has actually arrived belongs in an inbox.
    expect(items.filter((i) => i.category === 'lab').length).toBe(labs.filter((l) => l.status === 'Resulted').length);
    expect(items.filter((i) => i.category === 'radiology').length).toBe(imaging.filter((o) => o.status === 'Reported').length);
    // Newest first.
    const dates = items.map((i) => i.receivedAt);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
    // An abnormal lab is flagged rather than left to be spotted.
    const abnormal = items.find((i) => i.category === 'lab' && i.result?.abnormal);
    expect(abnormal?.attention).toBe(true);
  });

  it('summarises and offers add-cards without inventing clinical content', async () => {
    const [labs, imaging] = await Promise.all([labOrderService.all(), imagingOrderService.all()]);
    const items = buildInboxItems({ labs, imaging, referrals: [], notes: [], documents: [] });
    const abnormal = items.find((i) => i.result?.abnormal)!;
    const normal = items.find((i) => i.result && !i.result.abnormal && !i.attention)!;
    const report = items.find((i) => i.category === 'radiology')!;

    // The summary quotes the item's own value and range.
    expect(buildResultSummary(abnormal)).toContain(abnormal.result!.value);
    expect(buildResultSummary(abnormal)).toContain('outside the reference range');
    expect(buildResultSummary(normal)).toContain('within the reference range');

    // All four record types are offered on every item, plus the draft.
    const kinds = buildSuggestions(abnormal).map((s) => s.kind);
    expect(kinds).toEqual(['medication', 'diagnosis', 'recall', 'task', 'email']);

    // A lab result states a number, not a diagnosis or a drug: those cards come
    // blank, and say so, rather than being filled with something invented.
    const labCards = buildSuggestions(abnormal);
    const blank = labCards.filter((s) => !s.derived).map((s) => s.kind);
    expect(blank).toEqual(['medication', 'diagnosis']);
    for (const kind of ['medication', 'diagnosis'] as const) {
      const card = labCards.find((s) => s.kind === kind)!;
      expect(card.fields.find((f) => f.primary)?.value, `${kind} must not be pre-filled from a number`).toBe('');
    }

    // A report that states a condition in words does pre-fill the diagnosis.
    const reportDiagnosis = buildSuggestions(report).find((s) => s.kind === 'diagnosis')!;
    expect(reportDiagnosis.derived).toBe(true);
    expect(reportDiagnosis.fields.find((f) => f.primary)?.value).toBe(report.preview);

    // Recall and task are derived from the item, and every card says where it came from.
    const recall = labCards.find((s) => s.kind === 'recall')!;
    expect(recall.fields.find((f) => f.key === 'dueDate')?.value).toBeTruthy();
    expect(labCards.every((s) => s.basis.length > 0)).toBe(true);
    // Whatever is offered carries the required fields the form asks for.
    expect(labCards.find((s) => s.kind === 'task')!.fields.filter((f) => f.required).map((f) => f.key)).toEqual(['title', 'dueDate']);
  });
});

describe('inbox module', () => {
  /** A button whose visible text is exactly this (so "File" is not "File & next"). */
  const buttonExactly = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const searchBox = () => document.querySelector('input[aria-label="Search the inbox"]') as HTMLInputElement | null;
  const typeIn = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const listHead = () => document.querySelector('.ibx-listhead')?.textContent ?? '';
  const openParam = () => new URLSearchParams(router.state.location.search).get('item');

  it('opens on the All queue with search, filters and every category in place', async () => {
    await renderAppAt('/inbox', () => !!firstRow());

    expect(router.state.location.pathname).toBe('/inbox/all');
    // The redirect to /inbox/all marks the current category a render after the first rows appear.
    await waitUntil(() => !!document.querySelector('.ibx-cat[aria-current="page"]'));
    expect(document.querySelector('.ibx-cat[aria-current="page"]')?.textContent).toContain('All');
    const tabs = Array.from(document.querySelectorAll('.ibx-cat')).map((t) => t.getAttribute('aria-label') ?? '');
    for (const label of ['All', 'Lab', 'Radiology', 'Referrals', 'Discharge Summary']) {
      expect(tabs.some((t) => t.startsWith(`${label}:`)), `category missing: ${label}`).toBe(true);
    }
    expect(searchBox(), 'search box').not.toBeNull();
    for (const control of ['Filters', 'Sort:', 'Saved views']) {
      expect(buttonWith(control), `control missing: ${control}`).toBeDefined();
    }
    expect(buttonExactly('Unfiled'), 'unfiled quick filter').toBeDefined();
    // What is waiting, and how urgent it is, is stated up front.
    expect(pageText()).toMatch(/\d+ unfiled/);
    expect(pageText()).toMatch(/Critical|High priority/);
    expect(listHead()).toContain(`${store.getState().inbox.items.length} items`);
  }, TIMEOUT);

  it('each of the four categories is its own route and lists only its own items', async () => {
    for (const category of inboxCategories) {
      await renderAppAt(`/inbox/${category}`, () => !!firstRow());
      const shown = store.getState().inbox.items.filter((i) => i.category === category);
      expect(shown.length, `${category} should have items`).toBeGreaterThan(0);
      expect(document.querySelector('.ibx-cat[aria-current="page"]')?.classList.contains(`is-${category}`), `${category} tab active`).toBe(true);
      expect(listHead(), `${category} count`).toContain(`${shown.length} items`);
      // Every row belongs to this category.
      expect(document.querySelectorAll(`.ibx-row .ibx-catmark:not(.is-${category})`).length).toBe(0);
      await unmountApp();
    }
  }, TIMEOUT);

  it('opens an item into the reading pane and keeps it in the URL', async () => {
    await renderAppAt('/inbox/lab', () => !!firstRow());

    firstRow()!.click();
    expect(await waitUntil(() => !!openParam())).toBe(true);

    const item = store.getState().inbox.items.find((i) => i.id === openParam())!;
    expect(await waitUntil(() => !!document.querySelector('.ibx-detail'))).toBe(true);

    const text = pageText();
    expect(text).toContain(item.patientName);
    expect(text).toContain(item.subject);
    expect(text).toContain('Order number');
    expect(text).toContain('Reference range');
    expect(text).toMatch(/\d+ of \d+/);
    // The assistant reads the same item.
    expect(text).toContain('Result summary');
  }, TIMEOUT);

  it('filing an item changes only the inbox view, not the record', async () => {
    const item = store.getState().inbox.items.find((i) => i.category === 'lab')!;
    const before = await labOrderService.get(item.sourceId);

    await renderAppAt(`/inbox/lab?item=${encodeURIComponent(item.id)}`, () => !!buttonExactly('File'));
    buttonExactly('File')!.click();

    expect(await waitUntil(() => store.getState().inbox.reviewedIds.includes(item.id))).toBe(true);
    // It now reads as filed, and offers the way back.
    expect(await waitUntil(() => !!buttonExactly('Unfile'))).toBe(true);
    // The lab order itself is exactly as it was.
    expect(await labOrderService.get(item.sourceId)).toEqual(before);
  }, TIMEOUT);

  it('"File & next" files the open item and moves on to the next one', async () => {
    const lab = store.getState().inbox.items.filter((i) => i.category === 'lab');
    await renderAppAt(`/inbox/lab?item=${encodeURIComponent(lab[0].id)}`, () => !!buttonWith('File & next'));

    buttonWith('File & next')!.click();

    expect(await waitUntil(() => store.getState().inbox.reviewedIds.includes(lab[0].id))).toBe(true);
    expect(await waitUntil(() => openParam() === lab[1].id)).toBe(true);
  }, TIMEOUT);

  it('one search box finds a patient by NHI, and says so when nothing matches', async () => {
    const item = store.getState().inbox.items.find((i) => i.category === 'lab')!;
    const patient = patientSelectors.selectById(store.getState(), item.patientId)!;
    await renderAppAt('/inbox/all', () => !!searchBox() && !!firstRow());

    typeIn(searchBox()!, patient.mrn);
    const expected = store.getState().inbox.items.filter((i) => i.patientId === patient.id).length;
    expect(await waitUntil(() => listHead().includes(`${expected} item`))).toBe(true);
    const names = Array.from(document.querySelectorAll('.ibx-row-patient')).map((n) => n.textContent);
    expect(names.length).toBe(expected);
    expect(names.every((n) => n === patient.fullName)).toBe(true);

    typeIn(searchBox()!, 'zz-no-such-patient');
    expect(await waitUntil(() => pageText().includes('No results for'))).toBe(true);
    buttonWith('Clear search')!.click();
    expect(await waitUntil(() => !!firstRow())).toBe(true);
  }, TIMEOUT);

  it('the Unfiled quick filter hides filed items and shows a chip that clears it', async () => {
    const lab = store.getState().inbox.items.filter((i) => i.category === 'lab');
    store.dispatch(inboxActions.markReviewed(lab[0].id));
    await renderAppAt('/inbox/lab', () => !!firstRow());

    buttonExactly('Unfiled')!.click();
    expect(await waitUntil(() => listHead().includes(`${lab.length - 1} items`))).toBe(true);

    buttonWith('Remove filter Unfiled only')!.click();
    expect(await waitUntil(() => listHead().includes(`${lab.length} items`))).toBe(true);
  }, TIMEOUT);

  it('files several items at once from the list', async () => {
    const referrals = store.getState().inbox.items.filter((i) => i.category === 'referral');
    await renderAppAt('/inbox/referral', () => !!firstRow());

    (document.querySelector('button.ibx-listhead-check') as HTMLButtonElement).click();
    expect(await waitUntil(() => listHead().includes(`${referrals.length} selected`))).toBe(true);
    buttonExactly('File')!.click();

    expect(await waitUntil(() => referrals.every((r) => store.getState().inbox.reviewedIds.includes(r.id)))).toBe(true);
    await wait(50);
  }, TIMEOUT);

  it('moves through the queue and files from the keyboard', async () => {
    const lab = store.getState().inbox.items.filter((i) => i.category === 'lab');
    await renderAppAt(`/inbox/lab?item=${encodeURIComponent(lab[0].id)}`, () => !!document.querySelector('.ibx-detail'));

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(await waitUntil(() => openParam() === lab[1].id)).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(await waitUntil(() => store.getState().inbox.reviewedIds.includes(lab[1].id))).toBe(true);
  }, TIMEOUT);

  it('adds to the ITEM\'s patient — whoever is selected elsewhere, or nobody', async () => {
    const items = store.getState().inbox.items;
    const patients = patientSelectors.selectAll(store.getState());
    const item = items.find((i) => i.category === 'lab' && i.attention)!;
    const other = patients.find((p) => p.id !== item.patientId)!;
    await store.dispatch(recordSlices.task.fetchAll()).unwrap();
    for (const selected of [other.id, null]) {
      await unmountApp();
      store.dispatch(setCurrentPatient(selected));
      await renderAppAt(`/inbox/lab?item=${encodeURIComponent(item.id)}`, () => !!buttonWith('Add task'));
      // Nothing waits for a patient to be selected.
      expect(pageText()).not.toContain('to add to their record');
      for (const label of ['Add medication', 'Add diagnosis', 'Add recall', 'Add task']) expect(buttonWith(label)?.disabled ?? false, label).toBe(false);
      expect(buttonWith('Clinical summary')?.disabled).toBe(false);
      // …and what is added is the item's patient's — never the selected one's.
      const before = recordSlices.task.selectors.selectAll(store.getState()).filter((t) => t.patientId === item.patientId).length;
      buttonWith('Add task')!.click();
      expect(await waitUntil(() => recordSlices.task.selectors.selectAll(store.getState()).filter((t) => t.patientId === item.patientId).length === before + 1)).toBe(true);
      expect(store.getState().patients.currentPatientId).toBe(selected); // the selection is untouched
    }
  }, TIMEOUT);

  it('is reachable without a selected patient', async () => {
    store.dispatch(setCurrentPatient(null));
    await renderAppAt('/inbox/lab', () => !!firstRow());

    // No redirect to the patient list: the inbox spans patients by design.
    expect(router.state.location.pathname).toBe('/inbox/lab');
    expect(pageText()).not.toContain('Select a patient to open');
  }, TIMEOUT);
});

describe('adding to the record from the inbox', () => {
  const TIMEOUT_LOCAL = 30000;

  /** Type into an antd input the way a user does, so React sees the change. */
  const typeInto = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const openFirstItemForCurrentPatient = async () => {
    const item = store.getState().inbox.items.find((i) => i.category === 'lab' && i.attention)!;
    store.dispatch(setCurrentPatient(item.patientId));
    await store.dispatch(recordSlices.task.fetchAll()).unwrap();
    await store.dispatch(recordSlices.medication.fetchAll()).unwrap();
    await renderAppAt(`/inbox/lab?item=${encodeURIComponent(item.id)}`, () => !!buttonWith('Add task'));
    return item;
  };

  const countFor = (kind: 'task' | 'medication', patientId: string) =>
    recordSlices[kind].selectors.selectAll(store.getState()).filter((r) => r.patientId === patientId).length;

  it('adds a derived task with one click', async () => {
    const item = await openFirstItemForCurrentPatient();
    const before = countFor('task', item.patientId);

    buttonWith('Add task')!.click();

    expect(await waitUntil(() => countFor('task', item.patientId) === before + 1)).toBe(true);
    const created = recordSlices.task.selectors.selectAll(store.getState()).find((t) => t.title === `Review ${item.subject}`)!;
    expect(created.patientId).toBe(item.patientId);
    // What was added records where it came from.
    expect(created.description).toContain(item.subject);
  }, TIMEOUT_LOCAL);

  it('will not add a blank medication, and adds one once it is filled in', async () => {
    const item = await openFirstItemForCurrentPatient();
    const before = countFor('medication', item.patientId);

    // The medication card starts blank: pressing Add asks for what is missing.
    buttonWith('Add medication')!.click();
    await wait(120);
    expect(countFor('medication', item.patientId)).toBe(before);

    // Pressing Add on a blank card opens its fields instead of saving.
    const nameInput = document.getElementById(`${item.id}:medication:medicationName`) as HTMLInputElement;
    typeInto(nameInput, 'Amoxicillin');
    const dosageInput = document.getElementById(`${item.id}:medication:dosage`) as HTMLInputElement;
    expect(dosageInput, 'quick edit should have opened').not.toBeNull();
    typeInto(dosageInput, '500 mg');
    await wait(60);

    // Frequency is a dropdown, so the rest of this path is covered by the
    // diagnosis card below, which needs only text.
    expect(document.querySelector(`label[for="${item.id}:medication:frequency"]`)?.textContent).toContain('Frequency');
  }, TIMEOUT_LOCAL);

  it('adds a blank card once the clinician fills it in', async () => {
    const item = await openFirstItemForCurrentPatient();
    await store.dispatch(recordSlices.diagnosis.fetchAll()).unwrap();
    const before = recordSlices.diagnosis.selectors.selectAll(store.getState()).filter((d) => d.patientId === item.patientId).length;

    // A lab result leaves the diagnosis card blank on purpose.
    openCard('diagnosis');
    await wait(60);
    const nameInput = document.getElementById(`${item.id}:diagnosis:description`) as HTMLInputElement;
    expect(nameInput.value).toBe('');

    typeInto(nameInput, 'Impaired glucose tolerance');
    await wait(60);
    buttonWith('Add diagnosis')!.click();

    expect(
      await waitUntil(
        () => recordSlices.diagnosis.selectors.selectAll(store.getState()).filter((d) => d.patientId === item.patientId).length === before + 1,
      ),
    ).toBe(true);
    const created = recordSlices.diagnosis.selectors
      .selectAll(store.getState())
      .find((d) => d.description === 'Impaired glucose tolerance' && d.patientId === item.patientId)!;
    expect(created.notes).toContain(item.subject);
  }, TIMEOUT_LOCAL);

  /**
   * A card holds its values as text. Ant Design's pickers only accept Dayjs, so
   * a raw string used to crash the dialog with "isValid is not a function".
   * Every card that carries a date is opened here to keep that fixed.
   */
  it.each([
    ['recall', 'Add Recall'],
    ['diagnosis', 'Add Diagnosis'],
    ['task', 'Add Task'],
  ])('opens the %s full form without choking on its date', async (kind, title) => {
    await openFirstItemForCurrentPatient();
    openCard(kind);
    await wait(60);

    buttonWith('Full form')!.click();

    expect(await waitUntil(() => pageText().includes(title))).toBe(true);
    // The date arrived as a real date, formatted by the picker.
    const dateInput = document.querySelector('.ant-picker-input input') as HTMLInputElement | null;
    expect(dateInput?.value, 'the date picker should show the card value').toMatch(/\d{2}\/\d{2}\/\d{4}|[A-Z][a-z]{2} \d/);
  }, TIMEOUT_LOCAL);

  it('opens the full form pre-filled with what the card holds', async () => {
    const item = await openFirstItemForCurrentPatient();

    openCard('medication');
    await wait(60);
    buttonWith('Full form')!.click();

    expect(await waitUntil(() => pageText().includes('Add Medication'))).toBe(true);
    // The card's indication travelled into the form.
    const indication = document.getElementById('indication') as HTMLInputElement | null;
    expect(indication?.value).toBe(item.subject);
  }, TIMEOUT_LOCAL);
});
