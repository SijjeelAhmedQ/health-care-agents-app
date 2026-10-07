"""
CareFlow local AI bridge.

A small FastAPI service in front of the two local models:

  WS   /ws/stt     live streaming transcription with Omi Med STT v1
                   client -> binary frames of 16 kHz mono PCM (int16 little-endian)
                             {"type": "config", ...}  tune the stream (see services/streaming.StreamConfig)
                             {"type": "flush"}        finish the current utterance now
                   server -> {"type": "ready"} | speech_start | partial | speech_end | final | error
  POST /api/chat   one Qwen 3.5 4B chat turn with tool calling
                   {"messages": [...], "tools": [...], "options": {...}} -> {"content": str, "tool_calls": [...]}
  GET  /api/llm/models            the models the bridge's LLM runtime has (for the bridge provider)
  GET  /api/config/stt            the selected Omi Med STT settings, every model and backend available here
  PUT  /api/config/stt            select another model / backend / timings (saved to stt_settings.json)
  GET  /api/health runtime status
  GET  /.well-known/agent-card.json   the Master Agent's A2A Agent Card (every agent listed as its skill)
  GET  /agents                        every agent, with the URL of its card
  GET  /agents/{id}/agent-card.json   one agent's card, built from src/agents/<id>-agent/SKILL.md

Run with:

    cd python
    python -m venv .venv && .venv/Scripts/activate      (Windows)  |  source .venv/bin/activate (macOS/Linux)
    pip install -r requirements.txt
    omi-med-stt install-cpp --cpp-backend cpu     (Windows/Linux; downloads parakeet.cpp + the q8_0 GGUF)
    uvicorn app:app --host 127.0.0.1 --port 8765
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any

import httpx
import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from dataclasses import replace

from fastapi import Request, Response

from services import agent_cards
from services.compute import MODE_PROVIDER, OPENROUTER, PROVIDERS, ComputeSettings, openrouter_headers, probe_openrouter, probe_remote
from services.netfix import install as install_netfix
from services.diagnostics import RECORDINGS_DIR, Recorder
from services.qwen import QwenChat
from services.stt_catalog import PRECISIONS, REFINERS, SttSettings, backends, catalog, onnx_backends, validate
from services.streaming import StreamConfig, StreamingSession
from services.vad import create_vad
from services.stt_worker import ProcessSTT

app = FastAPI(title="CareFlow Local AI Bridge", version="2.0.0")
# Any local origin (Vite dev 5173, preview 4173, LAN IP, custom port) may call the bridge.
# Extra explicit origins can be added with CAREFLOW_ALLOWED_ORIGINS (comma separated).
LOCAL_ORIGIN = r"^https?://(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$"
EXTRA_ORIGINS = [o for o in os.getenv("CAREFLOW_ALLOWED_ORIGINS", "").split(",") if o]
app.add_middleware(
    CORSMiddleware,
    allow_origins=EXTRA_ORIGINS,
    allow_origin_regex=LOCAL_ORIGIN,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The Omi model runs in its own process (see services/stt_worker.py for why).
stt_settings = SttSettings.load()
stt_engine = ProcessSTT(stt_settings.as_dict())
# Load (and on first run download) the VAD now, so the first stream does not wait for it.
_vad, vad_warning = create_vad()
llm = QwenChat()
recorder = Recorder()


def start_refiner(model: str) -> ProcessSTT | None:
    """The second recogniser (Whisper + the app's vocabulary), in its own process like Omi."""
    return ProcessSTT({"engine": "whisper", "model": model, "threads": 4}) if model else None


refiner = start_refiner(stt_settings.refine)


def refine_utterance(pcm: np.ndarray, vocabulary: str | None) -> str:
    current = refiner
    if current is None or not current.is_ready():
        return ""
    return current.transcribe_pcm(pcm, vocabulary)


def record_utterance(audio: np.ndarray, text: str, info: dict) -> None:
    if stt_settings.record:
        recorder.save_utterance(audio, text, info)


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "stt": {**stt_engine.info(), "streaming": "/ws/stt", "vad": _vad.name, "vad_warning": vad_warning, "refiner": refiner.info() if refiner else None},
        "llm": {"engine": llm.name, "model": llm.model, "ready": llm.is_ready()},
    }


