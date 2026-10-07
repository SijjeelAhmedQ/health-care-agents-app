"""
CareFlow's AI on a remote GPU — e.g. a Kaggle notebook's T4 (16 GB): both models in one place.

Configuration → "Where the AI runs" → Kaggle GPU switches the whole assistant here:

  * speech recognition — Whisper large-v3-turbo on the GPU (default: best with non-US accents, takes the
    app's names as a prompt) and Omi Med STT v1; CAREFLOW_STT lists what to load (whisper,omi,parakeet). The bridge on the provider's
    computer keeps the microphone stream, voice detection and live text; it sends each piece of speech here.
        POST /transcribe?engine=whisper&prompt=...   body: 16 kHz mono 16-bit PCM  →  {"text": "...", "ms": 123}
  * the language models — Ollama with qwen3.5:9b, MedGemma 4B and Qwen3Guard 4B on the GPU, and Ternary Bonsai 2
    27B (PQ2_0) on llama-server of PrismML's llama.cpp fork (stock llama.cpp and Ollama cannot run its ternary
    weights) — a request for BONSAI_MODEL goes there, everything else to Ollama — reached through
        /vllm/<OpenAI API path>   e.g. POST /vllm/v1/chat/completions, GET /vllm/v1/models — the address the
        /llm/<OpenAI API path>    app calls; a chat request is answered by Ollama's own /api/chat, so
                                  `think: false` (Qwen's long hidden thinking off) and the context size apply
        /ollama/<Ollama API path> Ollama's own API, unchanged (e.g. POST /ollama/api/chat)
        /vllm/careflow/status     which models are in GPU memory now, which are loading, Ollama restarts
  * GET /health  →  the speech models, the GPU, and the models Ollama has (and has loaded)

Two things keep the language models answering on a free Kaggle GPU behind a free tunnel:
  * A model whose load makes no progress (not in Ollama's memory, GPU memory not growing) for
    CAREFLOW_LOAD_STALL_S seconds is a stuck Ollama: it is restarted here, and the request sent again once.
  * The agents of the app's multi-agent mode work at the same time: Ollama answers OLLAMA_NUM_PARALLEL requests
    to one model together (the notebook sets it), and every request here is handled concurrently.
  * A Cloudflare quick tunnel cuts any request that has no answer after 100 s. A request still waiting after
    20 s answers at once and keeps the line open with spaces (JSON allows them) until the model's answer.

Every request must carry the header `X-CareFlow-Key: <CAREFLOW_KEY>` — a tunnel URL is public.

Kaggle notebook (Settings → Accelerator: GPU T4, Internet: on), one cell each:

    !apt-get install -y -qq zstd; curl -fsSL https://ollama.com/install.sh | sh
    !OLLAMA_CONTEXT_LENGTH=16384 nohup ollama serve > ollama.log 2>&1 &
    !sleep 5; ollama pull qwen3.5:9b
    !pip install -q omi-med-stt faster-whisper fastapi uvicorn httpx
    # Omi Med STT on the GPU: builds parakeet.cpp for CUDA (Kaggle has CMake and the CUDA Toolkit; a few minutes)
    !omi-med-stt install-cpp --cpp-backend cuda
    # upload this file to /kaggle/working/careflow_gpu_server.py, then:
    !CAREFLOW_KEY=choose-a-long-secret nohup python /kaggle/working/careflow_gpu_server.py > server.log 2>&1 &
    !sleep 60; tail -5 server.log          # "... ready on cuda" when the speech model is loaded

careflow_kaggle.ipynb does all of this and opens a Cloudflare tunnel. Put the printed address and the same
key in CareFlow's Configuration → Where the AI runs → Kaggle GPU.
(For Parakeet v2 instead: pip install "onnx-asr[hub]" onnxruntime-gpu, and start with CAREFLOW_STT=parakeet.)
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import threading
import time

import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

#: The speech models to load, the first is the default: whisper (best with non-US accents) | omi | parakeet.
STT = [e.strip() for e in os.getenv("CAREFLOW_STT", "whisper,omi").lower().split(",") if e.strip()]
KEY = os.getenv("CAREFLOW_KEY", "")
OLLAMA = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")
#: Ternary Bonsai 2 27B: PrismML's llama-server (OpenAI API), started by the notebook on the second T4.
BONSAI_URL = os.getenv("BONSAI_URL", "http://127.0.0.1:8081")
BONSAI_MODEL = os.getenv("BONSAI_MODEL", "ternary-bonsai-2-27b")
#: Tokens per request: the assistant's instructions and tools take ~8k (Ollama's default is far less).
NUM_CTX = int(os.getenv("CAREFLOW_NUM_CTX", "16384"))
#: How long Ollama keeps a model in GPU memory after a request ("-1": for good — the notebook's choice on T4 x2).
KEEP_ALIVE = os.getenv("CAREFLOW_KEEP_ALIVE", "60m")
#: A model load with no progress for this long is stuck, and Ollama is restarted.
LOAD_STALL_S = float(os.getenv("CAREFLOW_LOAD_STALL_S", "120"))
#: How often a load is checked on, and how much more GPU memory counts as progress.
WATCH_EVERY_S = float(os.getenv("CAREFLOW_WATCH_EVERY_S", "5"))
PROGRESS_MIB = 128
#: A request with no answer after HEARTBEAT_AFTER_S answers at once and sends a space every HEARTBEAT_EVERY_S.
HEARTBEAT_AFTER_S = float(os.getenv("CAREFLOW_HEARTBEAT_AFTER_S", "20"))
HEARTBEAT_EVERY_S = float(os.getenv("CAREFLOW_HEARTBEAT_EVERY_S", "15"))
#: Where a restarted Ollama writes its log (the notebook's own ollama.log).
OLLAMA_LOG = os.getenv("CAREFLOW_OLLAMA_LOG", "/kaggle/working/ollama.log")
#: Whisper's mean log-probability below which a transcript is not trusted (see /transcribe).
UNCLEAR_BELOW = float(os.getenv("CAREFLOW_UNCLEAR_BELOW", "-0.65"))
SAMPLE_RATE = 16000


def load_omi():
    """Omi Med STT v1 (GGUF q8_0) through parakeet.cpp — the CUDA build on a GPU, else the prebuilt CPU one."""
    from omi_stt import cpp_runtime as rt  # type: ignore

    model_path = rt._download_or_resolve_gguf(rt.DEFAULT_GGUF_REPO, rt.DEFAULT_GGUF_FILE, rt.DEFAULT_GGUF_REVISION, True)
    for backend in [os.getenv("CAREFLOW_STT_BACKEND", "cuda"), "cpu"]:
        try:
            lib = rt._find_parakeet_lib(auto_install=True, backend=backend)
            capi = rt._ParakeetCAPI(lib, model_path, "tdt", backend, rt._default_cpp_threads(backend))
        except Exception as exc:  # noqa: BLE001 — no CUDA build: fall back to the CPU one, and say so
            print(f"Omi Med STT on {backend} failed: {exc}", flush=True)
            continue

        def recognize(pcm: np.ndarray, prompt: str | None = None) -> tuple[str, float | None]:
            try:
                return rt._render_unknown_tokens(capi.transcribe_pcm(np.ascontiguousarray(pcm, dtype=np.float32))).strip(), None
            except RuntimeError as exc:
                if "empty transcript" in str(exc).lower():  # silence or noise
                    return "", None
                raise

        return "omi-med-stt-v1 (gguf q8_0)", backend, recognize
    raise RuntimeError("Omi Med STT could not be loaded on the GPU or the CPU")


def load_parakeet():
    """NVIDIA Parakeet-TDT 0.6B v2 through onnx-asr (fp32 by default; CAREFLOW_MODEL_PATH / CAREFLOW_QUANT optional)."""
    import onnxruntime as ort

    try:  # CUDA/cuDNN from pip, when the image has no system-wide ones
        ort.preload_dlls()
    except Exception:  # noqa: BLE001
        pass
    import onnx_asr

    name = os.getenv("CAREFLOW_MODEL", "nemo-parakeet-tdt-0.6b-v2")
    device = "cuda" if "CUDAExecutionProvider" in ort.get_available_providers() else "cpu"
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if device == "cuda" else ["CPUExecutionProvider"]
    model = onnx_asr.load_model(name, os.getenv("CAREFLOW_MODEL_PATH") or None, quantization=os.getenv("CAREFLOW_QUANT") or None, providers=providers)
    return name, device, lambda pcm, prompt=None: (str(model.recognize(pcm, sample_rate=SAMPLE_RATE)).strip(), None)


def load_whisper():
    """
    Whisper large-v3-turbo (faster-whisper), fp16 on the GPU. Trained on speech from all over the world,
    it hears non-US accents far better than Omi / Parakeet; the app's names (patients, drugs, diagnoses)
    come with every request as its prompt.
    """
    from faster_whisper import WhisperModel

    size = os.getenv("CAREFLOW_WHISPER", "large-v3-turbo")
    try:
        model, device = WhisperModel(size, device="cuda", compute_type="float16"), "cuda"
        list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language="en")[0])  # the CUDA libraries load only here
    except Exception as exc:  # noqa: BLE001
        print(f"Whisper on cuda failed: {exc}", flush=True)
        model, device = WhisperModel(size, device="cpu", compute_type="int8"), "cpu"

    def recognize(pcm: np.ndarray, prompt: str | None = None) -> tuple[str, float | None]:
        """The text and how sure Whisper is of it (mean log-probability per token, 0 = certain)."""
        segments = list(model.transcribe(pcm, language="en", beam_size=5, initial_prompt=prompt or None, condition_on_previous_text=False, vad_filter=False, without_timestamps=True)[0])
        text = " ".join(s.text.strip() for s in segments).strip()
        # On near-silence Whisper can read its prompt back ("Patients: ..."): that is not speech.
        if not segments or (prompt and len(text) > 20 and text.rstrip(".") in prompt):
            return "", None
        confidence = min(s.avg_logprob for s in segments)
        # Words repeated over and over ("Thank you. Thank you. Thank you.") are Whisper filling noise.
        if max(s.compression_ratio for s in segments) > 2.0:
            confidence = min(confidence, UNCLEAR_BELOW - 1)
        return text, confidence

    return f"whisper-{size}", device, recognize


LOADERS = {"whisper": load_whisper, "omi": load_omi, "parakeet": load_parakeet}
ENGINES: dict[str, tuple[str, str, object]] = {}
for engine in STT:
    try:
        name, device, fn = LOADERS[engine]()
        fn(np.zeros(SAMPLE_RATE, dtype=np.float32))  # first run builds the GPU kernels now, not mid-sentence
        ENGINES[engine] = (name, device, fn)
        print(f"{name} ready on {device}", flush=True)
    except Exception as exc:  # noqa: BLE001 — the other engines still serve
        print(f"{engine} could not be loaded: {exc}", flush=True)
# CAREFLOW_STT="" serves only the language models (and lets the tests import this file).
if STT and not ENGINES:
    raise SystemExit("No speech model could be loaded")
DEFAULT = next(iter(ENGINES), "")
MODEL, DEVICE = (ENGINES[DEFAULT][0], ENGINES[DEFAULT][1]) if ENGINES else ("none", "cuda")

app = FastAPI(title="CareFlow GPU speech recognition and language models")
#: One connection pool for every request to Ollama (a new client per request costs a handshake each time).
CLIENT = httpx.AsyncClient(timeout=httpx.Timeout(900.0, connect=10.0))


def check_key(key: str) -> None:
    if not KEY:
        raise HTTPException(status_code=503, detail="Set CAREFLOW_KEY on the server: without it anyone with the tunnel URL could use it")
    if key != KEY:
        raise HTTPException(status_code=401, detail="Wrong or missing X-CareFlow-Key")


@app.get("/health")
async def health(x_careflow_key: str = Header(default="")) -> dict:
    check_key(x_careflow_key)
    gpu = None
    if DEVICE == "cuda":
        try:
            gpu = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"], capture_output=True, text=True, timeout=10).stdout.strip()
        except Exception:  # noqa: BLE001
            pass
    try:
        tags = (await CLIENT.get(f"{OLLAMA}/api/tags", timeout=5)).json()
        models = [m.get("name") for m in tags.get("models", [])]
        llm = {"ok": bool(models), "engine": "ollama", "models": models, "loaded": await loaded_models(), "loading": loading_now(), "restarts": OLLAMA_STATE["restarts"]}
        if not models:
            llm["error"] = "Ollama has no models yet — the notebook is still pulling its models (qwen3.5:9b first)"
    except Exception as exc:  # noqa: BLE001
        llm = {"ok": False, "engine": "ollama", "models": [], "error": f"Ollama is not running on this server ({type(exc).__name__})"}
    llm["bonsai"] = await bonsai_state()
    if llm["bonsai"] == "ready":
        llm["models"] = [*llm["models"], BONSAI_MODEL]
        llm["loaded"] = [*llm.get("loaded", []), BONSAI_MODEL]
    engines = {e: {"model": m, "device": d} for e, (m, d, _) in ENGINES.items()}
    return {"ok": True, "model": MODEL, "device": DEVICE, "default": DEFAULT, "engines": engines, "gpu": gpu, "llm": llm}


def _arguments(value) -> dict:
    """OpenAI sends a tool call's arguments as a JSON string, Ollama wants the object."""
    if isinstance(value, str):
        try:
            value = json.loads(value or "{}")
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def _text(content) -> str:
    """OpenAI content: a string, or a list of parts — Ollama wants the text."""
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return content or ""


