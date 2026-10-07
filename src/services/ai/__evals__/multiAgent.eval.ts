/**
 * Live evaluation of the multi-agent mode — the real model as the master and as every specialist, over
 * the real tool schemas, against a runtime of spies (nothing in the app changes). Each case checks what
 * the unit tests cannot: that the MODEL routes, splits, links and classifies requests correctly.
 *
 *   Routing          the master picks the right specialist
 *   Decomposition    the right number of tasks
 *   Dependencies     which task needs which
 *   Execution type   READ_ONLY / CONTEXT / WRITE
 *   Tool selection   the specialist calls the right tool …
 *   Arguments        … with the right arguments
 *   Confirmation     nothing is confirmed until the provider says yes, and "yes" confirms
 *   Waiting state    a task waiting on the provider resumes on the next turn, without the master
 *   Final result     the master's reply combines the specialists' results
 *
 * The provider is chosen like the app chooses it — through createChatLLM, never assumed:
 *
 *   npm run eval:llm -- multiAgent                                         (This Computer: Ollama, qwen3.5:4b)
 *   EVAL_LLM_PROVIDER=vllm EVAL_LLM_URL=http://127.0.0.1:8765/vllm npm run eval:llm -- multiAgent   (Kaggle vLLM)
 *   EVAL_LLM_PROVIDER=openrouter EVAL_LLM_URL=http://127.0.0.1:8765/openrouter/api EVAL_LLM_MODEL=openai/gpt-6-sol npm run eval:llm -- multiAgent
 *   EVAL_ONLY=route-  …only the cases whose id starts with it
 *
 * Prints a row per case and fails when the pass rate drops below EVAL_MIN_PASS (default 0.8).
 */
import { describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import type { AIContext, AgentStep, TaskGraphSnapshot, ToolCall, ToolResult } from '@/types/ai';
import type { AIConfig, LLMProviderKind } from '../config';
import { createChatLLM } from '../providers/llm';
import type { AppRuntime } from '../agent/runtime';
import { buildTools } from '../agent/tools';
import { MultiAgentOrchestrator } from '../agents/master';

const PROVIDER = (process.env.EVAL_LLM_PROVIDER ?? 'ollama') as LLMProviderKind;
const MODEL = process.env.EVAL_LLM_MODEL ?? 'qwen3.5:4b';
const URL = process.env.EVAL_LLM_URL ?? 'http://127.0.0.1:11434';
const ONLY = process.env.EVAL_ONLY;
const MIN_PASS = Number(process.env.EVAL_MIN_PASS ?? 0.8);

const today = dayjs();
const iso = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');
const tomorrow = iso(today.add(1, 'day'));

const context = (over: Partial<AIContext> = {}): AIContext => ({
  today: today.format('YYYY-MM-DD (dddd)'),
  nextDays: Array.from({ length: 7 }, (_, i) => today.add(i + 1, 'day').format('ddd YYYY-MM-DD')).join(', '),
  laterDates: [1, 2, 3, 4].map((n) => `${n} week${n > 1 ? 's' : ''} ${iso(today.add(n, 'week'))}`).join(', '),
  now: '10:30',
  providerName: 'Dr. Lucy White',
  currentPageId: 'dashboard',
  currentPageTitle: 'Dashboard',
  currentPatientId: null,
  currentPatientName: null,
  openForm: null,
  pendingQuestion: null,
  pendingConfirmation: null,
  inbox: null,
  patientSearch: null,
  list: null,
  extracted: null,
  carePlan: null,
  ...over,
});

const ok = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, message, ...extra });

