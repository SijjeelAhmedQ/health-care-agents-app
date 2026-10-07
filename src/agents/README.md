# CareFlow's agents — one Agent Skill each

Every agent of the voice assistant is defined on its own, as an [Agent Skill](https://agentskills.io/specification):
a folder with a `SKILL.md` — YAML frontmatter, then the agent's instructions in Markdown.

| Folder | Agent |
| - | - |
| `master-agent/` | Master Agent — plans each request as tasks and hands them out (the whole assistant in single-agent mode) |
| `planning-agent/` | Planning Agent — gathers what each task needs from what was said, and asks for what is missing, before anything runs (multi-agent mode) |
| `safety-agent/` | Safety Agent — every value any agent sends to the app must have been said (or be the app's own); rules as code on every call, plus its own model (Configuration → Agents) reviewing risky calls with `report_review` (`src/services/ai/safety`) |
| `patients-agent/` | Patients Agent |
| `dashboard-agent/` | Dashboard Agent — questions about the provider's own day |
| `appointments-agent/` | My Appointment Agent — the provider's own appointments |
| `patient-appointments-agent/` | Appointments Agent — patients' appointments |
| `medications-agent/` | Medication Agent |
| `diagnoses-agent/` | Diagnoses Agent |
| `tasks-agent/` | Tasks Agent |
| `recalls-agent/` | Recalls Agent |
| `notes-agent/` | Notes Agent — dictated clinical notes and the AI Summary's items |
| `summary-agent/` | Summary Agent — every summary; no tools (the app gathers the data, the model only writes), so it runs on MedGemma too |
| `inbox-agent/` | Inbox Agent |
| `specialist-agent-rules/` | Not an agent: the rules and shared tools every specialist extends (`metadata.extends`) |

The app reads these files when it is built (`src/services/ai/agents/skills.ts`):

- **body** → the agent's system prompt. A specialist's prompt is `specialist-agent-rules`' body, then its own.
- **`allowed-tools`** → the tools the agent may call, in the order the model sees them (its own, then the shared ones).
- **`metadata.agent`** → which agent it is (`master`, `patients`, `dashboard`, `appointments`, `patient_appointments`, `medications`, `diagnoses`, `tasks`, `recalls`, `notes`, `summary`, `inbox`).
- **`metadata.record-kinds`** → the record kinds its record tools (`update_record`, `list_records` …) work on — each kind has one owner.

Each folder also holds an `agent.json`, generated from the app's code (never edit it by hand): every tool the agent
has, its parameters, and how it touches the app — `executionType` (`WRITE` mutates data, `CONTEXT` changes the screen
only, `READ_ONLY` reads, `REPORT` is an agent's report to itself), `mutates`, `changesScreen`, `runsAlongsideOthers` —
with a `toolSummary`. Regenerate them with `npm run agents:json` after changing a tool, a skill or `TOOL_EXECUTION`;
`npm test` fails while one is out of date. The app itself never reads them.

The Python bridge serves every agent as an [A2A Agent Card](https://a2a-protocol.org/latest/specification/), built
from these files on each request (`python/services/agent_cards.py`): the Master at
`http://127.0.0.1:8765/.well-known/agent-card.json`, the index at `/agents`, one agent at `/agents/<id>/agent-card.json`
(`<id>` = the folder without `-agent`). The agents run inside the web app, so the cards describe them — they take no
A2A messages over the network.

Changing an agent is editing its `SKILL.md`. An invalid skill stops the app from loading, with the reason.
Check them with `npx vitest run src/services/ai/__tests__/agentSkills.test.ts`, or with the specification's own
validator: `uvx --from "git+https://github.com/agentskills/agentskills.git#subdirectory=skills-ref" skills-ref validate src/agents/<folder>`.
