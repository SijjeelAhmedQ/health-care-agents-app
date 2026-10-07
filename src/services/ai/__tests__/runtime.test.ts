import { beforeEach, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import { AppRuntime, type RuntimeDeps, type RuntimeState } from '../agent/runtime';
import { FormRegistry, type FormController, type FormValue } from '@/registry/formRegistry';
import { NavigationRegistry } from '@/registry/navigationRegistry';
import { PageRegistry } from '@/registry/pageRegistry';
import { RecordRegistry } from '@/registry/recordRegistry';
import type { EntityKind, RecordKind } from '@/types/records';
import type { Medication, Patient, Provider, Task } from '@/types/domain';
import type { AnyRecord } from '@/services/records/recordMapping';
import { buildProviderWorkload } from '@/services/provider/providerWorkload';
import { ListRegistry } from '@/registry/listRegistry';
import type { SttConfig } from '@/services/ai/sttConfig';

/** Minimal in-memory form controller standing in for a mounted Ant Design form. */
/** Like the real record dialogs, a new record starts with the selected patient (Liam Thompson). */
const seedFor = (formId: string): Record<string, FormValue> => (formId === 'patient' ? {} : { patient: 'Liam Thompson (MRN-1)' });

function fakeForm(formId: string) {
  let open = false;
  let values: Record<string, FormValue> = {};
  const submit = vi.fn(async () => undefined);
  const controller: FormController = {
    formId,
    isOpen: () => open,
    open: () => { if (!open) values = { ...seedFor(formId), ...values }; open = true; },
    close: () => { open = false; values = {}; },
    getValues: () => values,
    setValues: (v) => { values = { ...values, ...v }; },
    clearField: (f) => { delete values[f]; },
    focusField: vi.fn(),
    validate: async () => [],
    submit,
    summarize: () => Object.entries(values).map(([label, value]) => ({ label, value: String(value) })),
  };
  const unregister = FormRegistry.register(controller);
  return { controller, submit, unregister, get values() { return values; } };
}

/** A tabbed form: several records, the active one addressed by the plain controller methods. */
function fakeMultiForm(formId: string) {
  let open = false;
  let items: Record<string, FormValue>[] = [{}];
  let active = 0;
  const submit = vi.fn(async () => undefined);
  const controller: FormController = {
    formId,
    isOpen: () => open,
    open: () => { if (!open) items[0] = { ...seedFor(formId), ...items[0] }; open = true; },
    close: () => { open = false; items = [{}]; active = 0; },
    getValues: () => items[active],
    setValues: (v) => { items[active] = { ...items[active], ...v }; },
    clearField: (f) => { delete items[active][f]; },
    focusField: vi.fn(),
    validate: async () => [],
    submit,
    summarize: () => items.map((it, i) => ({ label: `${i + 1}`, value: String(it.medicationName ?? '') })),
    entries: {
      count: () => items.length,
      active: () => active,
      setActive: (i) => { active = i; },
      add: (v) => { items.push({ ...seedFor(formId), ...v }); active = items.length - 1; return active; },
      getAll: () => items,
    },
  };
  const unregister = FormRegistry.register(controller);
  return { controller, submit, unregister, get items() { return items; } };
}

/** Stands in for a mounted record list (a Summary tab): it owns the create/edit dialog. */
function fakeList(kind: EntityKind, form: { controller: FormController }, saved: Record<string, Record<string, FormValue>> = {}) {
  const openCreate = vi.fn(() => form.controller.open());
  const openEdit = vi.fn((id: string) => {
    form.controller.open();
    form.controller.setValues(saved[id] ?? {}); // the edit dialog loads the record's saved values
    return true;
  });
  const setSearch = vi.fn();
  const unregister = RecordRegistry.register({ kind, openCreate, openEdit, setSearch });
  return { openCreate, openEdit, setSearch, unregister };
}

const PATIENT = { id: 'pat-1', fullName: 'Liam Thompson', mrn: 'MRN-1', age: 42, gender: 'Male', phone: '555-0100', dateOfBirth: '1984-01-10' } as Patient;
const TWINS = [
  { id: 'pat-2', fullName: 'Luke King', mrn: 'MRN-2', dateOfBirth: '1990-01-01' },
  { id: 'pat-3', fullName: 'Luke King', mrn: 'MRN-3', dateOfBirth: '1971-05-05' },
] as Patient[];

const MEDS = [
  { id: 'med-1', patientId: 'pat-1', name: 'Metformin', dosage: '850 mg', frequency: 'Twice daily', route: 'Oral', status: 'Active', startDate: '2026-01-02' },
  { id: 'med-2', patientId: 'pat-1', name: 'Metoprolol', dosage: '25 mg', frequency: 'Once daily', route: 'Oral', status: 'Active', startDate: '2026-02-10' },
] as Medication[];

const TASKS = [{ id: 'task-1', patientId: 'pat-1', title: 'Blood pressure monitoring', category: 'Monitoring', status: 'Open', dueDate: '2026-03-01', assignedTo: 'Dr. Lucy White', priority: 'Normal' }] as Task[];

const speech: SttConfig = {
  settings: { engine: 'gguf', repo: 'omi-health/omi-med-stt-v1-gguf', gguf_file: 'omi-med-stt-v1-q8_0.gguf', backend: 'cpu', threads: 0, endpoint_ms: 900, partial_ms: 500, record: false },
  engine: { engine: 'gguf (omi-med-stt-v1-gguf / parakeet.cpp cpu)', model: 'omi-health/omi-med-stt-v1-gguf', ready: true },
  models: [
    { id: 'g', repo: 'omi-health/omi-med-stt-v1-gguf', engine: 'gguf', gguf_file: 'omi-med-stt-v1-q8_0.gguf', label: 'Omi Med STT v1 · GGUF q8_0', downloaded: true, download_mb: null, available: true, reason: '' },
    { id: 'm', repo: 'omi-health/omi-med-stt-v1-mlx-q8', engine: 'mlx', gguf_file: null, label: 'Omi Med STT v1 · MLX 8-bit', downloaded: false, download_mb: 700, available: false, reason: 'MLX builds run only on Apple Silicon Macs' },
    { id: 'p', repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx', engine: 'onnx', gguf_file: null, label: 'NVIDIA Parakeet-TDT 0.6B v2 · ONNX (CPU / GPU)', downloaded: true, download_mb: 630, available: true, reason: '' },
  ],
  onnx_backends: [
    { id: 'cpu', installed: true, available: true, reason: '' },
    { id: 'cuda', installed: true, available: true, reason: '' },
  ],
  backends: [
    { id: 'cpu', installed: true, available: true, reason: '' },
    { id: 'cuda', installed: false, available: false, reason: 'Building it needs CMake, the CUDA Toolkit' },
    { id: 'vulkan', installed: false, available: false, reason: 'Building it needs CMake, the Vulkan SDK' },
  ],
};

function setup(state: Partial<RuntimeState> = {}) {
  const s: RuntimeState = {
    currentPageId: 'summary',
    currentPatientId: 'pat-1',
    currentPatientName: 'Liam Thompson',
    openFormId: null,
    pendingConfirmation: null,
    pendingSlot: null,
    patientPanelOpen: false,
    ...state,
  };
  const data: Partial<Record<RecordKind, AnyRecord[]>> = { medication: MEDS, task: TASKS };
  const deleted: Array<{ kind: EntityKind; id: string }> = [];
  const patients = [PATIENT, ...TWINS];
  const deps: RuntimeDeps = {
    getState: () => s,
    navigate: vi.fn((path: string) => {
      const clean = path.split('?')[0];
      NavigationRegistry.setPathname(clean);
      s.currentPageId = PageRegistry.matchPath(clean)?.id ?? s.currentPageId;
    }),
    back: vi.fn(),
    setCurrentPatient: vi.fn((id) => {
      s.currentPatientId = id;
      s.currentPatientName = patients.find((p) => p.id === id)?.fullName ?? null;
    }),
    setOpenForm: vi.fn((id) => { s.openFormId = id; }),
    setPendingConfirmation: vi.fn((p) => { s.pendingConfirmation = p; }),
    setPendingSlot: vi.fn((p) => { s.pendingSlot = p; }),
    setPatientSearch: vi.fn(),
    setPatientPanel: vi.fn((open: boolean) => { s.patientPanelOpen = open; }),
    getPatient: () => patients.find((p) => p.id === s.currentPatientId),
    allPatients: () => patients,
    findPatients: (q) => patients.filter((p) => p.fullName.toLowerCase().includes(q.toLowerCase())),
    getPatientSearch: () => '',
    getRecords: (kind) => (s.currentPatientId ? data[kind] ?? [] : []),
    deleteEntity: vi.fn(async (kind: EntityKind, id: string) => { deleted.push({ kind, id }); }),
    describePatient: () => 'Liam Thompson, 42, male. Active problems: hypertension.',
    getWorkload: () => null,
    providerNames: () => ['Dr. Lucy White', 'Dr. Harry Carter'],
    inboxItems: () => [],
    providerAppointments: () => [],
    addInboxComments: vi.fn(),
    setDashboardPanel: vi.fn(),
    aiSettings: () => ({ llm: { provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', timeoutMs: 90000, numGpu: 99, numCtx: 12288, maxSteps: 6 }, bridgeUrl: 'http://127.0.0.1:8765' }),
    listModels: vi.fn(async () => [
      { name: 'qwen3.5:4b', tools: true },
      { name: 'qwen3.5:2b', tools: true },
      { name: 'gemma-no-tools:2b', tools: false },
    ]),
    switchLanguageModel: vi.fn(),
    getSpeechConfig: vi.fn(async () => speech),
    saveSpeechConfig: vi.fn(async (settings) => ({ ...speech, settings })),
    signOut: vi.fn(),
    setSpokenReplies: vi.fn(),
    setSidebarCollapsed: vi.fn(),
    openHelp: vi.fn(),
    stopListening: vi.fn(),
    takeNote: vi.fn(),
  };
  const runtime = new AppRuntime(deps);
  return { runtime, deps, state: s, deleted };
}

describe('AppRuntime — what the tools do', () => {
  beforeEach(() => {
    FormRegistry.mounted().forEach((c) => c.close());
    NavigationRegistry.install(() => undefined);
    NavigationRegistry.setPathname('/summary');
  });

  it('opens pages by id — the Summary and its tabs too, with no patient selected', async () => {
    const { runtime, state } = setup({ currentPatientId: null, currentPatientName: null });
    expect((await runtime.openPage('dashboard')).ok).toBe(true);
    expect(state.currentPageId).toBe('dashboard');
    expect((await runtime.openPage('summary-medication')).ok).toBe(true);
    expect(state.currentPageId).toBe('summary-medication');
    // Reading a patient's records still needs to know whose.
    expect((await runtime.listRecords('medication')).message).toMatch(/no patient is selected/i);
    expect((await runtime.openPage('nowhere')).ok).toBe(false);
  });

  it('refuses to add, change or delete records without a patient', async () => {
    const { runtime } = setup({ currentPatientId: null, currentPatientName: null });
    for (const result of [await runtime.createRecords('medication', [{ medicationName: 'Aspirin' }]), await runtime.updateRecord('task', 'task-1', { status: 'Completed' }), await runtime.deleteRecord('medication', 'med-1')]) {
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/no patient is selected/i);
    }
  });

  it('fills the form, asks for the first missing required field, then stages the save — never saves itself', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime, state } = setup();
    const first = await runtime.createRecords('medication', [{ medicationName: 'Amoxicillin', dosage: '500 mg' }]);
    expect(list.openCreate).toHaveBeenCalled();
    expect(first.awaitUser).toBe(true);
    expect(first.message).toMatch(/what frequency/i);
    expect(state.pendingSlot?.field).toBe('frequency');

    const second = await runtime.fillOpenForm({ frequency: 'twice DAILY' });
    expect(form.items[0].frequency).toBe('Twice daily');
    expect(second.awaitUser).toBe(true);
    expect(state.pendingConfirmation?.kind).toBe('form');
    expect(form.submit).not.toHaveBeenCalled();
    list.unregister();
    form.unregister();
  });

  it('a misheard drug name becomes the known one it is spelled almost like; a merely similar real drug is kept', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime, deps } = setup();
    deps.knownNames = () => ['Metformin', 'Losartan', 'Amlodipine'];
    const heard = await runtime.createRecords('medication', [{ medicationName: 'Metforman', dosage: '500 mg' }]);
    expect(form.items[0].medicationName).toBe('Metformin');
    expect(heard.message).toMatch(/"Metforman" was taken as Metformin/);
    runtime.cancel();
    const other = await runtime.createRecords('medication', [{ medicationName: 'Valsartan', dosage: '80 mg' }]);
    expect(form.items[0].medicationName).toBe('Valsartan');
    expect(other.message).not.toMatch(/taken as/);
    list.unregister();
    form.unregister();
  });

  it('several records fill one tab each', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime } = setup();
    await runtime.createRecords('medication', [
      { medicationName: 'Panadol', dosage: '500 mg', frequency: 'Twice daily' },
      { medicationName: 'Ibuprofen', dosage: '400 mg', frequency: 'Three times daily' },
    ]);
    expect(form.items.map((i) => i.medicationName)).toEqual(['Panadol', 'Ibuprofen']);
    list.unregister();
    form.unregister();
  });

  it('a value that does not fit goes back to the model to correct — the turn is not handed to the user', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime } = setup();
    const result = await runtime.createRecords('medication', [{ medicationName: 'Aspirin', dosage: '75 mg', frequency: 'every morning', startDate: 'tomorrow', color: 'red' }]);
    expect(result.ok).toBe(false);
    expect(result.awaitUser).toBeFalsy();
    expect(result.message).toMatch(/frequency must be one of: Once daily/);
    expect(result.message).toMatch(/startDate must be a date in YYYY-MM-DD/);
    expect(result.message).toMatch(/"color" is not a field/);
    expect(form.items[0].medicationName).toBe('Aspirin'); // what did fit was written
    list.unregister();
    form.unregister();
  });

  it('a confirmation staged in this turn cannot be confirmed by the model in the same turn', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime, state } = setup();
    runtime.beginTurn(1);
    await runtime.createRecords('medication', [{ medicationName: 'Aspirin', dosage: '75 mg', route: 'Oral', frequency: 'Once daily' }]);
    expect(state.pendingConfirmation).not.toBeNull();
    const self = await runtime.confirm();
    expect(self.ok).toBe(false);
    expect(self.message).toMatch(/Not confirmed: the provider has not said yes/);
    expect(form.submit).not.toHaveBeenCalled();
    runtime.endTurn();

    // The user's "yes" arrives in the next turn.
    runtime.beginTurn(2);
    const saved = await runtime.confirm();
    runtime.endTurn();
    expect(saved.ok).toBe(true);
    expect(form.submit).toHaveBeenCalledTimes(1);
    expect(state.pendingConfirmation).toBeNull();
    list.unregister();
    form.unregister();
  });

  it('update_record opens the record by id or name and stops at the confirmation', async () => {
    const form = fakeForm('task');
    const list = fakeList('task', form, { 'task-1': { title: 'Blood pressure monitoring', dueDate: '2026-03-01', status: 'Open' } });
    const { runtime, state } = setup();
    const result = await runtime.updateRecord('task', 'blood pressure', { status: 'Completed' });
    expect(list.openEdit).toHaveBeenCalledWith('task-1');
    expect(form.values.status).toBe('Completed');
    expect(result.awaitUser).toBe(true);
    expect(state.pendingConfirmation?.kind).toBe('form');
    expect(form.submit).not.toHaveBeenCalled();
    list.unregister();
    form.unregister();
  });

  it('never guesses between several matching records — returns them with ids', async () => {
    const { runtime } = setup();
    const result = await runtime.deleteRecord('medication', 'met');
    expect(result.ok).toBe(false);
    expect(result.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'med-1' }), expect.objectContaining({ id: 'med-2' })]));
  });

  it('delete stages a confirmation; only a later confirm deletes, cancel deletes nothing', async () => {
    const form = fakeForm('medication');
    const list = fakeList('medication', form);
    const { runtime, state, deleted } = setup();
    runtime.beginTurn(1);
    const staged = await runtime.deleteRecord('medication', 'med-1');
    runtime.endTurn();
    expect(staged.awaitUser).toBe(true);
    expect(state.pendingConfirmation?.recordId).toBe('med-1');
    expect(deleted).toEqual([]);
    expect(runtime.cancel().message).toMatch(/nothing was deleted/i);
    expect(deleted).toEqual([]);

    await runtime.deleteRecord('medication', 'Metformin');
    expect((await runtime.confirm()).ok).toBe(true); // a button press (origin ui)
    expect(deleted).toEqual([{ kind: 'medication', id: 'med-1' }]);
    list.unregister();
    form.unregister();
  });

  it('delete ALL of a kind: no record named, nothing clinical asked — every one listed, deleted together only after a yes', async () => {
    const form = fakeForm('medication');
    const list = fakeList('medication', form);
    const { runtime, state, deleted } = setup();
    runtime.beginTurn(1);
    const staged = await runtime.deleteRecord('medication', undefined, { all: true });
    runtime.endTurn();
    expect(staged.awaitUser).toBe(true);
    expect(staged.message).toMatch(new RegExp(`^This will delete all ${MEDS.length} medications for Liam Thompson \\(.*Metformin.*\\)\\. This cannot be undone\\. Do you want to continue\\?$`));
    expect(staged.message).not.toMatch(/dose|route|how often|which medication/i);
    expect(state.pendingConfirmation).toMatchObject({ kind: 'delete', recordKind: 'medication', recordIds: MEDS.map((m) => (m as { id: string }).id) });
    expect(deleted).toEqual([]); // nothing before the provider's yes
    expect(runtime.cancel().message).toMatch(/nothing was deleted/i);
    expect(deleted).toEqual([]);

    await runtime.deleteRecord('medication', undefined, { all: true });
    expect((await runtime.confirm()).message).toBe(`Deleted all ${MEDS.length} medications.`);
    expect(deleted.map((d) => d.id)).toEqual(MEDS.map((m) => (m as { id: string }).id));
    // A patient with none: nothing to delete, nothing staged.
    const none = await runtime.deleteRecord('recall', undefined, { all: true });
    expect(none).toMatchObject({ ok: true, message: 'Liam Thompson has no recalls — nothing to delete.' });
    expect(state.pendingConfirmation).toBeNull();
    list.unregister();
    form.unregister();
  });

  it('a record tool naming a patient selects them first — never the records of whoever was selected', async () => {
    const form = fakeForm('medication');
    const list = fakeList('medication', form);
    const { runtime, state } = setup({ currentPatientId: null, currentPatientName: null });
    await runtime.deleteRecord('medication', undefined, { all: true, patient: PATIENT.fullName });
    expect(state.currentPatientId).toBe(PATIENT.id);
    expect(state.pendingConfirmation?.description).toContain(PATIENT.fullName);
    list.unregister();
    form.unregister();
  });

  it('patients: an exact name or MRN selects; two patients with one name are never guessed', async () => {
    const { runtime, state } = setup({ currentPatientId: null, currentPatientName: null });
    const twins = await runtime.selectPatient({ patient: 'Luke King' });
    expect(twins.ok).toBe(false);
    expect(twins.data).toHaveLength(2);
    expect(state.currentPatientId).toBeNull();
    const byMrn = await runtime.selectPatient({ patient: 'MRN-3' });
    expect(byMrn.ok).toBe(true);
    expect(state.currentPatientId).toBe('pat-3');
    expect(state.currentPageId).toBe('summary');
  });

  it('patients: a misheard name selects the one close spelling, and says so; a vague one is asked about', async () => {
    const { runtime, state } = setup({ currentPatientId: null, currentPatientName: null });
    const heard = await runtime.selectPatient({ patient: 'Leam Tomson' });
    expect(heard.ok).toBe(true);
    expect(heard.message).toMatch(/No patient is called "Leam Tomson"; the closest name is Liam Thompson/);
    expect(state.currentPatientId).toBe('pat-1');
    // "Luc Keng" is close to both Luke Kings: never guessed.
    const twins = await runtime.selectPatient({ patient: 'Luc Keng' });
    expect(twins.ok).toBe(false);
    expect(twins.message).toMatch(/closest names are Luke King, Luke King/);
    expect(state.currentPatientId).toBe('pat-1');
  });

  it('patient search: a misheard name searches for the one close spelling and says so', async () => {
    const { runtime, deps } = setup({ currentPatientId: null, currentPatientName: null });
    const result = await runtime.searchPatients('Leam Tomson');
    expect(result.message).toMatch(/closest name is Liam Thompson\. 1 patient match "Liam Thompson"/);
    expect(deps.navigate).toHaveBeenCalledWith(expect.stringContaining('q=Liam%20Thompson'));
  });

  it('list_records returns the records with ids for the model', async () => {
    const form = fakeForm('medication');
    const list = fakeList('medication', form);
    const { runtime } = setup();
    const result = await runtime.listRecords('medication', 'active');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual([expect.objectContaining({ id: 'med-1', label: 'Metformin' }), expect.objectContaining({ id: 'med-2', label: 'Metoprolol' })]);
    list.unregister();
    form.unregister();
  });

  it('the patient summary panel needs a patient', () => {
    const none = setup({ currentPatientId: null, currentPatientName: null });
    expect(none.runtime.setPatientPanel(true).ok).toBe(false);
    const some = setup();
    expect(some.runtime.setPatientPanel(true).ok).toBe(true);
    expect(some.state.patientPanelOpen).toBe(true);
  });

  it('a provider is matched by enough of the name to identify one — otherwise the model hears the choices', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime } = setup();
    await runtime.createRecords('medication', [{ medicationName: 'Aspirin', dosage: '75 mg', frequency: 'Once daily', prescribedBy: 'Dr. Carter' }]);
    expect(form.items[0].prescribedBy).toBe('Dr. Harry Carter');
    const bad = await runtime.fillOpenForm({ prescribedBy: 'Dr. Who' });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/prescribedBy must name one provider: Dr. Lucy White, Dr. Harry Carter/);
    list.unregister();
    form.unregister();
  });

  it('"save" while the save waits for confirmation is the confirmation (from a later turn)', async () => {
    const form = fakeMultiForm('medication');
    const list = fakeList('medication', form);
    const { runtime } = setup();
    runtime.beginTurn(1);
    await runtime.createRecords('medication', [{ medicationName: 'Aspirin', dosage: '75 mg', route: 'Oral', frequency: 'Once daily' }]);
    expect((await runtime.saveOpenForm()).ok).toBe(false); // same turn: refused
    runtime.endTurn();
    runtime.beginTurn(2);
    expect((await runtime.saveOpenForm()).ok).toBe(true);
    runtime.endTurn();
    expect(form.submit).toHaveBeenCalledTimes(1);
    list.unregister();
    form.unregister();
  });

  it('controls the list on screen through its own state, and explains what it cannot do', async () => {
    let state = { search: '', filters: {} as Record<string, string>, page: 1, pageCount: 3, shown: 25, total: 25 };
    const unregister = ListRegistry.register({
      name: 'medications',
      filters: [{ key: 'status', label: 'Status', options: ['Active', 'Completed'] }],
      searchable: true,
      state: () => state,
      setSearch: (q) => (state = { ...state, search: q }),
      setFilter: (k, v) => (state = { ...state, filters: v ? { ...state.filters, [k]: v } : {} }),
      clearAll: () => (state = { ...state, search: '', filters: {} }),
      setPage: (p) => (state = { ...state, page: p }),
    });
    const { runtime } = setup();
    expect((await runtime.controlList({ filter: 'status', value: 'active', page: 'next' })).ok).toBe(true);
    expect(state).toMatchObject({ filters: { status: 'Active' }, page: 2 });
    expect((await runtime.controlList({ filter: 'Status', value: 'Paused' })).message).toMatch(/Status can be: Active, Completed/);
    expect((await runtime.controlList({ page: 9 })).message).toMatch(/has 3 pages/);
    expect((await runtime.controlList({ filter: 'colour', value: 'red' })).message).toMatch(/no "colour" filter/);
    await runtime.controlList({ clear: true });
    expect(state).toMatchObject({ search: '', filters: {} });
    unregister();
    expect((await setup().runtime.controlList({ page: 'next' })).message).toMatch(/no list on screen/);
  });

  it('opening the dashboard summary shows it on the Dashboard — the summary is on screen, not in the reply', async () => {
    const { runtime, deps, state } = setup();
    const result = await runtime.setDashboardPanel(true);
    expect(result).toMatchObject({ ok: true, message: 'Your dashboard summary is open on the right.' });
    expect(deps.setDashboardPanel).toHaveBeenCalledWith(true);
    expect(state.currentPageId).toBe('dashboard');
  });

  it('switches the language model only to an installed model that calls tools, after the turn', async () => {
    const { runtime, deps } = setup();
    const ok = await runtime.setLanguageModel({ model: 'qwen 3.5 2b' });
    expect(ok.ok && ok.final).toBe(true);
    expect(deps.switchLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'qwen3.5:2b' }));
    expect((await runtime.setLanguageModel({ model: 'gemma' })).message).toMatch(/cannot call tools/);
    expect((await runtime.setLanguageModel({ model: 'llama' })).message).toMatch(/No installed model matches/);
    expect((await runtime.setLanguageModel({ model: 'qwen' })).message).toMatch(/Several models match/);
    expect((await runtime.setLanguageModel({ context_window: 2048 })).message).toMatch(/at least 4096/);
    expect(deps.switchLanguageModel).toHaveBeenCalledTimes(1);
  });

  it('changes speech recognition through the bridge, refusing what this machine cannot run', async () => {
    const { runtime, deps } = setup();
    expect((await runtime.setSpeechRecognition({ backend: 'cuda' })).message).toMatch(/Building it needs CMake, the CUDA Toolkit/);
    expect((await runtime.setSpeechRecognition({ model: 'mlx' })).message).toMatch(/Apple Silicon/);
    const saved = await runtime.setSpeechRecognition({ pause_ms: 1200, cpu_threads: 4 });
    expect(saved.ok).toBe(true);
    expect(deps.saveSpeechConfig).toHaveBeenCalledWith(expect.objectContaining({ endpoint_ms: 1200, threads: 4, repo: 'omi-health/omi-med-stt-v1-gguf' }));
  });

  it('switches to Parakeet by voice, on the GPU — its devices are its own (the GPU works for it, not for Omi here)', async () => {
    const { runtime, deps } = setup();
    const saved = await runtime.setSpeechRecognition({ model: 'parakeet', backend: 'cuda', precision: 'fp32' });
    expect(saved.ok).toBe(true);
    expect(deps.saveSpeechConfig).toHaveBeenLastCalledWith(expect.objectContaining({ engine: 'onnx', repo: 'istupakov/parakeet-tdt-0.6b-v2-onnx', backend: 'cuda', precision: 'fp32' }));
    expect((await runtime.setSpeechRecognition({ model: 'parakeet', backend: 'vulkan' })).message).toMatch(/Parakeet cannot run on VULKAN/);
    expect((await runtime.setSpeechRecognition({ precision: 'fp32' })).message).toMatch(/Only the Parakeet model/);
  });

  it('take_clinical_note hands the note over, or starts dictation', () => {
    const { runtime, deps } = setup();
    expect(runtime.takeNote('start amlodipine 5 mg daily').ok).toBe(true);
    expect(deps.takeNote).toHaveBeenCalledWith('start amlodipine 5 mg daily');
    expect(runtime.takeNote().awaitUser).toBe(true);
  });
});