def to_ollama(req: dict) -> dict:
    """An OpenAI chat request → Ollama's /api/chat, with thinking off unless the request turns it on."""
    messages, call_names = [], {}
    for m in req.get("messages", []):
        msg = {"role": m.get("role", "user"), "content": _text(m.get("content"))}
        if m.get("tool_calls"):
            msg["tool_calls"] = []
            for c in m["tool_calls"]:
                fn = c.get("function") or {}
                call_names[c.get("id")] = fn.get("name")
                msg["tool_calls"].append({"function": {"name": fn.get("name"), "arguments": _arguments(fn.get("arguments"))}})
        if m.get("role") == "tool" and call_names.get(m.get("tool_call_id")):
            msg["tool_name"] = call_names[m["tool_call_id"]]
        messages.append(msg)
    options = {"num_ctx": NUM_CTX}
    for openai_name, ollama_name in (("temperature", "temperature"), ("top_p", "top_p"), ("max_tokens", "num_predict"), ("seed", "seed"), ("stop", "stop")):
        if req.get(openai_name) is not None:
            options[ollama_name] = req[openai_name]
    think = bool((req.get("chat_template_kwargs") or {}).get("enable_thinking", False))
    body = {"model": req.get("model"), "messages": messages, "stream": False, "think": think, "options": options, "keep_alive": keep_alive()}
    if req.get("tools"):
        body["tools"] = req["tools"]
    return body