def _base_url(request: Request) -> str:
    """Where this bridge is reached from — the cards' links point back at the same host and port."""
    return str(request.base_url).rstrip("/")


@app.get("/.well-known/agent-card.json")
@app.get("/.well-known/agent.json", include_in_schema=False)  # the name earlier A2A versions used
def master_agent_card(request: Request) -> dict[str, Any]:
    """The assistant's front door: the Master Agent, with every agent it hands work to listed as one of its skills."""
    master = agent_cards.find("master")
    if master is None:
        raise HTTPException(404, f"No master-agent/SKILL.md under {agent_cards.AGENTS_DIR}.")
    return agent_cards.agent_card(master, _base_url(request))


@app.get("/agents")
def list_agents(request: Request) -> dict[str, Any]:
    return agent_cards.index(_base_url(request))


def _agent(agent_id: str) -> agent_cards.Skill:
    skill = agent_cards.find(agent_id)
    if skill is None:
        known = ", ".join(s.id for s in agent_cards.agents())
        raise HTTPException(404, f'No agent "{agent_id}". Agents: {known}.')
    return skill


@app.get("/agents/{agent_id}/agent-card.json")
@app.get("/agents/{agent_id}")
def agent_card(agent_id: str, request: Request) -> dict[str, Any]:
    return agent_cards.agent_card(_agent(agent_id), _base_url(request))


@app.get("/agents/{agent_id}/agent.json")
def agent_json(agent_id: str) -> dict[str, Any]:
    """The agent's agent.json as generated from the app's code: every tool, and whether it mutates."""
    skill = _agent(agent_id)
    data = agent_cards.agent_json(skill)
    if data is None:
        raise HTTPException(404, f'src/agents/{skill.folder}/agent.json is missing — run "npm run agents:json".')
    return data


@app.websocket("/ws/stt")
async def stream_stt(ws: WebSocket) -> None:
    origin = ws.headers.get("origin", "")
    if origin and not (re.match(LOCAL_ORIGIN, origin) or origin in EXTRA_ORIGINS):
        await ws.close(code=1008)
        return
    await ws.accept()
    if not stt_engine.is_ready():
        await ws.send_json({"type": "error", "fatal": True, "message": f"STT engine '{stt_engine.name}' is not available: {stt_engine.info().get('error')}"})
        await ws.close()
        return

    async def emit(event: dict) -> None:
        try:
            await ws.send_json(event)
        except (WebSocketDisconnect, RuntimeError):
            pass  # client already gone

    session = StreamingSession(
        stt_engine.transcribe_pcm,
        emit,
        StreamConfig(endpoint_ms=stt_settings.endpoint_ms, partial_interval_ms=stt_settings.partial_ms),
        on_final=record_utterance,
        refine=refine_utterance,
    )
    await ws.send_json({"type": "ready", "engine": stt_engine.name, "model": stt_engine.model_id, "record": stt_settings.record, "refine": stt_settings.refine})
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                pcm = np.frombuffer(message["bytes"], dtype="<i2").astype(np.float32) / 32768.0
                await session.feed(pcm)
            elif message.get("text"):
                control = json.loads(message["text"])
                if control.get("type") == "config":
                    if "vocabulary" in control:
                        # The names the app knows right now — the second recogniser's prompt.
                        session.vocabulary = str(control.get("vocabulary") or "")[:2000] or None
                    session.config.update({k: v for k, v in control.items() if k not in ("type", "vocabulary")})
                elif control.get("type") == "flush":
                    await session.flush()
                    await emit({"type": "flushed"})
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] = []
    options: dict[str, Any] = {}


