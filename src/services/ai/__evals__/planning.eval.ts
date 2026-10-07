/**
 * Live evaluation of requirement gathering — the real model as the master, the Planning Agent and the
 * specialists, with the real Safety Agent, against a runtime of spies (nothing in the app changes).
 *
 * A COMPLETE request must go straight through: no question. An incomplete one asks only for what is missing.
 * Every tool call (master, planning, specialists) is printed with its arguments, so a wrong question can be
 * traced to the call that caused it.
 *
 *   EVAL_LLM_PROVIDER=vllm EVAL_LLM_URL=http://127.0.0.1:8765/vllm EVAL_LLM_MODEL=qwen3.5:9b npm run eval:llm -- planning
 *   EVAL_ONLY=med-   …only the cases whose id starts with it
 */
import { describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import type { AIContext, AgentStep, ToolResult } from '@/types/ai';
import type { AIConfig, LLMProviderKind } from '../config';
import { createChatLLM } from '../providers/llm';
import type { AppRuntime } from '../agent/runtime';
import { buildTools } from '../agent/tools';
import { MultiAgentOrchestrator } from '../agents/master';
import { SafetyAgent } from '../safety/safetyAgent';

const PROVIDER = (process.env.EVAL_LLM_PROVIDER ?? 'ollama') as LLMProviderKind;
const MODEL = process.env.EVAL_LLM_MODEL ?? 'qwen3.5:4b';
const URL = process.env.EVAL_LLM_URL ?? 'http://127.0.0.1:11434';
const ONLY = process.env.EVAL_ONLY;
const MIN_PASS = Number(process.env.EVAL_MIN_PASS ?? 0.8);

const today = dayjs();
const iso = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');
const PATIENTS = ['Luke King', 'Tom Baker', 'Chloe Bell', 'Zoe Hill', 'Harry White'].map((fullName, i) => ({ id: `p${i + 1}`, fullName, mrn: `MRN${1001 + i}` }));

const context = (): AIContext => ({
  today: today.format('YYYY-MM-DD (dddd)'),
  nextDays: Array.from({ length: 7 }, (_, i) => today.add(i + 1, 'day').format('ddd YYYY-MM-DD')).join(', '),
  laterDates: [1, 2, 3, 4].map((n) => `${n} week${n > 1 ? 's' : ''} ${iso(today.add(n, 'week'))}`).join(', '),
  now: '10:30',
  providerName: 'Dr. Lucy White',
  currentPageId: 'configuration',
  currentPageTitle: 'Configuration',
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
});

const ok = (message: string, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, message, ...extra });

interface Case {
  id: string;
  said: string;
  /** A complete request: no question. Otherwise the question must ask (only) for this. */
  expect: 'no-question' | RegExp;
}

const CASES: Case[] = [
  { id: 'med-panadol', said: 'Add Panadol 500 mg twice daily to Luke King.', expect: 'no-question' },
  { id: 'med-gabapentin', said: 'Add Gabapentin 500 mg twice daily for 50 days by orally to Tom Baker.', expect: 'no-question' },
  { id: 'med-metformin', said: 'Add Metformin 500 mg once daily by oral to Chloe Bell.', expect: 'no-question' },
  { id: 'task-bp', said: 'create a task for blood pressure monitoring for tom baker', expect: 'no-question' },
  { id: 'task-zoe', said: 'Create a task for Zoe Hill to monitor blood pressure every morning.', expect: 'no-question' },
  // The reason of a recall is required by its form and was not said: only that is asked — never the date said.
  { id: 'recall-luke', said: 'Recall Luke King after two weeks.', expect: /^For the recall: what the recall is for\?$/ },
  { id: 'appt-tom', said: 'Schedule a follow-up appointment for Tom Baker next Tuesday at 3 PM.', expect: 'no-question' },
  { id: 'med-metformin-twice', said: 'Add Metformin 500 mg twice daily by oral to Chloe Bell.', expect: 'no-question' },
  {
    id: 'plan-tom',
    said: 'Goto patients select Tom baker and add medication metformin, Panadol, gabapentin, rituximab 500 mg twice daily for 30 days, add hypertension as a diagnosis, create a task for blood pressure monitoring, recall the patient for neck pain after two weeks, and schedule a follow-up appointment next Tuesday at 3 pm',
    expect: 'no-question',
  },
  // Nothing said about what: asked — the same on every model.
  { id: 'vague-meds', said: 'add medication and add diagnosis for Tom Baker', expect: /^Which medication, at what dose and how often — and which diagnosis\?$/ },
];

