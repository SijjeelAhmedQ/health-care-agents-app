"""
Agent Cards — every agent's A2A card, built from its SKILL.md, served by the bridge:

    /.well-known/agent-card.json      the Master Agent, every other agent one of its skills
    /agents                           the index
    /agents/{id}/agent-card.json      one agent

    cd python && .venv/Scripts/python -m unittest tests.test_agent_cards -v
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["CAREFLOW_STT_ENGINE"] = "mock"
os.environ["CAREFLOW_STT_REFINE"] = ""

from services import agent_cards, compute as compute_mod, stt_catalog  # noqa: E402

_tmp = tempfile.TemporaryDirectory()
stt_catalog.SETTINGS_FILE = Path(_tmp.name) / "stt_settings.json"
compute_mod.COMPUTE_FILE = Path(_tmp.name) / "compute_settings.json"

from fastapi.testclient import TestClient  # noqa: E402

import app as bridge  # noqa: E402

AGENT_IDS = {
    "master", "planning", "safety", "patients", "dashboard", "appointments", "patient-appointments",
    "medications", "diagnoses", "tasks", "recalls", "notes", "summary", "inbox",
}
REQUIRED = {"protocolVersion", "name", "description", "url", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"}


class SkillsTest(unittest.TestCase):
    def test_every_skill_with_an_agent_is_an_agent__the_shared_rules_are_not(self):
        ids = [s.id for s in agent_cards.agents()]
        self.assertEqual(set(ids), AGENT_IDS)
        self.assertEqual(ids[0], "master")

    def test_frontmatter_is_read_like_the_app_reads_it(self):
        s = agent_cards.parse_skill(
            '---\nname: x-agent\ndescription: "Use for \\"add metformin\\", \\"stop it\\"."\nmetadata:\n  agent: "x"\n  title: "X Agent"\nallowed-tools: a b\n---\nBody',
            "x-agent",
        )
        self.assertEqual((s.id, s.title, s.tools), ("x", "X Agent", ["a", "b"]))
        self.assertEqual(s.examples, ["add metformin", "stop it"])

    def test_a_broken_skill_says_why(self):
        with self.assertRaisesRegex(ValueError, "frontmatter"):
            agent_cards.parse_skill("name: x", "x-agent")


class AgentCardRoutesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(bridge.app, base_url="http://127.0.0.1:8765")

    def test_the_well_known_card_is_the_master_with_every_agent_as_a_skill(self):
        res = self.client.get("/.well-known/agent-card.json")
        self.assertEqual(res.status_code, 200)
        card = res.json()
        self.assertTrue(REQUIRED <= card.keys())
        self.assertEqual(card["name"], "Master Agent")
        self.assertEqual(card["url"], "http://127.0.0.1:8765/agents/master")
        self.assertEqual({s["id"] for s in card["skills"]}, AGENT_IDS - {"master"})
        self.assertIn({"id": "medications", "name": "Medication Agent", "card": "http://127.0.0.1:8765/agents/medications/agent-card.json"}, card["careflow"]["agents"])
        self.assertEqual(self.client.get("/.well-known/agent.json").json(), card)

    def test_a_specialist_card_holds_its_own_tools_then_the_shared_ones(self):
        card = self.client.get("/agents/medications/agent-card.json").json()
        self.assertEqual(card["name"], "Medication Agent")
        self.assertEqual(card["careflow"]["skillFile"], "src/agents/medications-agent/SKILL.md")
        self.assertEqual(card["careflow"]["recordKinds"], ["medication"])
        tools = {t["name"]: t for t in card["careflow"]["tools"]}
        self.assertEqual(list(tools)[:4], ["add_medications", "update_record", "delete_record", "list_records"])
        self.assertIn("fill_open_form", tools)
        self.assertIn("add metformin 500 mg twice daily", card["skills"][0]["examples"])

    def test_each_tool_says_whether_it_mutates__from_the_generated_agent_json(self):
        card = self.client.get("/agents/medications/agent-card.json").json()
        tools = {t["name"]: t for t in card["careflow"]["tools"]}
        self.assertTrue(tools["add_medications"]["mutates"])
        self.assertEqual(tools["delete_record"]["executionType"], "WRITE")
        self.assertFalse(tools["list_records"]["mutates"])
        self.assertIn("delete_record", card["careflow"]["toolSummary"]["mutatingTools"])
        self.assertEqual(self.client.get("/agents/medications/agent.json").json()["toolSummary"], card["careflow"]["toolSummary"])

    def test_without_its_agent_json_a_card_still_lists_the_tools_by_name(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root) / "x-agent"
            folder.mkdir()
            (folder / "SKILL.md").write_text('---\nname: x-agent\ndescription: "X"\nmetadata:\n  agent: "x"\nallowed-tools: a b\n---\n', encoding="utf-8")
            skill = agent_cards.find("x", Path(root))
            self.assertEqual(agent_cards.agent_card(skill, "http://h", Path(root))["careflow"]["tools"], ["a", "b"])

    def test_no_card_claims_what_the_agents_cannot_do_over_the_network(self):
        card = self.client.get("/agents/safety").json()
        caps = card["capabilities"]
        self.assertFalse(caps["streaming"] or caps["pushNotifications"])
        self.assertEqual(caps["extensions"][0]["uri"], agent_cards.IN_APP["uri"])
        self.assertEqual(card["careflow"]["runtime"], "code + model")

    def test_an_agent_is_found_by_its_app_name_too(self):
        self.assertEqual(self.client.get("/agents/patient_appointments").json()["name"], "Appointments Agent")

    def test_the_index_lists_every_card(self):
        body = self.client.get("/agents").json()
        self.assertEqual(body["count"], len(AGENT_IDS))
        for a in body["agents"]:
            self.assertEqual(self.client.get(a["card"].removeprefix("http://127.0.0.1:8765")).status_code, 200)

    def test_an_unknown_agent_is_404_with_the_ones_there_are(self):
        res = self.client.get("/agents/pharmacy/agent-card.json")
        self.assertEqual(res.status_code, 404)
        self.assertIn("medications", res.json()["detail"])


if __name__ == "__main__":
    unittest.main()