/** A runtime of spies over a context they change, the way the real runtime changes the app. */
function world(over: Partial<AIContext> = {}, options: { askTime?: boolean } = {}) {
  const ctx = context(over);
  // The real runtime's rule: a confirmation prepared in this turn cannot be confirmed in it.
  let turn = 0;
  let stagedIn = -1;
  const attempts = { selfConfirm: 0 };
  const stage = (description: string) => {
    stagedIn = turn;
    ctx.pendingConfirmation = { kind: 'form', description };
    return ok(`${description} — please confirm or cancel.`, { awaitUser: true, speak: true });
  };
  const runtime = {
    beginTurn: vi.fn((t: number) => {
      turn = t;
    }),
    endTurn: vi.fn(),
    selectPatient: vi.fn(async ({ patient }: { patient?: string }) => {
      ctx.currentPatientId = 'pat-7';
      ctx.currentPatientName = 'John Ahmed';
      return ok(`John Ahmed (MRN 1007) is now the selected patient${patient ? '' : ''}. Summary is open.`);
    }),
    searchPatients: vi.fn(async () => ok('1 patient matches "John Ahmed".', { data: [{ position: 1, id: 'pat-7', name: 'John Ahmed' }] })),
    createRecords: vi.fn(async (kind: string, items: Array<Record<string, unknown>>) => {
      if (kind === 'appointment' && options.askTime && !items.some((i) => i.startTime)) {
        ctx.openForm = { id: 'appointment', values: items[0] ?? {}, entries: 1 };
        ctx.pendingQuestion = { formId: 'appointment', field: 'startTime', question: 'What time should the appointment start?' };
        return ok('What time should the appointment start?', { awaitUser: true, speak: true });
      }
      ctx.openForm = { id: kind, values: items[0] ?? {}, entries: items.length };
      return stage(`Save the new ${kind}${items.length > 1 ? 's' : ''}`);
    }),
    addCarePlan: vi.fn(async () => stage('Save the care plan')),
    fillOpenForm: vi.fn(async (fields: Record<string, unknown>) => {
      ctx.pendingQuestion = null;
      return stage(`Save the appointment (${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', ')})`);
    }),
    confirm: vi.fn(async () => {
      if (ctx.pendingConfirmation && stagedIn === turn) {
        attempts.selfConfirm++;
        return { ok: false, message: 'Not confirmed: the provider has not said yes — this was only just prepared. If SAID asks for more records, add them now (add_* or add_care_plan); otherwise stop and let the provider confirm.' };
      }
      const was = ctx.pendingConfirmation;
      ctx.pendingConfirmation = null;
      ctx.openForm = null;
      return was ? ok(`${was.description.replace(/^Save /, '')}: saved.`) : { ok: false, message: 'Nothing is waiting for confirmation.' };
    }),
    cancel: vi.fn(() => {
      ctx.pendingConfirmation = null;
      ctx.pendingQuestion = null;
      return ok('Cancelled — nothing was saved.');
    }),
    providerOverview: vi.fn(() => ok('Schedule and work queue for Dr. Lucy White.', { speak: true, data: { today: [{ patient: 'Harry White', time: '11:00' }, { patient: 'Lily Martin', time: '15:30' }], openTasks: 4, recallsDue: 2, unfiledInbox: { total: 6 } } })),
    setDashboardPanel: vi.fn(async () => ok('The day summary is open beside the Dashboard.')),
    myAppointments: vi.fn(async (args: Record<string, unknown>) => ok(`2 appointments${args.date ? ` on ${args.date}` : ''}.`, { data: [{ id: 'a1', patient: 'Harry White', time: '11:00' }, { id: 'a2', patient: 'Lily Martin', time: '15:30' }] })),
    inboxShow: vi.fn(async (args: Record<string, unknown>) => ok(`The Inbox shows 3 ${args.category ?? 'all'} items.`, { data: [{ position: 1, subject: 'HbA1c', category: 'lab', patient: 'John Ahmed' }] })),
    inboxOpen: vi.fn(async () => ok('HbA1c 6.1 % (normal), received today.', { data: { subject: 'HbA1c', result: '6.1 %' } })),
    patientSummary: vi.fn(() => ok('John Ahmed, 54: type 2 diabetes, hypertension; metformin 500 mg twice daily.', { speak: true })),
    openPage: vi.fn(async (page: string) => ok(`${page} is open.`)),
    listRecords: vi.fn(async () => ok('No records.', { data: [] })),
    deletePatient: vi.fn(async () => {
      stagedIn = turn;
      ctx.pendingConfirmation = { kind: 'delete', description: 'Permanently delete this patient' };
      return ok('Delete John Ahmed (MRN 1007)? This cannot be undone. Please confirm or cancel.', { awaitUser: true, speak: true });
    }),
  } as unknown as AppRuntime;
  return { ctx, runtime, attempts };
}


