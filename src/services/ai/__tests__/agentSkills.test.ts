/**
 * Every agent is an Agent Skill of its own (src/agents/<name>/SKILL.md, https://agentskills.io/specification):
 * the files follow the specification, every tool a skill allows exists, and the agents the app builds are
 * exactly what the skills say — instructions and tools.
 */
import { describe, expect, it } from 'vitest';
import { buildTools } from '../agent/tools';
import type { AgentName } from '@/types/ai';
import { AGENT_NAMES } from '../agents/taskGraph';
import { MASTER_PROMPT } from '../agents/master';
import { MASTER_TOOLS, specialistPrompt, specialistTools } from '../agents/specialists';
import { AGENT_SKILLS, agentToolNames, parseSkill, SKILLS, validateSkill } from '../agents/skills';

describe('the agents as Agent Skills', () => {
  it('one skill per agent — the master, the Planning and Safety Agents and every specialist — plus the rules every specialist extends', () => {
    expect([...SKILLS.keys()].sort()).toEqual([
      'appointments-agent',
      'dashboard-agent',
      'diagnoses-agent',
      'inbox-agent',
      'master-agent',
      'medications-agent',
      'notes-agent',
      'patient-appointments-agent',
      'patients-agent',
      'planning-agent',
      'recalls-agent',
      'safety-agent',
      'specialist-agent-rules',
      'summary-agent',
      'tasks-agent',
    ]);
    expect(Object.fromEntries(Object.entries(AGENT_SKILLS).map(([agent, skill]) => [agent, skill.name]))).toEqual({
      master: 'master-agent',
      planning: 'planning-agent',
      safety: 'safety-agent',
      patients: 'patients-agent',
      dashboard: 'dashboard-agent',
      appointments: 'appointments-agent',
      patient_appointments: 'patient-appointments-agent',
      medications: 'medications-agent',
      diagnoses: 'diagnoses-agent',
      tasks: 'tasks-agent',
      recalls: 'recalls-agent',
      notes: 'notes-agent',
      summary: 'summary-agent',
      inbox: 'inbox-agent',
    });
  });

  it('every SKILL.md follows the specification', () => {
    for (const skill of SKILLS.values()) {
      expect(validateSkill(skill), skill.dir).toEqual([]);
      expect(skill.description.length).toBeGreaterThan(80); // says what it does AND when to use it
    }
  });

  it('every tool a skill allows is a real tool', () => {
    const real = new Set([...buildTools().map((t) => t.name), 'assign_tasks', 'not_my_task', 'submit_requirements', 'not_an_answer', 'report_review']);
    for (const skill of SKILLS.values()) for (const tool of skill.allowedTools) expect(real.has(tool), `${skill.name}: ${tool}`).toBe(true);
  });

  it('the agents run on their skills: the body is the prompt, allowed-tools the tool list, in order', () => {
    const all = buildTools();
    expect(MASTER_PROMPT).toBe(AGENT_SKILLS.master.body);
    expect([...MASTER_TOOLS, 'assign_tasks']).toEqual(agentToolNames('master'));
    const rules = SKILLS.get('specialist-agent-rules')!;
    for (const agent of AGENT_NAMES.filter((a) => a !== 'summary')) {
      // The shared rules come first and are identical for every specialist (one cached prefix).
      expect(specialistPrompt(agent)).toBe(`${rules.body}

${AGENT_SKILLS[agent].body}`);
      expect(specialistTools(agent, all).map((t) => t.name)).toEqual([...AGENT_SKILLS[agent].allowedTools, ...rules.allowedTools]);
    }
    // The Summary Agent only writes: its skill is its prompt, and it has no tools at all — any model can run it.
    expect(specialistPrompt('summary')).toBe(AGENT_SKILLS.summary.body);
    expect(specialistTools('summary', all)).toEqual([]);
    // The record tools work on the skill's record-kinds only: one owner per kind.
    const kinds = (agent: AgentName) => (specialistTools(agent, all).find((t) => t.name === 'list_records')!.parameters as unknown as { shape: { kind: { options: string[] } } }).shape.kind.options;
    expect(kinds('medications')).toEqual(['medication']);
    expect(kinds('diagnoses')).toEqual(['diagnosis']);
    expect(kinds('tasks')).toEqual(['task']);
    expect(kinds('recalls')).toEqual(['recall']);
    expect(kinds('patient_appointments')).toEqual(['appointment']);
    expect(specialistTools('appointments', all).map((t) => t.name)).not.toContain('list_records'); // the provider's own only
  });

  it('reads Windows line endings, quoted values and metadata — and says what is wrong with a bad skill', () => {
    const text = ['---', 'name: test-agent', 'description: "Does a thing: \\"quoted\\". Use when testing."', 'metadata:', '  agent: "patients"', "  title: 'It''s me'", 'allowed-tools: a b  c', '---', '', 'Body line one.', 'Line two.', ''].join('\r\n');
    const skill = parseSkill(text, 'test-agent');
    expect(skill).toMatchObject({ name: 'test-agent', description: 'Does a thing: "quoted". Use when testing.', metadata: { agent: 'patients', title: "It's me" }, allowedTools: ['a', 'b', 'c'], body: 'Body line one.\nLine two.' });
    expect(validateSkill(skill)).toEqual([]);
    const bad = parseSkill('---\nname: Bad--Name-\ndescription: ""\n---\n', 'other');
    expect(validateSkill(bad).join(' | ')).toMatch(/lowercase.*hyphen.*consecutive.*must match its folder.*description is required.*instructions .* are empty/);
    expect(() => parseSkill('no frontmatter', 'x')).toThrow(/frontmatter/);
  });
});