@app.post("/api/chat")
async def chat(req: ChatRequest) -> dict[str, Any]:
    try:
        return await llm.chat(req.messages, req.tools, req.options, req.model)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"LLM runtime '{llm.name}' failed: {exc}") from exc


# ---- configuration ------------------------------------------------------------

#: Settings that need the model reloaded; the others (timings) apply to the next stream.
ENGINE_FIELDS = ("engine", "repo", "gguf_file", "backend", "threads", "precision", "remote_url", "remote_key", "remote_engine")


def stt_config() -> dict[str, Any]:
    return {"settings": stt_settings.as_dict(), "models": catalog(), "backends": backends(), "onnx_backends": onnx_backends(), "precisions": PRECISIONS, "engine": stt_engine.info(), "refiners": REFINERS, "refiner": refiner.info() if refiner else None}


@app.get("/api/config/stt")
async def get_stt_config() -> dict[str, Any]:
    return await run_in_threadpool(stt_config)


class SttSettingsBody(BaseModel):
    engine: str
    repo: str
    gguf_file: str | None = None
    backend: str = "cpu"
    threads: int = 0
    endpoint_ms: int = 900
    partial_ms: int = 500
    precision: str = "int8"
    remote_url: str = ""
    remote_key: str = ""
    remote_engine: str = "whisper"
    record: bool = False
    refine: str = ""


@app.put("/api/config/stt")
async def put_stt_config(body: SttSettingsBody) -> dict[str, Any]:
    return await apply_stt(SttSettings(**body.model_dump()))


async def apply_stt(wanted: SttSettings) -> dict[str, Any]:
    """Validate, load (the running model serves until the new one is ready), save."""
    global stt_settings, refiner
    problem = await run_in_threadpool(validate, wanted)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    # Reload when the model changes — or when the running one failed (e.g. the remote server was down at start).
    if not stt_engine.is_ready() or any(getattr(wanted, f) != getattr(stt_settings, f) for f in ENGINE_FIELDS):
        # Loads (and if needed downloads or builds) the new model; the current one serves until it is ready.
        info = await run_in_threadpool(stt_engine.switch, wanted.as_dict())
        if not info.get("ready"):
            raise HTTPException(status_code=409, detail=f"The model could not be loaded, so the previous one is still in use: {info.get('error')}")
    if wanted.refine != stt_settings.refine:
        old = refiner
        new = await run_in_threadpool(start_refiner, wanted.refine)
        if new is not None and not new.is_ready():
            new.close()
            raise HTTPException(status_code=409, detail=f"The second recogniser could not be loaded: {new.info().get('error')}")
        refiner = new
        if old is not None:
            old.close()
    stt_settings = wanted
    stt_settings.save()
    return await run_in_threadpool(stt_config)


# ---- where the AI runs: this computer, or a remote GPU (Kaggle) for both models --------------

compute = ComputeSettings.load()
# Tunnel hosts resolve to several addresses and from some networks one never answers: connect through
# the one that does (see services/netfix.py).
install_netfix()
REMOTE_TRANSPORT = lambda: httpx.AsyncHTTPTransport(retries=1)  # noqa: E731
LOCAL_OLLAMA = os.getenv("CAREFLOW_LLM_URL", "http://127.0.0.1:11434")
#: A vLLM server of your own (this machine, WSL, your LAN) — /vllm reaches it while the AI runs here.
LOCAL_VLLM = os.getenv("CAREFLOW_VLLM_URL", "http://127.0.0.1:8000")
#: Speech settings that belong to this computer (restored when switching back from the remote GPU).
LOCAL_STT_FIELDS = ("engine", "repo", "gguf_file", "backend", "threads", "precision")