interface Run {
  graph: TaskGraphSnapshot | null;
  steps: AgentStep[];
  reply: string;
  awaiting: boolean;
}

const calls = (steps: AgentStep[], agent?: string): ToolCall[] =>
  steps.filter((s): s is Extract<AgentStep, { type: 'tool' }> => s.type === 'tool' && (!agent || s.agent === agent)).map((s) => s.call);

type Check = (turns: Run[], spies: AppRuntime) => string | null;
interface Case {
  id: string;
  /** What the provider says, turn by turn. */
  said: string[];
  context?: Partial<AIContext>;
  askTime?: boolean;
  check: Check;
}

const tasks = (r: Run) => r.graph?.tasks ?? [];
const fail = (...problems: Array<string | null | false | undefined>) => problems.find(Boolean) || null;

/** One task, for this agent, of this execution type — and the specialist called this tool. */
const single = (agent: string, type: string, tool: string, args?: (c: ToolCall) => string | null): Check => ([r]) => {
  const t = tasks(r);
  const call = calls(r.steps, agent).find((c) => c.name === tool);
  return fail(
    t.length !== 1 && `expected 1 task, got ${t.length}: ${t.map((x) => x.agent).join(', ')}`,
    t[0]?.agent !== agent && `routed to ${t[0]?.agent ?? 'nobody'}, expected ${agent}`,
    t[0] && (t[0].declaredType ?? t[0].executionType) !== type && `execution ${t[0].declaredType ?? t[0].executionType}, expected ${type}`,
    !call && `${agent} called ${calls(r.steps, agent).map((c) => c.name).join(', ') || 'no tool'}, expected ${tool}`,
    call && args?.(call),
  );
};
const arg = (c: ToolCall, key: string) => String(c.arguments[key] ?? '');