describe('provider workload', () => {
  const provider = { id: 'prov-1', fullName: 'Dr. Lucy White' } as Provider;
  const today = dayjs('2026-09-24T10:00:00');
  const appt = (id: string, date: string, time: string, status = 'Scheduled', providerId = 'prov-1') => ({ id, patientId: 'pat-1', patientName: 'Liam Thompson', providerId, date, startTime: time, status, type: 'Follow-up' }) as never;

  it("reports only the signed-in provider's day, week, tasks and panel", () => {
    const w = buildProviderWorkload({
      provider,
      today,
      patients: [{ id: 'pat-1', primaryProviderId: 'prov-1' }, { id: 'pat-9', primaryProviderId: 'prov-2' }] as Patient[],
      appointments: [appt('a1', '2026-09-24', '09:00', 'Completed'), appt('a2', '2026-09-24', '11:30'), appt('a3', '2026-09-26', '10:00'), appt('a4', '2026-09-24', '12:00', 'Scheduled', 'prov-2'), appt('a5', '2026-10-20', '10:00')],
      tasks: [
        { id: 't1', assignedTo: 'Dr. Lucy White', status: 'Open', dueDate: '2026-09-20', priority: 'High' },
        { id: 't2', assignedTo: 'Dr. Lucy White', status: 'Completed', dueDate: '2026-09-20', priority: 'High' },
        { id: 't3', assignedTo: 'Dr. Other', status: 'Open', dueDate: '2026-09-20', priority: 'High' },
      ] as Task[],
      recalls: [{ id: 'r1', patientId: 'pat-1', status: 'Due', dueDate: '2026-09-01' }, { id: 'r2', patientId: 'pat-9', status: 'Due', dueDate: '2026-09-01' }] as never,
      inbox: [],
      reviewedInboxIds: [],
    });
    expect(w.today.map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(w.nextToday?.id).toBe('a2');
    expect(w.upcoming.map((a) => a.id)).toEqual(['a3']);
    expect(w.openTasks.map((t) => t.id)).toEqual(['t1']);
    expect(w.overdueTasks.map((t) => t.id)).toEqual(['t1']);
    expect(w.dueRecalls.map((r) => r.id)).toEqual(['r1']);
    expect(w.panel.map((p) => p.id)).toEqual(['pat-1']);
  });
});
