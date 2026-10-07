"""
Where the AI runs — the two setups the provider uses, and this computer:

    Kaggle GPU            Whisper on Kaggle  + Qwen on Kaggle, served by vLLM
    Kaggle + OpenRouter   Whisper on Kaggle  + any OpenRouter model that calls tools
    This computer         Omi Med STT here   + Qwen here, in Ollama (the only place Ollama is used)

The Kaggle server and OpenRouter are stood in for (no network); the settings file is a temporary one.

    cd python && .venv/Scripts/python -m unittest tests.test_compute_api -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["CAREFLOW_STT_ENGINE"] = "mock"
os.environ["CAREFLOW_STT_REFINE"] = ""

from services import compute as compute_mod, stt_catalog  # noqa: E402

_tmp = tempfile.TemporaryDirectory()
stt_catalog.SETTINGS_FILE = Path(_tmp.name) / "stt_settings.json"
compute_mod.COMPUTE_FILE = Path(_tmp.name) / "compute_settings.json"

from fastapi.testclient import TestClient  # noqa: E402

import app as bridge  # noqa: E402

KAGGLE = "https://gpu.trycloudflare.com"
HEALTH = {"ok": True, "model": "whisper-large-v3-turbo", "device": "cuda", "gpu": "Tesla T4", "engines": {"whisper": {}, "omi": {}}, "llm": {"ok": True, "engine": "vllm", "models": ["qwen3.5:4b"]}}


class ComputeApiTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(bridge.app)
        self.stt_moves: list[dict] = []
        self.health = dict(HEALTH)
        self.kaggle_up = True
        self.key_ok = True

        def probe_remote(url, key):
            if not self.kaggle_up:
                raise RuntimeError(f"Cannot reach the remote GPU server at {url}")
            return self.health

        def probe_openrouter(key):
            if not self.key_ok:
                raise RuntimeError("OpenRouter rejected the key")
            return {"ok": True, "limit_remaining": 4.45}

        async def apply_stt(settings):
            self.stt_moves.append({"engine": settings.engine, "remote_engine": getattr(settings, "remote_engine", None)})
            bridge.stt_settings = settings

        self.originals = (bridge.probe_remote, bridge.probe_openrouter, bridge.apply_stt, bridge.compute, bridge.stt_settings)
        bridge.probe_remote, bridge.probe_openrouter, bridge.apply_stt = probe_remote, probe_openrouter, apply_stt
        bridge.compute = compute_mod.ComputeSettings()

    def tearDown(self):
        bridge.probe_remote, bridge.probe_openrouter, bridge.apply_stt, bridge.compute, bridge.stt_settings = self.originals

    def put(self, **body):
        return self.client.put("/api/config/compute", json=body)

    def test_kaggle_gpu_whisper_and_qwen_both_on_kaggle(self):
        res = self.put(mode="remote", speech="remote", remote_url=KAGGLE, remote_key="k", remote_engine="whisper")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((res.json()["mode"], res.json()["speech"]), ("remote", "remote"))
        self.assertEqual(self.stt_moves[-1], {"engine": "remote", "remote_engine": "whisper"})

    def test_kaggle_whisper_with_an_openrouter_model(self):
        res = self.put(mode="openrouter", speech="remote", remote_url=KAGGLE, remote_key="k", remote_engine="whisper", openrouter_key="sk-or-secret", openrouter_model="openai/gpt-6-sol")
        self.assertEqual(res.status_code, 200, res.text)
        status = res.json()
        self.assertEqual((status["mode"], status["speech"], status["openrouter_model"]), ("openrouter", "remote", "openai/gpt-6-sol"))
        self.assertTrue(status["has_openrouter_key"])
        self.assertEqual(self.stt_moves[-1], {"engine": "remote", "remote_engine": "whisper"})  # Whisper on Kaggle
        self.assertNotIn("sk-or-secret", res.text)  # the key never comes back
        saved = json.loads(compute_mod.COMPUTE_FILE.read_text(encoding="utf-8"))
        self.assertEqual((saved["mode"], saved["speech"], saved["openrouter_key"]), ("openrouter", "remote", "sk-or-secret"))

    def test_the_saved_keys_are_kept_when_the_fields_are_left_empty(self):
        bridge.compute = replace(bridge.compute, remote_url=KAGGLE, remote_key="k", openrouter_key="sk-or-saved")
        res = self.put(mode="openrouter", speech="remote", openrouter_model="openai/gpt-6-luna")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((bridge.compute.remote_key, bridge.compute.openrouter_key, bridge.compute.openrouter_model), ("k", "sk-or-saved", "openai/gpt-6-luna"))

    def test_nothing_moves_when_the_kaggle_server_is_down(self):
        self.kaggle_up = False
        res = self.put(mode="openrouter", speech="remote", remote_url=KAGGLE, remote_key="k", openrouter_key="sk-or-x")
        self.assertEqual(res.status_code, 409)
        self.assertIn("Nothing was switched", res.json()["detail"])
        self.assertEqual((bridge.compute.mode, bridge.compute.speech), ("local", "local"))
        self.assertEqual(self.stt_moves, [])

    def test_nothing_moves_when_openrouter_refuses_the_key(self):
        self.key_ok = False
        res = self.put(mode="openrouter", speech="remote", remote_url=KAGGLE, remote_key="k", openrouter_key="sk-or-bad")
        self.assertEqual(res.status_code, 409)
        self.assertEqual(bridge.compute.mode, "local")
        self.assertEqual(self.stt_moves, [])

    def test_qwen_on_kaggle_needs_the_servers_language_model(self):
        self.health = {**HEALTH, "llm": {"ok": False, "engine": "vllm", "error": "vLLM is not running"}}
        res = self.put(mode="remote", speech="remote", remote_url=KAGGLE, remote_key="k")
        self.assertEqual(res.status_code, 409)
        self.assertIn("vLLM is not running", res.json()["detail"])
        # …but Whisper alone (with OpenRouter thinking) does not need it.
        self.assertEqual(self.put(mode="openrouter", speech="remote", remote_url=KAGGLE, remote_key="k", openrouter_key="sk-or-x").status_code, 200)

    def test_the_tunnel_giving_up_on_a_long_request_is_not_sent_again(self):
        """524: the Kaggle server got the request and still works on it — a copy would queue behind it on the GPU."""
        import httpx

        bridge.compute = replace(bridge.compute, mode="remote", providers=["kaggle"], remote_url=KAGGLE, remote_key="k")
        calls: list[str] = []
        status = {"code": 524}

        def kaggle(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            if status["code"] == 200:
                return httpx.Response(200, json={"choices": []})
            return httpx.Response(status["code"], text="<html>cloudflare</html>", headers={"content-type": "text/html"})

        original = bridge.REMOTE_TRANSPORT
        bridge.REMOTE_TRANSPORT = lambda: httpx.MockTransport(kaggle)
        try:
            res = self.client.post("/vllm/v1/chat/completions", json={"model": "qwen3.5:9b", "messages": []})
            self.assertEqual(res.status_code, 504)
            self.assertIn("still working on it", res.json()["detail"])
            self.assertEqual(len(calls), 1)
            # A 502 page (the request never got through) is still tried again.
            calls.clear()
            status["code"] = 502
            self.assertEqual(self.client.post("/vllm/v1/chat/completions", json={"model": "qwen3.5:9b", "messages": []}).status_code, 502)
            self.assertEqual(len(calls), 3)
        finally:
            bridge.REMOTE_TRANSPORT = original

    def test_a_kaggle_server_that_still_runs_ollama_is_not_used_for_the_language_model(self):
        old = {k: v for k, v in HEALTH.items() if k != "llm"}
        self.health = {**old, "ollama": {"ok": True, "models": ["qwen3.5:4b"]}}
        res = self.put(mode="remote", speech="remote", remote_url=KAGGLE, remote_key="k")
        self.assertEqual(res.status_code, 409)
        self.assertIn("vLLM", res.json()["detail"])
        self.assertEqual(bridge.compute.mode, "local")

    def test_the_language_model_proxies_follow_the_configured_place(self):
        """This computer → Ollama; the Kaggle GPU → vLLM there (with its key); Ollama is refused elsewhere."""
        sent: list[tuple[str, dict]] = []

        async def fake_forward(target, headers, request, remote, where):
            sent.append((target, dict(headers)))
            return bridge.Response(content=b"{}", media_type="application/json")

        original = bridge.forward_llm
        bridge.forward_llm = fake_forward
        try:
            self.assertEqual(self.client.post("/ollama/api/chat", json={}).status_code, 200)
            self.assertEqual(sent[-1][0], f"{bridge.LOCAL_OLLAMA}/api/chat")
            self.assertEqual(self.client.post("/vllm/v1/chat/completions", json={}).status_code, 200)
            self.assertEqual(sent[-1][0], f"{bridge.LOCAL_VLLM}/v1/chat/completions")

            self.put(mode="remote", speech="remote", remote_url=KAGGLE, remote_key="k")
            self.assertEqual(self.client.post("/vllm/v1/chat/completions", json={}).status_code, 200)
            self.assertEqual(sent[-1][0], f"{KAGGLE}/vllm/v1/chat/completions")
            self.assertEqual(sent[-1][1]["X-CareFlow-Key"], "k")
            refused = self.client.post("/ollama/api/chat", json={})
            self.assertEqual(refused.status_code, 409)
            self.assertIn("Ollama is used only for This computer", refused.json()["detail"])

            self.put(mode="openrouter", speech="remote", remote_url=KAGGLE, remote_key="k", openrouter_key="sk-or-x")
            self.assertEqual(self.client.post("/ollama/api/chat", json={}).status_code, 409)
            self.assertEqual(len(sent), 3)  # neither refused request went anywhere
        finally:
            bridge.forward_llm = original

    def test_all_three_providers_at_once_each_agent_can_use_any(self):
        """This computer + Kaggle + OpenRouter together: Ollama, Kaggle's vLLM and OpenRouter all answer."""
        res = self.put(mode="local", providers=["local", "kaggle", "openrouter"], speech="remote", remote_url=KAGGLE, remote_key="k", remote_engine="omi", openrouter_key="sk-or-x")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["providers"], ["local", "kaggle", "openrouter"])
        self.assertEqual(self.stt_moves[-1], {"engine": "remote", "remote_engine": "omi"})
        sent: list[str] = []

        async def fake_forward(target, headers, request, remote, where):
            sent.append(target)
            return bridge.Response(content=b"{}", media_type="application/json")

        original = bridge.forward_llm
        bridge.forward_llm = fake_forward
        try:
            self.assertEqual(self.client.post("/ollama/api/chat", json={}).status_code, 200)
            self.assertEqual(self.client.post("/vllm/v1/chat/completions", json={}).status_code, 200)
        finally:
            bridge.forward_llm = original
        self.assertEqual(sent, [f"{bridge.LOCAL_OLLAMA}/api/chat", f"{KAGGLE}/vllm/v1/chat/completions"])
        # Saved, and read back the same way.
        self.assertEqual(compute_mod.ComputeSettings.load().providers, ["local", "kaggle", "openrouter"])

    def test_providers_are_checked_before_anything_moves(self):
        # The main model must run on a provider that is on…
        self.assertEqual(self.put(mode="openrouter", providers=["local"]).status_code, 400)
        # …Kaggle on means its language model must be ready…
        self.health = {**HEALTH, "llm": {"ok": False, "error": "vLLM is not serving qwen3.5:9b yet"}}
        self.assertEqual(self.put(mode="local", providers=["local", "kaggle"], remote_url=KAGGLE, remote_key="k").status_code, 409)
        # …OpenRouter on needs a key that works.
        self.key_ok = False
        self.assertEqual(self.put(mode="local", providers=["local", "openrouter"], openrouter_key="sk-or-bad").status_code, 409)
        self.assertEqual(bridge.compute.providers, ["local"])  # nothing switched

    def test_an_older_settings_file_has_the_one_provider_its_mode_named(self):
        compute_mod.COMPUTE_FILE.write_text(json.dumps({"mode": "remote", "remote_url": KAGGLE}), encoding="utf-8")
        self.assertEqual(compute_mod.ComputeSettings.load().providers, ["kaggle"])

    def test_back_to_this_computer(self):
        self.put(mode="remote", speech="remote", remote_url=KAGGLE, remote_key="k")
        res = self.put(mode="local")
        self.assertEqual((res.json()["mode"], res.json()["speech"]), ("local", "local"))

    def test_check_connection_without_switching(self):
        ok = self.client.post("/api/config/compute/check", json={"remote_url": KAGGLE, "remote_key": "k"}).json()
        self.assertEqual(ok["gpu"], "Tesla T4")
        self.kaggle_up = False
        down = self.client.post("/api/config/compute/check", json={"remote_url": KAGGLE, "remote_key": "k"}).json()
        self.assertFalse(down["ok"])
        self.assertEqual(bridge.compute.mode, "local")  # nothing switched

    def test_a_file_saved_before_speech_had_its_own_place(self):
        compute_mod.COMPUTE_FILE.write_text(json.dumps({"mode": "remote", "remote_url": KAGGLE}), encoding="utf-8")
        self.assertEqual(compute_mod.ComputeSettings.load().speech, "remote")
        compute_mod.COMPUTE_FILE.write_text(json.dumps({"mode": "openrouter"}), encoding="utf-8")
        self.assertEqual(compute_mod.ComputeSettings.load().speech, "local")


if __name__ == "__main__":
    unittest.main()