def to_openai(res: dict, model: str | None) -> dict:
    """Ollama's /api/chat answer → an OpenAI chat completion."""
    msg = res.get("message") or {}
    calls = [
        {"id": f"call_{i}", "type": "function", "function": {"name": (c.get("function") or {}).get("name"), "arguments": json.dumps((c.get("function") or {}).get("arguments") or {})}}
        for i, c in enumerate(msg.get("tool_calls") or [])
    ]
    finish = "tool_calls" if calls else ("length" if res.get("done_reason") == "length" else "stop")
    message = {"role": "assistant", "content": msg.get("content") or ("" if not calls else None)}
    if calls:
        message["tool_calls"] = calls
    prompt, output = res.get("prompt_eval_count") or 0, res.get("eval_count") or 0
    return {
        "id": f"chatcmpl-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": res.get("model") or model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {"prompt_tokens": prompt, "completion_tokens": output, "total_tokens": prompt + output},
    }


# ---------------------------------------------------------------------------------------- Ollama, supervised

#: Ollama's restarts: how many, the latest (when and why), and a generation number requests compare against.
OLLAMA_STATE: dict = {"restarts": 0, "last": None, "generation": 0}
_RESTART_LOCK = asyncio.Lock()
#: Models being loaded now, and since when.
LOADING: dict[str, float] = {}


