"""
The Kaggle GPU server's language models, supervised (kaggle/careflow_gpu_server.py) — against a stand-in Ollama:

  * a model whose load is stuck (not in memory, GPU memory not growing) gets Ollama restarted, and the
    request is answered after the restart — the way qwen3.5:9b stuck on Kaggle until Ollama was restarted;
  * a load that is slow but progressing is left alone;
  * a request still waiting after a while answers at once and keeps the tunnel open with spaces;
  * /vllm/careflow/status says which models are really in memory.

No GPU, no Ollama, no speech models (CAREFLOW_STT is empty).

    cd python && .venv/Scripts/python -m unittest tests.test_gpu_server -v
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import unittest
from pathlib import Path

import httpx

os.environ["CAREFLOW_STT"] = ""
os.environ["CAREFLOW_KEY"] = "test-key"
_spec = importlib.util.spec_from_file_location("careflow_gpu_server", Path(__file__).resolve().parents[1] / "kaggle" / "careflow_gpu_server.py")
server = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)

KEY = {"X-CareFlow-Key": "test-key"}
ANSWER = {"model": "qwen3.5:9b", "message": {"role": "assistant", "content": "ok"}, "done_reason": "stop", "prompt_eval_count": 3, "eval_count": 1}


class FakeOllama:
    """Ollama as the Kaggle notebook saw it: 9b stuck loading until a restart (or loading slowly)."""

    def __init__(self, stuck_until_restart=True, load_seconds=0.0, think_seconds=0.0):
        self.stuck = stuck_until_restart
        self.load_seconds = load_seconds
        self.think_seconds = think_seconds
        self.loaded: list[str] = ["qwen3.5:4b"]
        self.restarts = 0
        self.chats = 0
        self.gpu = 4339
        #: Ternary Bonsai's llama-server (port 8081): "off" (not started), "loading" (503) or "ready".
        self.bonsai = "off"
        self.bonsai_requests: list[dict] = []

    async def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.url.port == 8081:
            if self.bonsai == "off":
                raise httpx.ConnectError("connection refused")
            if path == "/health":
                return httpx.Response(200 if self.bonsai == "ready" else 503, json={"status": "ok" if self.bonsai == "ready" else "loading model"})
            if path == "/v1/chat/completions":
                self.bonsai_requests.append(json.loads(request.content))
                return httpx.Response(200, json={"id": "c1", "object": "chat.completion", "model": "ternary-bonsai-2-27b", "choices": [{"index": 0, "message": {"role": "assistant", "content": "A concise summary."}, "finish_reason": "stop"}]})
            return httpx.Response(404, json={"error": "not found"})
        if path == "/api/version":
            return httpx.Response(200, json={"version": "test"})
        if path == "/api/ps":
            return httpx.Response(200, json={"models": [{"name": m} for m in self.loaded]})
        if path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "qwen3.5:4b"}, {"name": "qwen3.5:9b"}]})
        if path == "/api/chat":
            self.chats += 1
            model = json.loads(request.content)["model"]
            if model not in self.loaded:
                if self.stuck:
                    await asyncio.sleep(3600)  # never loads, never answers
                await asyncio.sleep(self.load_seconds)
                self.loaded.append(model)
            await asyncio.sleep(self.think_seconds)
            return httpx.Response(200, json={**ANSWER, "model": model})
        return httpx.Response(404, json={"error": "not found"})

    def restart(self):
        self.restarts += 1
        self.stuck = False
        self.loaded = []


class SupervisedOllamaTest(unittest.IsolatedAsyncioTestCase):
    def use(self, fake: FakeOllama, *, stall=0.3, gpu_growing=False):
        server.CLIENT = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
        server.LOAD_STALL_S = stall
        server.WATCH_EVERY_S = 0.05
        server.OLLAMA_STATE.update(restarts=0, last=None, generation=0)
        server.LOADING.clear()
        server._start_ollama = fake.restart

        async def gpu():
            if gpu_growing:
                fake.gpu += 500
            return fake.gpu

        server.gpu_used_mib = gpu
        return fake

    async def asyncTearDown(self):
        await server.CLIENT.aclose()

    async def test_a_stuck_load_restarts_ollama_and_the_request_is_answered(self):
        fake = self.use(FakeOllama(stuck_until_restart=True))
        status, data = await asyncio.wait_for(server.ollama_chat({"model": "qwen3.5:9b", "messages": []}), 10)
        self.assertEqual(status, 200)
        self.assertEqual(data["message"]["content"], "ok")
        self.assertEqual(fake.restarts, 1)
        self.assertEqual(fake.chats, 2)  # the request was sent again after the restart
        self.assertEqual(server.OLLAMA_STATE["restarts"], 1)
        self.assertIn("qwen3.5:9b made no loading progress", server.OLLAMA_STATE["last"]["reason"])

    async def test_requests_stuck_together_restart_ollama_once(self):
        fake = self.use(FakeOllama(stuck_until_restart=True))
        results = await asyncio.wait_for(asyncio.gather(*(server.ollama_chat({"model": "qwen3.5:9b", "messages": []}) for _ in range(3))), 10)
        self.assertTrue(all(status == 200 for status, _ in results))
        self.assertEqual(fake.restarts, 1)

    async def test_a_slow_load_that_progresses_is_left_alone(self):
        fake = self.use(FakeOllama(stuck_until_restart=False, load_seconds=0.6), stall=0.3, gpu_growing=True)
        status, _ = await asyncio.wait_for(server.ollama_chat({"model": "qwen3.5:9b", "messages": []}), 10)
        self.assertEqual(status, 200)
        self.assertEqual(fake.restarts, 0)

    async def test_a_loaded_model_is_never_watched(self):
        fake = self.use(FakeOllama(stuck_until_restart=True, think_seconds=0.5), stall=0.1)
        status, _ = await asyncio.wait_for(server.ollama_chat({"model": "qwen3.5:4b", "messages": []}), 10)
        self.assertEqual(status, 200)
        self.assertEqual(fake.restarts, 0)  # thinking for longer than the stall limit is not a stuck load

    async def test_still_stuck_after_a_restart_is_said_plainly(self):
        fake = FakeOllama(stuck_until_restart=True)
        fake.restart = lambda: setattr(fake, "restarts", fake.restarts + 1)  # the restart does not help
        self.use(fake)
        server._start_ollama = fake.restart
        status, data = await asyncio.wait_for(server.ollama_chat({"model": "qwen3.5:9b", "messages": []}), 10)
        self.assertEqual(status, 503)
        self.assertIn("would not load", data["error"])
        self.assertEqual(fake.restarts, 1)


class EndpointsTest(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient

        self.fake = FakeOllama(stuck_until_restart=False, think_seconds=0.4)
        server.CLIENT = httpx.AsyncClient(transport=httpx.MockTransport(self.fake.handler))
        server.OLLAMA_STATE.update(restarts=0, last=None, generation=0)

        async def gpu():
            return 4339

        server.gpu_used_mib = gpu
        self.client = TestClient(server.app)

    def test_a_long_request_answers_at_once_and_keeps_the_tunnel_open(self):
        server.HEARTBEAT_AFTER_S, server.HEARTBEAT_EVERY_S = 0.05, 0.05
        try:
            res = self.client.post("/vllm/v1/chat/completions", headers=KEY, json={"model": "qwen3.5:4b", "messages": [{"role": "user", "content": "hi"}]})
        finally:
            server.HEARTBEAT_AFTER_S, server.HEARTBEAT_EVERY_S = 20.0, 15.0
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res.text.startswith(" "), "spaces first, while the model works")
        body = json.loads(res.text)  # leading spaces are valid JSON
        self.assertEqual(body["choices"][0]["message"]["content"], "ok")

    def test_a_quick_request_is_an_ordinary_answer(self):
        self.fake.think_seconds = 0
        res = self.client.post("/vllm/v1/chat/completions", headers=KEY, json={"model": "qwen3.5:4b", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.text.startswith(" "))
        self.assertEqual(res.json()["choices"][0]["message"]["content"], "ok")

    def test_status_says_which_models_are_in_memory(self):
        res = self.client.get("/vllm/careflow/status", headers=KEY)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["loaded"], ["qwen3.5:4b"])
        self.assertEqual(res.json()["models"], ["qwen3.5:4b", "qwen3.5:9b"])
        self.assertEqual(self.client.get("/vllm/careflow/status").status_code, 401)

    def test_ternary_bonsai_is_answered_by_its_own_llama_server_with_thinking_off(self):
        self.fake.bonsai = "ready"
        self.fake.think_seconds = 0
        res = self.client.post("/vllm/v1/chat/completions", headers=KEY, json={"model": "ternary-bonsai-2-27b", "messages": [{"role": "user", "content": "Summarize."}], "max_tokens": 700})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["choices"][0]["message"]["content"], "A concise summary.")
        sent = self.fake.bonsai_requests[-1]
        self.assertEqual(sent["chat_template_kwargs"], {"enable_thinking": False})
        self.assertEqual(sent["max_tokens"], 700)
        self.assertEqual(self.fake.chats, 0)  # Ollama was never asked
        # The other models still go to Ollama.
        self.client.post("/vllm/v1/chat/completions", headers=KEY, json={"model": "qwen3.5:4b", "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(self.fake.chats, 1)

    def test_ternary_bonsai_is_listed_only_while_its_server_is_ready(self):
        self.assertNotIn("ternary-bonsai-2-27b", self.client.get("/vllm/careflow/status", headers=KEY).json()["models"])
        self.fake.bonsai = "loading"
        status = self.client.get("/vllm/careflow/status", headers=KEY).json()
        self.assertEqual(status["bonsai"], "loading")
        self.assertNotIn("ternary-bonsai-2-27b", status["models"])
        self.fake.bonsai = "ready"
        status = self.client.get("/vllm/careflow/status", headers=KEY).json()
        self.assertIn("ternary-bonsai-2-27b", status["models"])
        self.assertIn("ternary-bonsai-2-27b", status["loaded"])
        health = self.client.get("/health", headers=KEY).json()["llm"]
        self.assertIn("ternary-bonsai-2-27b", health["models"])

    def test_ternary_bonsai_not_running_is_said_plainly(self):
        self.fake.think_seconds = 0
        res = self.client.post("/vllm/v1/chat/completions", headers=KEY, json={"model": "ternary-bonsai-2-27b", "messages": [{"role": "user", "content": "Summarize."}]})
        self.assertEqual(res.status_code, 503)
        self.assertIn("ternary-bonsai-2-27b: not reachable", res.json()["error"]["message"])

    def test_keep_alive_is_sent_as_ollama_reads_it(self):
        server.KEEP_ALIVE = "-1"
        self.assertEqual(server.to_ollama({"model": "m", "messages": []})["keep_alive"], -1)
        server.KEEP_ALIVE = "60m"
        self.assertEqual(server.to_ollama({"model": "m", "messages": []})["keep_alive"], "60m")


if __name__ == "__main__":
    unittest.main()
