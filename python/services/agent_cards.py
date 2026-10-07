"""
Agent Cards — every CareFlow agent described in the A2A Agent Card format, built from its SKILL.md.

    GET /.well-known/agent-card.json        the Master Agent: the assistant's front door, every agent a skill of it
    GET /agents                             every agent: name, what it does, where its card is
    GET /agents/{id}/agent-card.json        one agent's card (GET /agents/{id} returns the same)

The cards are read from src/agents/*/SKILL.md on every request, so a changed skill is a changed card — there is
nothing to keep in step by hand. The frontmatter is read the way the app reads it (src/services/ai/agents/skills.ts):
`key: value` lines and one nested map, metadata.

What a card does NOT claim: the agents run inside the CareFlow web app, where the Master Agent hands them their
tasks. None of them takes A2A messages over the network yet, so every card says so (capabilities: nothing, and the
`in-app` extension below) instead of advertising an endpoint that would not answer.
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

AGENTS_DIR = Path(os.getenv("CAREFLOW_AGENTS_DIR", Path(__file__).resolve().parents[2] / "src" / "agents"))
PROTOCOL_VERSION = "0.3.0"
#: The folder of the rules every specialist extends — not an agent of its own.
SHARED_RULES = "specialist-agent-rules"
IN_APP = {
    "uri": "https://careflow.app/a2a/extensions/in-app-agent/v1",
    "description": "Runs inside the CareFlow web app and takes its tasks from the Master Agent there; it does not take A2A messages over the network yet.",
    "required": False,
}


@dataclass
class Skill:
    folder: str
    name: str
    description: str
    metadata: dict[str, str] = field(default_factory=dict)
    tools: list[str] = field(default_factory=list)
    license: str | None = None
    compatibility: str | None = None

    @property
    def id(self) -> str:
        """The agent's id in URLs: its folder without "-agent" (patient-appointments-agent → patient-appointments)."""
        return self.folder.removesuffix("-agent")

    @property
    def title(self) -> str:
        return self.metadata.get("title") or self.name

    @property
    def examples(self) -> list[str]:
        """What the provider says to it — the quoted requests in its description ("add metformin 500 mg twice daily")."""
        return [e for e in re.findall(r'"([^"]{3,})"', self.description)]


def _scalar(raw: str) -> str:
    v = raw.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
        if raw.strip()[0] == '"':
            v = v.replace('\\"', '"').replace("\\\\", "\\")
    return v


def parse_skill(text: str, folder: str) -> Skill:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"{folder}/SKILL.md must start with YAML frontmatter (---)")
    try:
        end = lines.index("---", 1)
    except ValueError:
        raise ValueError(f"{folder}/SKILL.md: the frontmatter is not closed (---)") from None
    fields: dict[str, str] = {}
    metadata: dict[str, str] = {}
    in_map: str | None = None
    for line in lines[1:end]:
        if not line.strip() or line.strip().startswith("#"):
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise ValueError(f'{folder}/SKILL.md: "{line.strip()}" is not a key: value line')
        if line[:1].isspace():
            if in_map != "metadata":
                raise ValueError(f'{folder}/SKILL.md: "{key.strip()}" is indented, but only metadata holds keys')
            metadata[key.strip()] = _scalar(value)
            continue
        in_map = None if value.strip() else key.strip()
        if in_map is None:
            fields[key.strip()] = _scalar(value)
    return Skill(
        folder=folder,
        name=fields.get("name", ""),
        description=fields.get("description", ""),
        metadata=metadata,
        tools=fields.get("allowed-tools", "").split(),
        license=fields.get("license"),
        compatibility=fields.get("compatibility"),
    )


def load_skills(root: Path | None = None) -> dict[str, Skill]:
    """Every SKILL.md under the agents folder, by folder name (the shared rules included)."""
    base = root or AGENTS_DIR
    skills: dict[str, Skill] = {}
    for path in sorted(base.glob("*/SKILL.md")):
        skills[path.parent.name] = parse_skill(path.read_text(encoding="utf-8"), path.parent.name)
    return skills


def agents(root: Path | None = None) -> list[Skill]:
    """The agents (every skill with metadata.agent), the Master first."""
    found = [s for s in load_skills(root).values() if s.metadata.get("agent")]
    return sorted(found, key=lambda s: (s.metadata.get("agent") != "master", s.folder))