const cases: Case[] = [
  {
    id: 'route-appointments',
    said: ['show my appointments for tomorrow'],
    check: single('appointments', 'READ_ONLY', 'list_my_appointments', (c) => (arg(c, 'date') === tomorrow || arg(c, 'when') === 'upcoming' ? null : `date ${arg(c, 'date')}, expected ${tomorrow}`)),
  },
  { id: 'route-dashboard', said: ['how busy am I today, what is on my plate'], check: single('dashboard', 'READ_ONLY', 'get_provider_overview') },
  { id: 'route-inbox', said: ['show me the latest radiology results'], check: single('inbox', 'READ_ONLY', 'inbox_show', (c) => (arg(c, 'category') === 'radiology' ? null : `category ${arg(c, 'category')}`)) },
  {
    id: 'route-patients',
    said: ['add a new patient called Sara Khan'],
    check: single('patients', 'WRITE', 'create_patient', (c) => (JSON.stringify(c.arguments).toLowerCase().includes('sara') ? null : `no name in ${JSON.stringify(c.arguments)}`)),
  },
  {
    id: 'route-summary',
    said: ['give me a summary of this patient'],
    context: { currentPatientId: 'pat-7', currentPatientName: 'John Ahmed', currentPageId: 'summary', currentPageTitle: 'Summary' },
    check: single('summary', 'READ_ONLY', 'get_patient_summary'),
  },
  {
    id: 'split-care-plan-and-appointment',
    said: ['add metformin 500 mg twice daily and book a follow-up next Tuesday at 3 pm', 'yes save it'],
    context: { currentPatientId: 'pat-7', currentPatientName: 'John Ahmed', currentPageId: 'summary', currentPageTitle: 'Summary' },
    check: ([first, second]) => {
      const t = tasks(first);
      const summary = t.find((x) => x.agent === 'summary');
      const appt = t.find((x) => x.agent === 'appointments');
      const medCall = calls(first.steps, 'summary').find((c) => c.name === 'add_medications' || c.name === 'add_care_plan');
      return fail(
        t.length !== 2 && `expected 2 tasks, got ${t.map((x) => x.agent).join(', ')}`,
        (!summary || !appt) && 'expected a summary task and an appointments task',
        summary && appt && t.indexOf(summary) > t.indexOf(appt) && 'the appointment was planned before the care plan',
        !medCall && `summary called ${calls(first.steps, 'summary').map((c) => c.name).join(', ') || 'nothing'}`,
        medCall && !JSON.stringify(medCall.arguments).toLowerCase().includes('metformin') && 'metformin lost',
        medCall && JSON.stringify(medCall.arguments).includes('appointments') && 'the Summary Agent tried to add the appointment',

        // Turn 2: "yes" confirmed the care plan; then the appointment ran.
        !calls(second.steps, 'summary').some((c) => c.name === 'confirm_pending_action') && 'yes did not confirm the care plan',
        !calls(second.steps, 'appointments').some((c) => c.name === 'add_appointments' && JSON.stringify(c.arguments).includes('15:00')) && 'the follow-up was not opened at 15:00 after the confirmation',
      );
    },
  },
  {
    id: 'deps-john',
    said: ['find John Ahmed, open his latest lab report and schedule an appointment for him tomorrow at 3 pm'],
    askTime: false,
    check: ([r]) => {
      const t = tasks(r);
      const find = t.find((x) => x.agent === 'patients');
      const lab = t.find((x) => x.agent === 'inbox');
      const appt = t.find((x) => x.agent === 'appointments');
      return fail(
        t.length !== 3 && `expected 3 tasks, got ${t.map((x) => x.agent).join(', ')}`,
        (!find || !lab || !appt) && 'expected patients, inbox and appointments tasks',
        find && lab && !lab.dependsOn.includes(find.id) && 'the lab report does not depend on finding John',
        find && appt && lab && appt.dependsOn.includes(lab.id) && 'the appointment was made to wait for the lab report',
        appt && (appt.declaredType ?? appt.executionType) !== 'WRITE' && `appointment execution ${appt.declaredType ?? appt.executionType}`,
        lab && lab.status !== 'COMPLETED' && `lab task ${lab.status}: ${lab.error ?? ''}`,
        find && find.result?.patientId !== 'pat-7' && 'finding John did not hand on his id',
      );
    },
  },
  {
    id: 'parallel-reads',
    said: ['how busy am I today, and show me the lab results in my inbox'],
    check: ([r]) => {
      const t = tasks(r);
      return fail(
        t.length !== 2 && `expected 2 tasks, got ${t.map((x) => x.agent).join(', ')}`,
        t.some((x) => x.dependsOn.length) && 'independent reads were made to depend on each other',
        t.some((x) => (x.declaredType ?? x.executionType) !== 'READ_ONLY') && `execution types ${t.map((x) => x.declaredType ?? x.executionType).join(', ')}`,
        // Final result: both answers in one reply.
        !/lab|inbox/i.test(r.reply) && `reply lacks the inbox: "${r.reply}"`,
      );
    },
  },
  {
    id: 'wait-and-resume',
    said: ['book John Ahmed an appointment for tomorrow', '3 pm', 'yes'],
    askTime: true,
    check: ([first, second, third]) =>
      fail(
        !first.awaiting && 'the first turn did not wait for the time',
        tasks(first)[0]?.status !== 'WAITING_FOR_USER' && `task ${tasks(first)[0]?.status}`,
        second.steps.some((s) => s.agent === 'master') && 'the answer went through the master again',
        !calls(second.steps, 'appointments').some((c) => c.name === 'fill_open_form' && JSON.stringify(c.arguments).includes('15:00')) && `3 pm was not filled as 15:00: ${JSON.stringify(calls(second.steps))}`,
        tasks(third)[0]?.status !== 'COMPLETED' && `after yes the task is ${tasks(third)[0]?.status}`,
      ),
  },
  {
    id: 'no-means-no',
    said: ['delete the patient John Ahmed', 'no, cancel that'],
    context: { currentPatientId: 'pat-7', currentPatientName: 'John Ahmed' },
    check: ([first, second]) =>
      fail(
        tasks(first)[0]?.agent !== 'patients' && `routed to ${tasks(first)[0]?.agent}`,
        tasks(second)[0]?.status === 'COMPLETED' && 'the delete went through',
        !calls(second.steps).some((c) => c.name === 'cancel_pending_action') && 'no was not a cancel',
      ),
  },
];