function run(c: Case) {
  const ctx = context();
  const words: string[] = [];
  const runtime = {
    beginTurn: vi.fn(),
    endTurn: vi.fn(),
    selectPatient: vi.fn(async ({ patient }: { patient?: string }) => {
      const p = PATIENTS.find((x) => x.fullName.toLowerCase() === String(patient ?? '').toLowerCase());
      if (!p) return { ok: false, message: `No patient matches "${patient}".` };
      ctx.currentPatientId = p.id;
      ctx.currentPatientName = p.fullName;
      return ok(`${p.fullName} is now the selected patient.`);
    }),
    createRecords: vi.fn(async () => ok('Ready — please confirm.', { awaitUser: true })),
    addCarePlan: vi.fn(async () => ok('The care plan is ready — please confirm.', { awaitUser: true })),
    searchPatients: vi.fn(async (q: string) => ok('Found.', { data: PATIENTS.filter((p) => p.fullName.toLowerCase().includes(String(q).toLowerCase())) })),
    openPage: vi.fn(async () => ok('Opened.')),
    controlList: vi.fn(async () => ok('Done.')),
    listRecords: vi.fn(async () => ok('No records.', { data: [] })),
    confirm: vi.fn(async () => ({ ok: false, message: 'Not confirmed: the provider has not said yes.' })),
    saveOpenForm: vi.fn(async () => ({ ok: false, message: 'Not saved: the provider has not said yes.' })),
  } as unknown as AppRuntime;
  const llmCfg: AIConfig['llm'] = { provider: PROVIDER, apiUrl: URL, model: MODEL, timeoutMs: 900000, numGpu: 99, numCtx: 16384, maxSteps: 6 };
  const orchestrator = new MultiAgentOrchestrator(createChatLLM(llmCfg), runtime, () => ({ ...ctx }), { maxSteps: 6, planning: true, parallelReads: true });
  orchestrator.setTools(buildTools());
  orchestrator.setSafety(
    new SafetyAgent({
      utterances: () => words,
      providerName: () => 'Dr. Lucy White',
      providers: () => ['Dr. Lucy White'],
      selectedPatient: () => (ctx.currentPatientId ? { id: ctx.currentPatientId, name: ctx.currentPatientName ?? '' } : null),
      patients: () => PATIENTS,
      known: (kind) => (kind === 'medication' ? ['Panadol', 'Gabapentin', 'Metformin'] : []),
      recordLabel: () => undefined,
      openFormId: () => null,
      staged: () => [],
      discardStaged: () => undefined,
    }),
  );
  const trace: string[] = [];
  words.push(c.said);
  return orchestrator
    .run(c.said, {
      onStep: (s: AgentStep) => {
        if (s.type === 'tool' && s.finishedAt) {
          const who = (s as { agent?: string }).agent ?? '?';
          trace.push(`   [${who}] ${s.call.name} ${JSON.stringify(s.call.arguments)} → ${s.result?.ok ? 'ok' : 'FAIL'}: ${String(s.result?.message ?? '').slice(0, 160)}${s.safety?.length ? `  SAFETY ${JSON.stringify(s.safety)}` : ''}`);
        }
      },
      onPlanning: (r) => trace.push(`   [planning] ${r.type}${r.question ? ` "${r.question}"` : ''}${r.approved?.length ? ` approved=${JSON.stringify(r.approved)}` : ''}${r.findings?.length ? ` findings=${JSON.stringify(r.findings)}` : ''}`),
    })
    .then((outcome) => {
      const question = outcome.reply;
      // Asked by the Planning Agent before anything ran, or by the Safety Agent at a tool call: the provider
      // hears a question either way. A complete request prepares its records and asks nothing.
      const prepared = (runtime.createRecords as ReturnType<typeof vi.fn>).mock.calls.length + (runtime.addCarePlan as ReturnType<typeof vi.fn>).mock.calls.length > 0;
      const asked = trace.some((t) => t.startsWith('   [planning] question')) || trace.some((t) => /→ FAIL: .*\?\s*(SAFETY|$)/.test(t) && t.includes('SAFETY'));
      const pass = c.expect === 'no-question' ? prepared && !asked : c.expect.test(question.trim());
      return { pass, question, trace, addCalls: (runtime.createRecords as ReturnType<typeof vi.fn>).mock.calls.length + (runtime.addCarePlan as ReturnType<typeof vi.fn>).mock.calls.length };
    });
}

describe(`requirement gathering on ${PROVIDER}:${MODEL}`, () => {
  it(
    'complete requests go through; incomplete ones ask only for what is missing',
    async () => {
      const cases = CASES.filter((c) => !ONLY || c.id.startsWith(ONLY));
      let passed = 0;
      for (const c of cases) {
        const started = Date.now();
        const r = await run(c).catch((e: Error) => ({ pass: false, question: `ERROR ${e.message}`, trace: [], addCalls: 0 }));
        if (r.pass) passed += 1;
        console.log(`${r.pass ? 'PASS' : 'FAIL'} ${c.id} (${((Date.now() - started) / 1000).toFixed(1)} s) "${c.said}"\n   reply: ${r.question}\n   add calls: ${r.addCalls}\n${r.trace.join('\n')}\n`);
      }
      console.log(`\n${passed}/${cases.length} passed`);
      expect(passed / cases.length).toBeGreaterThanOrEqual(MIN_PASS);
    },
    60 * 60 * 1000,
  );
});
