/**
 * The agents, each defined on its own as an Agent Skill (https://agentskills.io/specification):
 *
 *   src/agents/
 *     master-agent/SKILL.md            the orchestrator
 *     planning-agent/SKILL.md          requirement gathering before anything runs
 *     safety-agent/SKILL.md            hallucination prevention (its policy — it runs as code, no model)
 *     specialist-agent-rules/SKILL.md  the rules (and shared tools) every specialist extends
 *     patients-agent/SKILL.md              ┐
 *     dashboard-agent/SKILL.md             │
 *     appointments-agent/SKILL.md          │ the specialists: My Appointment (the provider's own),
 *     patient-appointments-agent/SKILL.md  │ Appointments (patients'), one agent per record kind,
 *     medications-agent/SKILL.md           │ Notes, Summary (writes summaries, no tools) and Inbox
 *     diagnoses-agent/SKILL.md             │
 *     tasks-agent/SKILL.md                 │
 *     recalls-agent/SKILL.md               │
 *     notes-agent/SKILL.md                 │
 *     summary-agent/SKILL.md               │
 *     inbox-agent/SKILL.md                 ┘
 *
 * A SKILL.md is YAML frontmatter and a Markdown body:
 *   name           the folder's name (lowercase letters, digits, single hyphens; at most 64)
 *   description    what the agent does and when to use it (at most 1024)
 *   metadata       agent (which agent it is), title, extends (a skill whose body and tools come first),
 *                  record-kinds (the record kinds its record tools work on)
 *   allowed-tools  the tools it may call, space-separated, in the order the model sees them
 *   body           its instructions — the agent's system prompt
 *
 * The files are read at build time; an invalid one stops the app loading rather than running an agent
 * on half its instructions.
 */
import type { AgentName } from '@/types/ai';
import { RECORD_KINDS, type RecordKind } from '@/types/records';
import { AGENT_NAMES } from './taskGraph';

export type AgentSkillKey = 'master' | 'planning' | 'safety' | AgentName;

export interface AgentSkill {
  /** The folder it was read from. */
  dir: string;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  allowedTools: string[];
  /** The instructions: the Markdown after the frontmatter. */
  body: string;
}

// ------------------------------------------------------------------------------------------ parsing

/** A frontmatter value: a double-quoted string as YAML/JSON reads it, a single-quoted one, or plain text. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return JSON.parse(v) as string;
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * A SKILL.md, read. The frontmatter is the YAML subset the spec's fields need: `key: value` lines, and one
 * nested map (metadata) of `key: value` lines indented under it.
 */
