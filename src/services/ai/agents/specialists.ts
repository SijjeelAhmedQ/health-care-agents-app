/**
 * The specialists of the multi-agent mode, and what each may touch.
 *
 *   Patients              find, select, clear, add, change, delete patients
 *   Dashboard             questions about the signed-in provider's own day (never one patient's chart)
 *   My Appointment        the provider's OWN appointments
 *   Appointments          patients' appointments
 *   Medication · Diagnoses · Tasks · Recalls   a patient's records of that kind — one owner per kind
 *   Notes                 dictated clinical notes and the AI Summary's extracted items
 *   Summary               every summary — no tools: the app gathers the data, its model only writes
 *   Inbox                 lab, radiology, referrals, discharge summaries
 *
 * A specialist is the same Agent class as the single assistant, with its own small prompt and only its
 * own tools — the very same tool objects (tools.ts), so the same runtime methods, validation and
 * confirmations apply. The tools that take a record kind are given over the kinds the specialist owns.
 * A few tools are shared application capabilities (the open form, the pending confirmation, the page),
 * not any one domain's: every specialist has them.
 */
import { z } from 'zod';
import type { AgentName, ExecutionType } from '@/types/ai';
import { defineTool, type Tool } from '../agent/tool';
import { recordKindTools } from '../agent/tools';
import { AGENT_NAMES } from './taskGraph';
import { agentPrompt, agentRecordKinds, agentToolNames } from './skills';

/**
 * How each tool touches the application. `pure`: it only reads data — it changes nothing on screen, so
 * it may run while another task holds the screen. Everything else changes shared state (page, patient,
 * form, confirmation) and runs one at a time.
 */
export const TOOL_EXECUTION: Record<string, { type: ExecutionType; pure?: boolean }> = {
  // shared application capabilities
  open_page: { type: 'CONTEXT' },
  go_back: { type: 'CONTEXT' },
  scroll_page: { type: 'CONTEXT' },
  control_list: { type: 'CONTEXT' },
  fill_open_form: { type: 'CONTEXT' },
  clear_form_field: { type: 'CONTEXT' },
  save_open_form: { type: 'WRITE' },
  confirm_pending_action: { type: 'WRITE' },
  cancel_pending_action: { type: 'CONTEXT' },
  wait_for_more_speech: { type: 'READ_ONLY', pure: true },
  not_my_task: { type: 'READ_ONLY', pure: true },
  // patients — a search shows its results on the Patients page: read-only, but not pure
  search_patients: { type: 'READ_ONLY' },
  select_patient: { type: 'CONTEXT' },
  clear_selected_patient: { type: 'CONTEXT' },
  create_patient: { type: 'WRITE' },
  edit_patient: { type: 'WRITE' },
  delete_patient: { type: 'WRITE' },
  // dashboard
  get_provider_overview: { type: 'READ_ONLY', pure: true },
  dashboard_summary_panel: { type: 'CONTEXT' },
  // appointments
  list_my_appointments: { type: 'READ_ONLY' },
  cancel_my_appointment: { type: 'WRITE' },
  reschedule_my_appointment: { type: 'WRITE' },
  cancel_patient_appointment: { type: 'WRITE' },
  reschedule_patient_appointment: { type: 'WRITE' },
  add_appointments: { type: 'WRITE' },
  // summaries (the Summary Agent's are written by code + its model; the single assistant has the tool)
  summarize: { type: 'READ_ONLY' },
  get_patient_summary: { type: 'READ_ONLY', pure: true },
  patient_summary_panel: { type: 'CONTEXT' },
  // a patient's records (each kind its own agent's) and clinical notes
  add_care_plan: { type: 'WRITE' },
  add_medications: { type: 'WRITE' },
  add_diagnoses: { type: 'WRITE' },
  add_tasks: { type: 'WRITE' },
  add_recalls: { type: 'WRITE' },
  update_record: { type: 'WRITE' },
  delete_record: { type: 'WRITE' },
  list_records: { type: 'READ_ONLY' },
  take_clinical_note: { type: 'CONTEXT' },
  add_extracted_item: { type: 'WRITE' },
  // inbox
  inbox_show: { type: 'READ_ONLY' },
  inbox_open_item: { type: 'READ_ONLY' },
  inbox_file_item: { type: 'WRITE' },
  inbox_add_comment: { type: 'WRITE' },
  inbox_select_item_patient: { type: 'CONTEXT' },
  // the master's own
  assign_tasks: { type: 'READ_ONLY', pure: true },
  get_ai_configuration: { type: 'READ_ONLY', pure: true },
  set_language_model: { type: 'WRITE' },
  set_speech_recognition: { type: 'WRITE' },
  sign_out: { type: 'CONTEXT' },
  spoken_replies: { type: 'CONTEXT' },
  sidebar: { type: 'CONTEXT' },
  show_help: { type: 'CONTEXT' },
  stop_listening: { type: 'CONTEXT' },
};

/** A tool nobody classified is treated as the strictest kind. */
export const toolExecution = (name: string) => TOOL_EXECUTION[name] ?? { type: 'WRITE' as ExecutionType };

export const NOT_MY_TASK_TOOL = 'not_my_task';

/**
 * A specialist's way back to the master: what it was given is another agent's work, or what the
 * provider said is not an answer to the question its task left open. It ends the specialist's turn.
 */
export const notMyTaskTool = defineTool({
  name: NOT_MY_TASK_TOOL,
  description:
    "SAID is not something your tools do (it belongs to another part of the app), or it is not an answer to the pending question or confirmation — hand it back to the master instead of guessing. Never use it for something your tools can do.",
  parameters: z.object({
    reason: z.string().optional(),
    better_agent: z.enum(AGENT_NAMES as [AgentName, ...AgentName[]]).optional().describe(`The agent it belongs to, if you know: ${AGENT_NAMES.join(', ')}`),
  }),
  run: async () => ({ ok: true, message: 'Handed back to the master.', final: true }),
});

/**
 * The master's own tools: orchestration, and the application itself (not any domain's records). Its skill
 * (src/agents/master-agent) lists them; assign_tasks is built by the orchestrator itself.
 */
export const MASTER_TOOLS = agentToolNames('master').filter((n) => n !== 'assign_tasks');

/**
 * A specialist's tool list, as its skill lists them (allowed-tools: its own, then the shared ones of
 * specialist-agent-rules). The record tools work on the skill's record-kinds only: each kind has one owner (the
 * Medication Agent's medications, the Appointments Agent's appointments …). The Summary Agent has none.
 */
export function specialistTools(agent: AgentName, all: readonly Tool[]): Tool[] {
  const byName = new Map(all.map((t) => [t.name, t]));
  if (!agentToolNames(agent).length) return [];
  const kinds = agentRecordKinds(agent);
  const scoped: Partial<Record<string, Tool>> = kinds.length ? recordKindTools(kinds) : {};
  return agentToolNames(agent)
    .map((n) => (n === NOT_MY_TASK_TOOL ? notMyTaskTool : (scoped[n] ?? byName.get(n))))
    .filter((t): t is Tool => !!t);
}

// ------------------------------------------------------------------------------------------ prompts

/**
 * A specialist's instructions: what every specialist is told first and identically (specialist-agent-rules,
 * a shared prefix for the prompt cache), then its own skill. Safety is not repeated there: the runtime
 * enforces the patient context and the confirmations whatever the model says.
 */
export const specialistPrompt = (agent: AgentName) => agentPrompt(agent);