def keep_alive():
    """Ollama takes a whole number of seconds as a number ("-1" = for good), anything else as a duration."""
    try:
        return int(KEEP_ALIVE)
    except ValueError:
        return KEEP_ALIVE


def loading_now() -> dict[str, int]:
    return {m: round(time.time() - t) for m, t in LOADING.items()}


async def loaded_models() -> list[str]:
    """The models in Ollama's memory right now ([] when Ollama does not answer)."""
    try:
        return [m.get("name") for m in (await CLIENT.get(f"{OLLAMA}/api/ps", timeout=5)).json().get("models", [])]
    except Exception:  # noqa: BLE001
        return []


def _gpu_used_mib() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
        return sum(int(x) for x in out.split())
    except Exception:  # noqa: BLE001
        return None


async def gpu_used_mib() -> int | None:
    """GPU memory in use on all GPUs together (MiB), or None without nvidia-smi."""
    return await asyncio.to_thread(_gpu_used_mib)


async def watch_load(model: str, task: asyncio.Task, generation: int) -> str:
    """
    Watch a request whose model is not in memory yet, until it is "answered", the model is "loaded", Ollama
    was "restarted" under it (by another request: this one went to the Ollama that was stopped), or the load
    is "stuck" — not loaded, and GPU memory not growing for LOAD_STALL_S seconds.
    """
    LOADING.setdefault(model, time.time())
    try:
        last = await gpu_used_mib()
        progress = time.monotonic()
        while not task.done():
            await asyncio.wait({task}, timeout=WATCH_EVERY_S)
            if task.done():
                return "answered"
            if OLLAMA_STATE["generation"] != generation:
                return "restarted"
            if model in await loaded_models():
                return "loaded"
            used = await gpu_used_mib()
            if used is not None and (last is None or used >= last + PROGRESS_MIB):
                last, progress = used, time.monotonic()
            if time.monotonic() - progress >= LOAD_STALL_S:
                return "stuck"
        return "answered"
    finally:
        LOADING.pop(model, None)