async def compute_status() -> dict[str, Any]:
    # The Kaggle server matters whenever it serves either model (speech, or the language model).
    remote = None
    if compute.uses("kaggle") or compute.speech == "remote":
        try:
            remote = await run_in_threadpool(probe_remote, compute.remote_url, compute.remote_key)
        except RuntimeError as exc:
            remote = {"ok": False, "error": str(exc)}
    openrouter = None
    if compute.uses("openrouter"):
        try:
            openrouter = await run_in_threadpool(probe_openrouter, compute.openrouter_key)
        except RuntimeError as exc:
            openrouter = {"ok": False, "error": str(exc)}
    return {
        "mode": compute.mode,
        "providers": compute.providers,
        "speech": compute.speech,
        "remote_url": compute.remote_url,
        "remote_engine": compute.remote_engine,
        "has_key": bool(compute.remote_key),
        "remote": remote,
        # The OpenRouter key itself never leaves this process.
        "has_openrouter_key": bool(compute.openrouter_key),
        "openrouter_model": compute.openrouter_model,
        "openrouter": openrouter,
        "stt": stt_engine.info(),
    }


@app.get("/api/config/compute")
async def get_compute() -> dict[str, Any]:
    return await compute_status()


class ComputeBody(BaseModel):
    #: Where the language model runs: local (Ollama here), remote (vLLM on the Kaggle GPU) or openrouter.
    mode: str
    #: Where speech recognition runs: local, or remote (the Kaggle GPU). Left out: with the language model.
    speech: str = ""
    remote_url: str = ""
    remote_key: str = ""
    remote_engine: str = "whisper"
    openrouter_key: str = ""
    openrouter_model: str = ""
    #: Which providers are on — any of local, kaggle, openrouter. Left out: the one `mode` names.
    providers: list[str] | None = None


async def restore_local_stt() -> None:
    """Speech recognition back on this computer, as it was before the remote GPU took it over."""
    if stt_settings.engine == "remote":
        back = compute.local_stt or {"engine": "gguf", "repo": "omi-health/omi-med-stt-v1-gguf", "gguf_file": "omi-med-stt-v1-q8_0.gguf", "backend": "cpu"}
        await apply_stt(replace(stt_settings, **back))


async def checked_kaggle(url: str, key: str, need_llm: bool, engine: str | None) -> dict[str, Any]:
    """The Kaggle server, checked before anything moves to it: reachable, the key right, and what is asked of it there."""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Give the Kaggle server's address — careflow_kaggle.ipynb prints it (https://….trycloudflare.com)")
    if not key:
        raise HTTPException(status_code=400, detail="Give the key the Kaggle server was started with (KEY in careflow_kaggle.ipynb)")
    try:
        health = await run_in_threadpool(probe_remote, url, key)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=f"{exc}. Nothing was switched.") from exc
    llm = health.get("llm") or {}
    if need_llm and not llm.get("ok"):
        why = llm.get("error") or ("it runs an old careflow_gpu_server.py (no /vllm) — import health-care-agents-app/python/kaggle/careflow_kaggle.ipynb into Kaggle and Run All" if "ollama" in health else "no language model")
        raise HTTPException(status_code=409, detail=f"The Kaggle server's language model is not ready: {why}. Nothing was switched.")
    engines = health.get("engines") or {}
    if engine and engines and engine not in engines:
        raise HTTPException(status_code=409, detail=f"The Kaggle server has no {engine} speech model (it loaded {', '.join(engines)}). Nothing was switched.")
    return health


class KaggleCheckBody(BaseModel):
    remote_url: str = ""
    remote_key: str = ""


@app.post("/api/config/compute/check")
async def check_kaggle(body: KaggleCheckBody) -> dict[str, Any]:
    """Is the Kaggle server there, and what does it run? — asked from Configuration before switching to it."""
    url = (body.remote_url or compute.remote_url).strip().rstrip("/")
    key = body.remote_key or compute.remote_key  # an empty key field means the saved one
    if not url:
        return {"ok": False, "error": "No Kaggle server address yet"}
    try:
        return await run_in_threadpool(probe_remote, url, key)
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc)}