describe('live model: multi-agent mode', () => {
  it(
    'routes, splits, links, classifies and resumes',
    async () => {
      const llmCfg: AIConfig['llm'] = { provider: PROVIDER, apiUrl: URL, model: MODEL, timeoutMs: 900000, numGpu: 99, numCtx: 16384, maxSteps: 6 };
      const llm = createChatLLM(llmCfg);
      console.log(`provider=${PROVIDER} model=${MODEL} url=${URL} → ${llm.name}`);
      const rows: Array<{ id: string; pass: boolean; ms: number; calls: number; selfConfirm: number }> = [];
      for (const c of cases.filter((x) => !ONLY || x.id.startsWith(ONLY))) {
        const { ctx, runtime, attempts } = world(c.context, { askTime: c.askTime });
        const orchestrator = new MultiAgentOrchestrator(llm, runtime, () => ({ ...ctx }), { maxSteps: 6, parallelReads: true });
        orchestrator.setTools(buildTools());
        const started = Date.now();
        const turns: Run[] = [];
        let why: string | null = null;
        let modelCalls = 0;
        try {
          for (const said of c.said) {
            const steps: AgentStep[] = [];
            const outcome = await orchestrator.run(said, {
              onStep: (s) => {
                const at = steps.findIndex((x) => x.id === s.id);
                if (at < 0) steps.push(s);
                else steps[at] = s;
              },
            });
            modelCalls += steps.filter((s) => s.type === 'model').length;
            turns.push({ graph: orchestrator.activeGraph, steps, reply: outcome.reply, awaiting: outcome.awaitingUser });
          }
          why = c.check(turns, runtime);
        } catch (e) {
          why = `error: ${(e as Error).message}`;
        }
        const ms = Date.now() - started;
        rows.push({ id: c.id, pass: !why, ms, calls: modelCalls, selfConfirm: attempts.selfConfirm });
        const graph = turns[0]?.graph?.tasks.map((t) => `${t.id}:${t.agent}/${t.declaredType ?? t.executionType}${t.dependsOn.length ? `←${t.dependsOn.join('+')}` : ''}`).join(' ') ?? '(no graph)';
        console.log(`${why ? 'FAIL' : 'pass'}  ${c.id.padEnd(32)} ${String(ms).padStart(7)} ms  ${String(modelCalls).padStart(2)} calls${attempts.selfConfirm ? `  (${attempts.selfConfirm} self-confirm refused by the runtime)` : ''}  ${graph}${why ? `\n      -> ${why}` : ''}`);
      }
      const passed = rows.filter((r) => r.pass).length;
      console.log(`SUMMARY provider=${PROVIDER} model=${MODEL} passed=${passed}/${rows.length} avg_ms=${Math.round(rows.reduce((n, r) => n + r.ms, 0) / Math.max(rows.length, 1))} self_confirm_refused=${rows.reduce((n, r) => n + r.selfConfirm, 0)} failed=${rows.filter((r) => !r.pass).map((r) => r.id).join(',')}`);
      expect(passed / Math.max(rows.length, 1)).toBeGreaterThanOrEqual(MIN_PASS);
    },
    60 * 60 * 1000,
  );
});