def _start_ollama() -> None:
    """Stop every Ollama process (the server and its model runners) and start the server again, as the notebook does."""
    subprocess.run(["pkill", "-x", "ollama"], check=False)
    time.sleep(3)
    subprocess.Popen(["ollama", "serve"], stdout=open(OLLAMA_LOG, "a"), stderr=subprocess.STDOUT, env=os.environ, start_new_session=True)


async def restart_ollama(reason: str, generation: int) -> None:
    """Restart Ollama — once, however many requests found it stuck at the same time."""
    async with _RESTART_LOCK:
        if OLLAMA_STATE["generation"] != generation:
            return  # another request restarted it already
        print(f"Restarting Ollama: {reason}", flush=True)
        await asyncio.to_thread(_start_ollama)
        for _ in range(60):
            try:
                if (await CLIENT.get(f"{OLLAMA}/api/version", timeout=3)).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(1)
        OLLAMA_STATE["generation"] += 1
        OLLAMA_STATE["restarts"] += 1
        OLLAMA_STATE["last"] = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "reason": reason}


async def ollama_chat(body: dict) -> tuple[int, dict]:
    """
    One chat request to Ollama, supervised: a model that will not load gets Ollama restarted and the request
    sent once more. Returns Ollama's status code and answer (or {"error": ...}).
    """
    model = body.get("model") or ""
    for attempt in range(2):
        generation = OLLAMA_STATE["generation"]
        resident = model in await loaded_models()
        task = asyncio.create_task(CLIENT.post(f"{OLLAMA}/api/chat", json=body))
        try:
            watched = "answered" if resident else await watch_load(model, task, generation)
            if watched == "restarted" and attempt == 0:
                continue  # sent to the Ollama that was stopped: send it again to the new one
            if watched == "stuck":
                if attempt == 0:
                    await restart_ollama(f"{model} made no loading progress for {int(LOAD_STALL_S)} s", generation)
                    continue
                return 503, {"error": f"{model} would not load on this server, even after restarting Ollama. Check the GPU memory (nvidia-smi) and ollama.log in the notebook."}
            res = await task
        except httpx.HTTPError as exc:
            if attempt == 0 and OLLAMA_STATE["generation"] != generation:
                continue  # Ollama was restarted under this request: send it again
            return 503, {"error": f"Ollama is not reachable on this server ({type(exc).__name__})"}
        finally:
            if not task.done():
                task.cancel()
        try:
            return res.status_code, res.json()
        except ValueError:
            return res.status_code, {"error": res.text}
    return 503, {"error": f"{model} could not be loaded on this server"}


