/**
 * Every agent as a JSON file (src/agents/<folder>/agent.json): who it is, and every tool it has — what the tool
 * does, its parameters, and how it touches the app (whether it MUTATES data, changes the screen, or only reads).
 *
 * The files are generated, never written by hand: this test builds the agents exactly as the app builds them
 * (MultiAgentOrchestrator, the Planning Agent, the Safety Agent's reviewer) and reads the tools they were given.
 * It only reads — nothing here changes how any agent works.
 *
 *   npm run agents:json      regenerate the files (after changing a tool, a skill or TOOL_EXECUTION)
 *   npm test                 fails when a file no longer matches the code — so a card never says a tool is safe
 *                            when it is not
 *
 * The bridge serves them inside each agent's A2A card (python/services/agent_cards.py).
 */
import { describe, expect, it } from 'vitest';
import type { AIContext, AgentName } from '@/types/ai';
import type { AppRuntime } from '../agent/runtime';
import type { ChatLLM, ToolSchema } from '../providers/llm';
import type { Agent } from '../agent/agent';
import { buildTools } from '../agent/tools';
import { MultiAgentOrchestrator } from '../agents/master';
import { TOOL_EXECUTION } from '../agents/specialists';
import { AGENT_SKILLS, SKILLS, agentRecordKinds, agentToolNames, type AgentSkillKey } from '../agents/skills';
import { AGENT_NAMES } from '../agents/taskGraph';
import { SafetyReviewer } from '../safety/reviewer';

/** A model that is never asked anything — the agents are only built here, not run. */
const idle = (seen?: ToolSchema[][]): ChatLLM => ({
  name: 'none',
  chat: async (_messages, tools) => {
    seen?.push(tools);
    return { content: '', toolCalls: [] };
  },
});

const schemasOf = (agent: Agent) => (agent as unknown as { schemas: ToolSchema[] }).schemas;

/** The agents as the app builds them, and the tool schemas each one's model is given. */
async function builtAgents(): Promise<Record<AgentSkillKey, ToolSchema[]>> {
  const orchestrator = new MultiAgentOrchestrator(idle(), {} as AppRuntime, () => ({}) as AIContext, { maxSteps: 4, planning: true });
  orchestrator.setTools(buildTools());
  // The reviewer's one tool is handed to its model with each review: asked once here, to see it.
  const seen: ToolSchema[][] = [];
  await new SafetyReviewer(idle(seen)).review({ name: 'update_record', arguments: {} }, ['']);
  return {
    master: schemasOf(orchestrator.master),
    planning: schemasOf(orchestrator.planning!.agent),
    safety: seen[0] ?? [],
    ...(Object.fromEntries(AGENT_NAMES.map((name) => [name, schemasOf(orchestrator.specialists[name])])) as Record<AgentName, ToolSchema[]>),
  };
}

/** What a tool's executionType means, written into every file. */
const LEGEND = {
  WRITE: 'Mutates: adds, changes or deletes data (or a setting). A patient record is saved or deleted only after the provider confirms.',
  CONTEXT: 'Changes what is on screen — the page, the selected patient, an open form — but saves nothing.',
  READ_ONLY: 'Reads only: changes no data.',
  REPORT: "Reports to its own agent (a plan, a review): not an action on the app.",
  changesScreen: 'Runs one at a time, because it changes the page, a list or a form the provider sees.',
  runsAlongsideOthers: 'Touches nothing on screen, so it may run while another agent holds the screen.',
};

function toolEntry(schema: ToolSchema, shared: ReadonlySet<string>) {
  const { name, description, parameters } = schema.function;
  const exec = TOOL_EXECUTION[name];
  // Tools outside TOOL_EXECUTION are the Planning and Safety Agents' reports to themselves (submit_requirements,
  // not_an_answer, report_review): the app never runs them as actions.
  const type = exec?.type ?? 'REPORT';
  return {
    name,
    executionType: type,
    mutates: type === 'WRITE',
    changesScreen: !!exec && !exec.pure,
    runsAlongsideOthers: !exec || !!exec.pure,
    ...(shared.has(name) ? { sharedWithEverySpecialist: true } : {}),
    description,
    parameters,
  };
}

function agentJson(key: AgentSkillKey, tools: ToolSchema[]) {
  const skill = AGENT_SKILLS[key];
  const shared = new Set(key === 'master' || key === 'planning' || key === 'safety' ? [] : (SKILLS.get('specialist-agent-rules')?.allowedTools ?? []));
  const entries = tools.map((t) => toolEntry(t, shared));
  const count = (type: string) => entries.filter((t) => t.executionType === type).length;
  const recordKinds = key === 'master' || key === 'planning' || key === 'safety' ? [] : agentRecordKinds(key);
  return {
    $comment: 'Generated from the app\'s code by src/services/ai/__tests__/agentJson.test.ts — do not edit by hand; run "npm run agents:json".',
    id: skill.dir.replace(/-agent$/, ''),
    agent: key,
    name: skill.metadata.title ?? skill.name,
    skill: `src/agents/${skill.dir}/SKILL.md`,
    version: skill.metadata.version ?? '1.0',
    role: skill.metadata.role ?? (skill.metadata.extends === 'specialist-agent-rules' ? 'specialist' : 'agent'),
    ...(skill.metadata.runtime ? { runtime: skill.metadata.runtime } : {}),
    description: skill.description,
    ...(recordKinds.length ? { recordKinds } : {}),
    toolSummary: {
      total: entries.length,
      mutating: count('WRITE'),
      screenOnly: count('CONTEXT'),
      readOnly: count('READ_ONLY'),
      reports: count('REPORT'),
      mutatingTools: entries.filter((t) => t.mutates).map((t) => t.name),
    },
    legend: LEGEND,
    tools: entries,
  };
}

describe('every agent as a JSON file (src/agents/<folder>/agent.json)', () => {
  it('each file matches the agent the app builds — its tools, and how each touches the app', async () => {
    const built = await builtAgents();
    for (const key of Object.keys(AGENT_SKILLS) as AgentSkillKey[]) {
      const json = agentJson(key, built[key]);
      // Every tool its skill gives it — its own, then a specialist's shared ones — and no other (the Summary Agent
      // has none: the app gathers the data, its model only writes).
      expect(json.tools.map((t) => t.name), key).toEqual(agentToolNames(key));
      await expect(`${JSON.stringify(json, null, 2)}\n`).toMatchFileSnapshot(`../../../agents/${AGENT_SKILLS[key].dir}/agent.json`);
    }
  });

  it('a tool that changes data is never described as read-only', async () => {
    const built = await builtAgents();
    const json = agentJson('medications', built.medications);
    const byName = Object.fromEntries(json.tools.map((t) => [t.name, t]));
    expect(byName.add_medications).toMatchObject({ executionType: 'WRITE', mutates: true, changesScreen: true });
    expect(byName.delete_record).toMatchObject({ executionType: 'WRITE', mutates: true });
    expect(byName.list_records).toMatchObject({ executionType: 'READ_ONLY', mutates: false });
    expect(byName.fill_open_form).toMatchObject({ executionType: 'CONTEXT', mutates: false, sharedWithEverySpecialist: true });
    expect(json.toolSummary.mutatingTools).toEqual(expect.arrayContaining(['add_medications', 'update_record', 'delete_record', 'save_open_form', 'confirm_pending_action']));
  });
});