@app.put("/api/config/compute")
async def put_compute(body: ComputeBody) -> dict[str, Any]:
    """
    Where the two models run. Speech recognition: this computer or the Kaggle GPU. The language model:
    this computer (Ollama), the Kaggle GPU (vLLM there, through /vllm) or OpenRouter (through
    /openrouter). Everything is checked first; nothing moves unless all of it can.
    """
    global compute
    if body.mode not in ("local", "remote", "openrouter"):
        raise HTTPException(status_code=400, detail="mode is local, remote or openrouter")
    providers = list(dict.fromkeys(body.providers if body.providers is not None else [MODE_PROVIDER[body.mode]]))
    if not providers or any(p not in PROVIDERS for p in providers):
        raise HTTPException(status_code=400, detail="providers: one or more of local, kaggle, openrouter")
    if MODE_PROVIDER[body.mode] not in providers:
        raise HTTPException(status_code=400, detail=f"The main model runs on {MODE_PROVIDER[body.mode]}, which is not switched on")
    speech = body.speech or ("remote" if body.mode == "remote" else "local")
    if speech not in ("local", "remote"):
        raise HTTPException(status_code=400, detail="speech is local or remote")

    url = body.remote_url.strip().rstrip("/") or compute.remote_url
    key = body.remote_key or compute.remote_key  # an empty key field keeps the saved one
    if "kaggle" in providers or speech == "remote":
        await checked_kaggle(url, key, need_llm="kaggle" in providers, engine=body.remote_engine if speech == "remote" else None)

    or_key = body.openrouter_key.strip() or compute.openrouter_key
    or_model = body.openrouter_model.strip() or compute.openrouter_model
    if "openrouter" in providers:
        if not or_key:
            raise HTTPException(status_code=400, detail="Give your OpenRouter API key (openrouter.ai/keys)")
        try:
            await run_in_threadpool(probe_openrouter, or_key)
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=f"{exc}. Nothing was switched.") from exc

    # Everything checked: move speech recognition, then remember where both models are.
    local_stt = compute.local_stt if stt_settings.engine == "remote" else {f: getattr(stt_settings, f) for f in LOCAL_STT_FIELDS}
    if speech == "remote":
        await apply_stt(replace(stt_settings, engine="remote", repo="remote", gguf_file=None, remote_url=url, remote_key=key, remote_engine=body.remote_engine))
    else:
        await restore_local_stt()
    compute = replace(
        compute,
        mode=body.mode,
        speech=speech,
        remote_url=url,
        remote_key=key,
        remote_engine=body.remote_engine if speech == "remote" else compute.remote_engine,
        local_stt=local_stt,
        openrouter_key=or_key,
        openrouter_model=or_model,
        providers=providers,
    )
    compute.save()
    return await compute_status()


async def forward_llm(target: str, headers: dict[str, str], request: Request, remote: bool, where: str) -> Response:
    """
    Forward one language-model request. A free tunnel drops a request now and then (its own 502/503 page,
    the request never reached the server): try again — a chat request has no side effects. A 504/524 page
    is different: the server got the request and is still working on it (the tunnel only stopped waiting),
    so sending it again would only queue a second copy behind the first on the GPU. The server's own
    answers (4xx, JSON) are passed on as they are.
    """
    headers["Content-Type"] = request.headers.get("content-type", "application/json")
    body = await request.body()
    attempts = 3 if remote else 1
    for attempt in range(attempts):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(900.0, connect=15.0), transport=REMOTE_TRANSPORT()) as client:
                res = await client.request(request.method, target, content=body, headers=headers)
        except httpx.HTTPError as exc:
            if attempt + 1 < attempts:
                continue
            raise HTTPException(status_code=502, detail=f"The language model at {where} is not reachable: {exc}") from exc
        tunnel_page = not res.headers.get("content-type", "").startswith("application/json")
        tunnel_dropped = res.status_code in (502, 503) and tunnel_page
        if tunnel_page and res.status_code in (504, 524):
            raise HTTPException(status_code=504, detail=f"{where} took longer than the tunnel waits (100 s) and the tunnel gave up — the server is still working on it. Update the Kaggle notebook (careflow_kaggle.ipynb): its server keeps long requests open.")
        if tunnel_dropped and attempt + 1 < attempts:
            await asyncio.sleep(2)
            continue
        if tunnel_dropped:
            raise HTTPException(status_code=502, detail=f"The tunnel to the remote GPU server dropped the request {attempts} times ({res.status_code}). Check that the Kaggle notebook is still running.")
        return Response(content=res.content, status_code=res.status_code, media_type=res.headers.get("content-type"))
    raise HTTPException(status_code=502, detail=f"{where} did not answer")