def render(status: int, data: dict, model: str | None) -> tuple[int, bytes]:
    """The answer as the OpenAI chat completion the app reads (Ollama's converted, Bonsai's as it is), or an OpenAI-shaped error."""
    if status != 200 or "error" in data:
        engine = BONSAI_MODEL if model == BONSAI_MODEL else "Ollama"
        return (status if status != 200 else 500), json.dumps({"error": {"message": f"{engine}: {data.get('error')}", "code": status}}).encode()
    if "choices" in data:
        return 200, json.dumps(data).encode()
    return 200, json.dumps(to_openai(data, model)).encode()


async def bonsai_state() -> str:
    """Bonsai's llama-server: "ready", "loading" (it answers 503 while the weights load) or "off"."""
    try:
        res = await CLIENT.get(f"{BONSAI_URL}/health", timeout=3)
    except Exception:  # noqa: BLE001
        return "off"
    return "ready" if res.status_code == 200 else "loading" if res.status_code == 503 else "off"


async def bonsai_chat(req: dict) -> tuple[int, dict]:
    """A chat request for Ternary Bonsai: to its llama-server as it is (it speaks OpenAI) — thinking off unless asked."""
    body = {**req, "stream": False}
    body.setdefault("chat_template_kwargs", {"enable_thinking": False})
    try:
        res = await CLIENT.post(f"{BONSAI_URL}/v1/chat/completions", json=body, timeout=None)
    except httpx.HTTPError as exc:
        return 503, {"error": f"not reachable on this server ({type(exc).__name__}) — the notebook starts it on the second T4"}
    try:
        data = res.json()
    except ValueError:
        return (res.status_code if res.status_code != 200 else 502), {"error": res.text[:300] or "an empty answer"}
    if res.status_code != 200:
        err = data.get("error")
        return res.status_code, {"error": (err.get("message") if isinstance(err, dict) else err) or res.text[:300]}
    return 200, data


async def keep_open(work: asyncio.Task, model: str | None):
    """A space every HEARTBEAT_EVERY_S while the answer is not in (so the tunnel never cuts it), then the answer."""
    try:
        while True:
            done, _ = await asyncio.wait({work}, timeout=HEARTBEAT_EVERY_S)
            if done:
                break
            yield b" "
        # The status line is already sent: an error goes in the body, as OpenRouter does it.
        yield render(*work.result(), model)[1]
    finally:
        if not work.done():
            work.cancel()  # the app gave up on it: Ollama stops working on it too


async def passthrough(url: str, request: Request, body: bytes) -> Response:
    """Forward as it is, streamed through as it arrives."""
    headers = {"Content-Type": request.headers.get("content-type", "application/json")}
    upstream = CLIENT.build_request(request.method, url, content=body, headers=headers, params=request.query_params)
    try:
        res = await CLIENT.send(upstream, stream=True)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"Ollama is not reachable on this server ({type(exc).__name__})") from exc
    return StreamingResponse(res.aiter_raw(), status_code=res.status_code, media_type=res.headers.get("content-type"), background=BackgroundTask(res.aclose))


@app.get("/llm/careflow/status")
@app.get("/vllm/careflow/status")
async def llm_status(x_careflow_key: str = Header(default="")) -> dict:
    """Which models are in GPU memory now, which are being loaded (and for how long), and Ollama's restarts."""
    check_key(x_careflow_key)
    try:
        tags = (await CLIENT.get(f"{OLLAMA}/api/tags", timeout=5)).json()
        models = [m.get("name") for m in tags.get("models", [])]
    except Exception:  # noqa: BLE001
        models = []
    loaded = await loaded_models()
    bonsai = await bonsai_state()
    if bonsai == "ready":
        models, loaded = [*models, BONSAI_MODEL], [*loaded, BONSAI_MODEL]
    return {"engine": "ollama", "models": models, "loaded": loaded, "loading": loading_now(), "restarts": OLLAMA_STATE["restarts"], "last_restart": OLLAMA_STATE["last"], "bonsai": bonsai}