def _tools(skill: Skill, skills: dict[str, Skill]) -> list[str]:
    """Its own tools, then the shared ones of the skill it extends (the order the model sees them in the app)."""
    base = skills.get(skill.metadata.get("extends", ""))
    shared = [t for t in (base.tools if base else []) if t not in skill.tools]
    return [*skill.tools, *shared]


def agent_json(skill: Skill, root: Path | None = None) -> dict[str, Any] | None:
    """Its agent.json — generated from the app's code (npm run agents:json): every tool, and whether it mutates."""
    path = (root or AGENTS_DIR) / skill.folder / "agent.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        return None


def _kind(skill: Skill) -> str:
    role = skill.metadata.get("role")
    if role:
        return role
    return "specialist" if skill.metadata.get("extends") == SHARED_RULES else "agent"


def _skill_entry(skill: Skill) -> dict[str, Any]:
    tags = [t for t in [_kind(skill), *skill.metadata.get("record-kinds", "").split()] if t]
    entry: dict[str, Any] = {"id": skill.id, "name": skill.title, "description": skill.description, "tags": tags}
    if skill.examples:
        entry["examples"] = skill.examples
    return entry


def card_url(base_url: str, skill: Skill) -> str:
    return f"{base_url}/.well-known/agent-card.json" if skill.metadata.get("agent") == "master" else f"{base_url}/agents/{skill.id}/agent-card.json"


def agent_card(skill: Skill, base_url: str, root: Path | None = None) -> dict[str, Any]:
    """One agent's A2A Agent Card. The Master's lists every agent as one of its skills — it is the way in."""
    skills = load_skills(root)
    team = agents(root)
    master = skill.metadata.get("agent") == "master"
    card: dict[str, Any] = {
        "protocolVersion": PROTOCOL_VERSION,
        "name": skill.title,
        "description": skill.description,
        "url": f"{base_url}/agents/{skill.id}",
        "version": skill.metadata.get("version", "1.0"),
        "provider": {"organization": "CareFlow", "url": base_url},
        "capabilities": {"streaming": False, "pushNotifications": False, "stateTransitionHistory": False, "extensions": [IN_APP]},
        # The provider speaks; the bridge's speech recognition turns it into the text every agent reads.
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [_skill_entry(s) for s in team if s.metadata.get("agent") != "master"] if master else [_skill_entry(skill)],
        "supportsAuthenticatedExtendedCard": False,
        # CareFlow's own fields: what the agent is in the app, and the file it is defined in.
        "careflow": {
            "agent": skill.metadata.get("agent"),
            "kind": _kind(skill),
            "skillFile": f"src/agents/{skill.folder}/SKILL.md",
            "tools": _tools(skill, skills),
            **({"recordKinds": skill.metadata["record-kinds"].split()} if skill.metadata.get("record-kinds") else {}),
            **({"extends": skill.metadata["extends"]} if skill.metadata.get("extends") else {}),
            **({"runtime": skill.metadata["runtime"]} if skill.metadata.get("runtime") else {}),
            **({"compatibility": skill.compatibility} if skill.compatibility else {}),
            **({"agents": [{"id": s.id, "name": s.title, "card": card_url(base_url, s)} for s in team]} if master else {}),
        },
    }
    if skill.license:
        card["careflow"]["license"] = skill.license
    # Each tool as the app has it — what it does, its parameters, whether it mutates — when agent.json is there.
    generated = agent_json(skill, root)
    if generated:
        card["careflow"]["toolSummary"] = generated.get("toolSummary")
        card["careflow"]["legend"] = generated.get("legend")
        card["careflow"]["tools"] = generated.get("tools", card["careflow"]["tools"])
        card["careflow"]["agentJson"] = f"src/agents/{skill.folder}/agent.json"
    return card


def find(agent_id: str, root: Path | None = None) -> Skill | None:
    """An agent by its URL id (medications, patient-appointments), its folder, or metadata.agent (patient_appointments)."""
    for s in agents(root):
        if agent_id in (s.id, s.folder, s.metadata.get("agent")):
            return s
    return None


def index(base_url: str, root: Path | None = None) -> dict[str, Any]:
    team = agents(root)
    return {
        "count": len(team),
        "agents": [
            {
                "id": s.id,
                "name": s.title,
                "kind": _kind(s),
                "description": s.description,
                "card": card_url(base_url, s),
                "json": f"{base_url}/agents/{s.id}/agent.json",
                **({"mutatingTools": j["toolSummary"]["mutatingTools"]} if (j := agent_json(s, root)) and j.get("toolSummary") else {}),
            }
            for s in team
        ],
    }