export function parseSkill(text: string, dir: string): AgentSkill {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trim() !== '---') throw new Error(`${dir}/SKILL.md must start with YAML frontmatter (---)`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${dir}/SKILL.md: the frontmatter is not closed (---)`);
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMap: string | null = null;
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^\s+/.test(line);
    const at = line.indexOf(':');
    if (at < 0) throw new Error(`${dir}/SKILL.md: "${line.trim()}" is not a key: value line`);
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1);
    if (nested) {
      if (inMap !== 'metadata') throw new Error(`${dir}/SKILL.md: "${key}" is indented, but only metadata holds keys`);
      metadata[key] = scalar(value);
      continue;
    }
    inMap = value.trim() ? null : key;
    if (!inMap) fields[key] = scalar(value);
  }
  const body = lines
    .slice(end + 1)
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
  return {
    dir,
    name: fields.name ?? '',
    description: fields.description ?? '',
    license: fields.license,
    compatibility: fields.compatibility,
    metadata,
    allowedTools: (fields['allowed-tools'] ?? '').split(/\s+/).filter(Boolean),
    body,
  };
}

/** What the specification asks of a skill — every way this one falls short ([] when it is valid). */
export function validateSkill(skill: AgentSkill): string[] {
  const problems: string[] = [];
  const where = `${skill.dir}/SKILL.md`;
  if (!skill.name) problems.push(`${where}: name is required`);
  else {
    if (skill.name.length > 64) problems.push(`${where}: name is longer than 64 characters`);
    if (!/^[a-z0-9-]+$/.test(skill.name)) problems.push(`${where}: name may only hold lowercase letters, digits and hyphens`);
    if (skill.name.startsWith('-') || skill.name.endsWith('-')) problems.push(`${where}: name must not start or end with a hyphen`);
    if (skill.name.includes('--')) problems.push(`${where}: name must not hold consecutive hyphens`);
    if (skill.name !== skill.dir) problems.push(`${where}: name "${skill.name}" must match its folder "${skill.dir}"`);
  }
  if (!skill.description.trim()) problems.push(`${where}: description is required`);
  if (skill.description.length > 1024) problems.push(`${where}: description is longer than 1024 characters`);
  if (skill.compatibility !== undefined && (skill.compatibility.length < 1 || skill.compatibility.length > 500)) problems.push(`${where}: compatibility must be 1–500 characters`);
  if (!skill.body) problems.push(`${where}: the instructions (the Markdown after the frontmatter) are empty`);
  if (skill.body.split('\n').length > 500) problems.push(`${where}: keep SKILL.md under 500 lines — move detail into references/`);
  return problems;
}

// ------------------------------------------------------------------------------------------ loading

const FILES = import.meta.glob('/src/agents/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** Every skill in src/agents, by name. */
export const SKILLS: ReadonlyMap<string, AgentSkill> = new Map(
  Object.entries(FILES).map(([path, text]) => {
    const dir = path.split('/').slice(-2, -1)[0];
    const skill = parseSkill(text, dir);
    return [skill.name, skill];
  }),
);

/** Which skill each agent is (metadata.agent), checked: the app does not start on an invalid agent. */
function agentSkills(): Record<AgentSkillKey, AgentSkill> {
  const problems = [...SKILLS.values()].flatMap(validateSkill);
  const byAgent: Partial<Record<AgentSkillKey, AgentSkill>> = {};
  for (const skill of SKILLS.values()) {
    const agent = skill.metadata.agent as AgentSkillKey | undefined;
    if (!agent) continue;
    if (byAgent[agent]) problems.push(`Two skills are the ${agent} agent: ${byAgent[agent]!.name} and ${skill.name}`);
    byAgent[agent] = skill;
    const base = skill.metadata.extends;
    if (base && !SKILLS.has(base)) problems.push(`${skill.name} extends "${base}", which is not a skill in src/agents`);
    for (const kind of (skill.metadata['record-kinds'] ?? '').split(/\s+/).filter(Boolean)) {
      if (!(RECORD_KINDS as readonly string[]).includes(kind)) problems.push(`${skill.name}: record-kinds holds "${kind}", which is not a record kind`);
    }
  }
  for (const agent of ['master', 'planning', 'safety', ...AGENT_NAMES] as const) {
    if (!byAgent[agent]) problems.push(`No skill in src/agents is the ${agent} agent (metadata.agent: ${agent})`);
  }
  if (problems.length) throw new Error(`The agents in src/agents are not valid:\n- ${problems.join('\n- ')}`);
  return byAgent as Record<AgentSkillKey, AgentSkill>;
}

export const AGENT_SKILLS: Readonly<Record<AgentSkillKey, AgentSkill>> = agentSkills();

const baseOf = (skill: AgentSkill) => (skill.metadata.extends ? SKILLS.get(skill.metadata.extends) : undefined);

/** An agent's system prompt: the skill it extends first (a prefix every specialist shares), then its own. */
export function agentPrompt(agent: AgentSkillKey): string {
  const skill = AGENT_SKILLS[agent];
  const base = baseOf(skill);
  return base ? `${base.body}\n\n${skill.body}` : skill.body;
}

/** The tools an agent may call, in order: its own, then those of the skill it extends. */
export function agentToolNames(agent: AgentSkillKey): string[] {
  const skill = AGENT_SKILLS[agent];
  return [...skill.allowedTools, ...(baseOf(skill)?.allowedTools ?? [])];
}

/** The agent that owns a kind of record (its skill's record-kinds): the one that adds, changes, deletes and lists it. */
export function recordOwner(kind: RecordKind): AgentName | undefined {
  return AGENT_NAMES.find((agent) => agentRecordKinds(agent).includes(kind));
}

/** The record kinds an agent's record tools (update_record, list_records …) work on — [] when it has none. */
export function agentRecordKinds(agent: AgentSkillKey): RecordKind[] {
  return (AGENT_SKILLS[agent].metadata['record-kinds'] ?? '').split(/\s+/).filter(Boolean) as RecordKind[];
}