@app.api_route("/llm/{path:path}", methods=["GET", "POST"])
@app.api_route("/vllm/{path:path}", methods=["GET", "POST"])  # the address the app calls (its "vllm" provider)
async def openai_proxy(path: str, request: Request, x_careflow_key: str = Header(default="")) -> Response:
    """The language models in OpenAI's shape (/v1/chat/completions, /v1/models), served by Ollama."""
    check_key(x_careflow_key)
    body = await request.body()
    if request.method == "POST" and path.strip("/") == "v1/chat/completions":
        try:
            req = json.loads(body or b"{}")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="The body is not JSON") from exc
        if not req.get("stream"):
            work = asyncio.create_task(bonsai_chat(req) if req.get("model") == BONSAI_MODEL else ollama_chat(to_ollama(req)))
            done, _ = await asyncio.wait({work}, timeout=HEARTBEAT_AFTER_S)
            if done:
                status, content = render(*work.result(), req.get("model"))
                return Response(content=content, status_code=status, media_type="application/json")
            # Still loading or thinking: answer now, and keep the tunnel open until the model's answer is in.
            return StreamingResponse(keep_open(work, req.get("model")), media_type="application/json")
        if req.get("model") == BONSAI_MODEL:
            return await passthrough(f"{BONSAI_URL}/{path}", request, body)
    # Streaming chat and everything else: Ollama's own OpenAI-compatible API.
    return await passthrough(f"{OLLAMA}/{path}", request, body)


@app.api_route("/ollama/{path:path}", methods=["GET", "POST", "DELETE"])
async def ollama_proxy(path: str, request: Request, x_careflow_key: str = Header(default="")) -> Response:
    """Ollama's own API, unchanged (chat, tags, ps, generate…)."""
    check_key(x_careflow_key)
    return await passthrough(f"{OLLAMA}/{path}", request, await request.body())


_SPEECH_LOCK = threading.Lock()


def _recognize_one_at_a_time(recognize, pcm, prompt):
    with _SPEECH_LOCK:  # one transcription on the GPU at a time, in the order they came
        return recognize(pcm, prompt)


@app.post("/transcribe")
async def transcribe(request: Request, engine: str = "", prompt: str = "", x_careflow_key: str = Header(default="")) -> dict:
    """16-bit PCM in; `engine` picks the speech model (default: the first loaded), `prompt` is the app's vocabulary."""
    check_key(x_careflow_key)
    if not ENGINES:
        raise HTTPException(status_code=503, detail="No speech model is loaded on this server (CAREFLOW_STT is empty)")
    if engine and engine not in ENGINES:
        raise HTTPException(status_code=400, detail=f"No {engine} speech model here (loaded: {', '.join(ENGINES)})")
    recognize = ENGINES[engine or DEFAULT][2]
    body = await request.body()
    if len(body) % 2:
        raise HTTPException(status_code=400, detail="Expected 16-bit PCM")
    pcm = np.frombuffer(body, dtype="<i2").astype(np.float32) / 32768.0
    if len(pcm) < SAMPLE_RATE // 10:
        return {"text": "", "ms": 0}
    started = time.perf_counter()
    # In a worker thread, so language-model requests keep flowing meanwhile.
    text, confidence = await asyncio.to_thread(_recognize_one_at_a_time, recognize, pcm, prompt or None)
    # Too unsure to act on (measured on the provider's recordings: clear commands scored −0.16…−0.45,
    # noise and mumbling turned into words scored −0.72…−1.08): say so instead of guessing.
    unclear = bool(text) and confidence is not None and confidence < UNCLEAR_BELOW
    return {"text": "" if unclear else text, "unclear": unclear, "heard": text if unclear else None, "confidence": confidence, "ms": round((time.perf_counter() - started) * 1000)}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")), log_level="warning")