@app.api_route("/ollama/{path:path}", methods=["GET", "POST", "DELETE"])
async def ollama_proxy(path: str, request: Request) -> Response:
    """
    This computer's Ollama — and only while the AI runs on this computer. Ollama is not used for any other
    place the language model can run: the Kaggle GPU serves it with vLLM (/vllm), OpenRouter is /openrouter.
    """
    if not compute.uses("local"):
        raise HTTPException(status_code=409, detail="This computer is switched off in Configuration → Models: Ollama is used only for This computer.")
    return await forward_llm(f"{LOCAL_OLLAMA}/{path}", {}, request, remote=False, where=LOCAL_OLLAMA)


@app.api_route("/vllm/{path:path}", methods=["GET", "POST"])
async def vllm_proxy(path: str, request: Request) -> Response:
    """
    A vLLM server's OpenAI-compatible API (/vllm/v1/chat/completions, /vllm/v1/models): the Kaggle GPU's,
    with its key added here, while the AI runs there; otherwise your own vLLM server (CAREFLOW_VLLM_URL).
    """
    if compute.uses("kaggle"):
        return await forward_llm(f"{compute.remote_url}/vllm/{path}", compute.remote_headers(), request, remote=True, where="the remote GPU server")
    return await forward_llm(f"{LOCAL_VLLM}/{path}", {}, request, remote=False, where=LOCAL_VLLM)


@app.api_route("/openrouter/{path:path}", methods=["GET", "POST"])
async def openrouter_proxy(path: str, request: Request) -> Response:
    """
    OpenRouter's OpenAI-compatible API (/openrouter/api/v1/chat/completions, /openrouter/api/v1/models),
    with the saved key added here — the app's browser never holds it.
    """
    if not compute.openrouter_key:
        raise HTTPException(status_code=409, detail="No OpenRouter key is saved — add it in Configuration → Where the AI runs → OpenRouter.")
    headers = {**openrouter_headers(compute.openrouter_key), "Content-Type": request.headers.get("content-type", "application/json")}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, connect=15.0)) as client:
            res = await client.request(request.method, f"{OPENROUTER}/{path}", content=await request.body(), headers=headers, params=dict(request.query_params))
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"OpenRouter is not reachable: {exc}") from exc
    return Response(content=res.content, status_code=res.status_code, media_type=res.headers.get("content-type"))


@app.post("/api/diagnostics/trace")
async def diagnostics_trace(trace: dict[str, Any]) -> dict[str, Any]:
    """What the assistant did with a transcript — kept next to the audio while recording is on."""
    if not stt_settings.record:
        return {"recorded": False}
    await run_in_threadpool(recorder.save_trace, trace)
    return {"recorded": True, "folder": str(RECORDINGS_DIR)}


@app.get("/api/llm/models")
async def llm_models() -> dict[str, Any]:
    try:
        return {"runtime": llm.name, "models": await llm.list_models()}
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"LLM runtime '{llm.name}' is not reachable: {exc}") from exc
