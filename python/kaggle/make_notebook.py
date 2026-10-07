"""
Builds careflow_kaggle.ipynb — the notebook to import into Kaggle (File → Import Notebook), then Run All.

    python python/kaggle/make_notebook.py

Cell 1 writes careflow_gpu_server.py (this folder's copy, so the two never drift apart); cell 2 installs
Ollama + qwen3.5:9b, MedGemma 4B and Qwen3Guard 4B, Ternary Bonsai 2 27B (PrismML's llama-server, T4 x2), Whisper and Omi Med STT, starts the server and prints the address and key to put in
CareFlow → Configuration → Where the AI runs → Kaggle GPU.

Every Run All starts Ollama afresh and LOADS the models before anything else (an Ollama left from an earlier run
can be stuck: qwen3.5:9b once never loaded until Ollama was restarted). A model that will not load is retried
after a restart, and the notebook stops with Ollama's log if it still will not. While the app runs, the server
restarts a stuck Ollama by itself.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
server = (HERE / "careflow_gpu_server.py").read_text(encoding="utf-8")

launcher = r'''# CareFlow on this GPU: Qwen 3.5 9B, MedGemma 4B, Qwen3Guard 4B (Ollama), Ternary Bonsai 2 27B (llama-server)
# + Whisper / Omi Med STT v1, behind one address.
# Notebook settings: Accelerator = GPU T4 (or GPU T4 x2: both models stay loaded), Internet = On. Then Run All.
import os, re, shutil, subprocess, time

# The same key goes into CareFlow → Configuration → Where the AI runs → Key. Change it if you like.
KEY = "CHANGE-ME"

# The names the app asks for (Configuration → Agents → each agent's model). The first is every agent's default.
#   qwen3.5:9b      calls tools — what every agent needs to act
#   MedGemma 4B     Google's medical Gemma 3 (GGUF by unsloth) — medical text; Ollama runs it without tools
#   Qwen3Guard 4B   Qwen's safety classifier (safe / unsafe / controversial) — no tools
MODELS = ["qwen3.5:9b", "hf.co/unsloth/medgemma-4b-it-GGUF:Q4_K_M", "hf.co/mradermacher/Qwen3Guard-Gen-4B-GGUF:Q4_K_M"]
CTX = 16384                            # tokens per request: the assistant's instructions and tools take ~8k

# Ternary Bonsai 2 27B (Qwen3.8-27B, ternary weights, PQ2_0 7.2 GB) — the Summary Agent's default model. Only
# PrismML's llama.cpp fork runs PQ2_0 (stock llama.cpp and Ollama cannot): its llama-server, on the second T4.
BONSAI_REPO, BONSAI_FILE = "prism-ml/Ternary-Bonsai-2-27B-gguf", "Ternary-Bonsai-2-27B-PQ2_0.gguf"
BONSAI_MODEL = "ternary-bonsai-2-27b"  # the name the app asks for
BONSAI_PORT = 8081
BONSAI_DIR = "/kaggle/tmp/bonsai"      # 7.2 GB — outside /kaggle/working (its 20 GB are for the outputs)

def sh(cmd, check=True):
    print("$", cmd, flush=True)
    return subprocess.run(cmd, shell=True, check=check)

def answers(url, headers=None):
    import urllib.request
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=5)
        return True
    except Exception:
        return False

def gpu_used():
    """GPU memory in use on all GPUs together (MiB)."""
    out = subprocess.run("nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits", shell=True, capture_output=True, text=True).stdout
    return sum(int(x) for x in out.split() if x.strip().isdigit())

def tail(path, lines=1):
    """The last lines of a log — what a process is doing right now."""
    try:
        text = [l for l in open(path, errors="replace").read().replace("\r", "\n").splitlines() if l.strip()]
        return "\n".join(text[-lines:])
    except OSError:
        return ""

# 0. Run All again in the same session: the last run's server and tunnel still hold port 8000 — stop them first.
#    vLLM / llama.cpp from the earlier notebooks would hold GPU memory: stop them too.
#    ([c] keeps pkill from matching — and killing — the very shell that runs this line.)
sh("pkill -f '[c]areflow_gpu_server.py'; pkill -x cloudflared; pkill -f '[v]llm-env/bin/vllm'; pkill -f '[l]lama-server'; sleep 3", check=False)

gpu_info = subprocess.run("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader", shell=True, capture_output=True, text=True).stdout.strip()
print("GPU:", gpu_info or "none — set Accelerator = GPU T4 in the notebook settings")
if not gpu_info:
    raise SystemExit("No GPU in this session.")
gpus = gpu_info.count("\n") + 1

# 1. The language models: Ollama with the MODELS above on the GPU (its installer needs zstd, which Kaggle's image
#    lacks). Each agent picks one in CareFlow → Configuration → Agents.
#    One T4: one language model in GPU memory at a time, so Whisper always has room next to it.
#    T4 x2: qwen3.5:9b is loaded now and stays; MedGemma and Qwen3Guard load when an agent first asks for one.
OLLAMA_LOG = "/kaggle/working/ollama.log"
KEEP_ALIVE = "-1" if gpus >= 2 else "60m"
# The agents work at the same time (multi-agent mode): Ollama answers that many requests to one model together
# instead of queueing them (each one gets its own CTX-token context on the GPU — a few hundred MB each). Five on
# T4 x2: every record agent of one request (medications, diagnoses, tasks, recalls, appointments) at once.
PARALLEL = "5" if gpus >= 2 else "2"
OLLAMA_ENV = {"OLLAMA_MAX_LOADED_MODELS": "3" if gpus >= 2 else "1", "OLLAMA_CONTEXT_LENGTH": str(CTX), "OLLAMA_KEEP_ALIVE": KEEP_ALIVE,
              "OLLAMA_NUM_PARALLEL": PARALLEL}
PRELOAD = MODELS[:1]  # qwen3.5:9b, every agent's default; the others load when an agent first asks for one
LOAD_STALL_S = 120                             # no new GPU memory for this long while loading = stuck

def start_ollama():
    """Ollama afresh: an Ollama left over from an earlier run may be stuck (see the note at the top)."""
    sh("pkill -x ollama; sleep 3", check=False)
    subprocess.Popen(["ollama", "serve"], stdout=open(OLLAMA_LOG, "a"), stderr=subprocess.STDOUT,
                     env={**os.environ, **OLLAMA_ENV}, start_new_session=True)
    for _ in range(30):
        time.sleep(2)
        if answers("http://127.0.0.1:11434/api/version"):
            return
    print(tail(OLLAMA_LOG, 40))
    raise SystemExit("Ollama did not start — the log above says why.")

def in_memory():
    import json, urllib.request
    try:
        return [m["name"] for m in json.load(urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=5)).get("models", [])]
    except Exception:
        return []

def load(model):
    """Load a model into GPU memory with the app's context size. False when it makes no progress for LOAD_STALL_S."""
    import json, threading, urllib.request
    body = json.dumps({"model": model, "keep_alive": int(KEEP_ALIVE) if KEEP_ALIVE.lstrip("-").isdigit() else KEEP_ALIVE, "options": {"num_ctx": CTX}}).encode()
    def request():
        try:
            urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:11434/api/generate", data=body, headers={"Content-Type": "application/json"}), timeout=900).read()
        except Exception as exc:
            print(f"   {model}: {exc}", flush=True)
    worker = threading.Thread(target=request, daemon=True)
    worker.start()
    started = progress = time.time()
    last = gpu_used()
    while worker.is_alive():
        worker.join(5)
        used = gpu_used()
        if used >= last + 128:
            last, progress = used, time.time()
        if time.time() - progress >= LOAD_STALL_S:
            return False
        if int(time.time() - started) % 30 < 5:
            print(f"   loading {model}: {int(time.time() - started)} s, GPU memory {used} MiB", flush=True)
    return model in in_memory()

sh("apt-get update -qq && apt-get install -y -qq zstd")
if not shutil.which("ollama"):  # installed by the last run already: keep it
    sh("curl -fsSL https://ollama.com/install.sh | sh")
start_ollama()
for model in MODELS:
    sh(f"ollama pull {model}")  # qwen3.5:9b ~6.6 GB, MedGemma ~3.3 GB, Qwen3Guard ~2.5 GB — the first run takes a while
sh("ollama list")
for model in PRELOAD:
    print(f"Loading {model} into GPU memory…", flush=True)
    t0 = time.time()
    if not load(model):
        print(f"{model} made no progress for {LOAD_STALL_S} s — restarting Ollama and trying once more", flush=True)
        start_ollama()
        for earlier in PRELOAD[:PRELOAD.index(model)]:
            load(earlier)
        if not load(model):
            print(tail(OLLAMA_LOG, 60))
            raise SystemExit(f"{model} would not load into GPU memory — Ollama's log above says why.")
    print(f"   {model} loaded in {int(time.time() - t0)} s", flush=True)
sh("ollama ps")
sh("nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv")

# 1b. Ternary Bonsai 2 27B on the second T4 (7.2 GB of weights + its context). One T4 has no room for it next to
#     qwen3.5:9b and Whisper: skipped there — the app's Summary Agent then uses MedGemma or Qwen3.5 9B.
BONSAI_LOG = "/kaggle/working/bonsai.log"
bonsai = None
def prism_llama_server():
    """llama-server of PrismML's fork: its prebuilt Linux CUDA 12.4 binaries — or built from source for the T4."""
    import glob, json, urllib.request
    found = glob.glob(f"{BONSAI_DIR}/bin/**/llama-server", recursive=True)
    if found:
        return found[0]
    os.makedirs(f"{BONSAI_DIR}/bin", exist_ok=True)
    try:
        release = json.load(urllib.request.urlopen("https://api.github.com/repos/PrismML-Eng/llama.cpp/releases/latest", timeout=30))
        asset = next(a for a in release["assets"] if re.search(r"bin-linux-cuda-12\.4-x64\.tar\.gz$", a["name"]))
        sh(f"wget -q -O {BONSAI_DIR}/prism.tar.gz {asset['browser_download_url']} && tar -xzf {BONSAI_DIR}/prism.tar.gz -C {BONSAI_DIR}/bin")
        found = glob.glob(f"{BONSAI_DIR}/bin/**/llama-server", recursive=True)
        if found and subprocess.run(f"LD_LIBRARY_PATH={os.path.dirname(found[0])} {found[0]} --version", shell=True).returncode == 0:
            return found[0]
    except Exception as exc:
        print("   prebuilt binary not usable:", exc, flush=True)
    print("   building PrismML's llama.cpp for the T4 (sm_75) — 15–25 minutes the first time…", flush=True)
    sh(f"rm -rf {BONSAI_DIR}/src && git clone -q --depth 1 https://github.com/PrismML-Eng/llama.cpp {BONSAI_DIR}/src")
    sh(f"cd {BONSAI_DIR}/src && cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=75 -DLLAMA_CURL=OFF > /dev/null && cmake --build build -j --target llama-server > /dev/null")
    return f"{BONSAI_DIR}/src/build/bin/llama-server"

if gpus >= 2:
    try:
        exe = prism_llama_server()
        sh("pip install -q huggingface_hub")
        from huggingface_hub import hf_hub_download
        weights = hf_hub_download(BONSAI_REPO, BONSAI_FILE, local_dir=BONSAI_DIR)  # 7.2 GB, once per session
        bonsai = subprocess.Popen(
            [exe, "-m", weights, "--alias", BONSAI_MODEL, "--host", "127.0.0.1", "--port", str(BONSAI_PORT),
             "-ngl", "99", "-fa", "auto", "-c", str(CTX * 2), "-np", "2", "--jinja",
             "--temp", "0.7", "--top-p", "0.8", "--top-k", "20", "--min-p", "0"],
            env={**os.environ, "CUDA_VISIBLE_DEVICES": "1", "LD_LIBRARY_PATH": f"{os.path.dirname(exe)}:{os.environ.get('LD_LIBRARY_PATH', '')}"},
            stdout=open(BONSAI_LOG, "w"), stderr=subprocess.STDOUT, start_new_session=True)
        print("Loading Ternary Bonsai 2 27B on the second T4…", flush=True)
        for step in range(180):  # up to 15 minutes
            time.sleep(5)
            if answers(f"http://127.0.0.1:{BONSAI_PORT}/health") or bonsai.poll() is not None:
                break
        if answers(f"http://127.0.0.1:{BONSAI_PORT}/health"):
            print(f"   {BONSAI_MODEL} ready", flush=True)
        else:
            print(tail(BONSAI_LOG, 30))
            print(f"   {BONSAI_MODEL} did not start — the app's Summary Agent uses MedGemma or Qwen3.5 9B instead.", flush=True)
    except Exception as exc:
        print(f"   Ternary Bonsai skipped: {exc}", flush=True)
else:
    print("One T4: no room for Ternary Bonsai 2 27B next to qwen3.5:9b and Whisper — skipped (choose GPU T4 x2 for it).", flush=True)
sh("nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv")

# 2. Speech recognition: Whisper large-v3-turbo on the GPU (best with non-US accents) and Omi Med STT v1.
#    The server builds parakeet.cpp for CUDA for Omi the first time it starts (5–15 minutes; CPU build if that fails).
sh("pip install -q omi-med-stt faster-whisper fastapi uvicorn httpx cmake")

# 3. The CareFlow server (port 8000)
# It restarts a stuck Ollama by itself, with the same settings (OLLAMA_ENV) — no restarting by hand.
server = subprocess.Popen(["python", "/kaggle/working/careflow_gpu_server.py"],
                          env={**os.environ, **OLLAMA_ENV, "CAREFLOW_KEY": KEY, "CAREFLOW_NUM_CTX": str(CTX),
                               "BONSAI_URL": f"http://127.0.0.1:{BONSAI_PORT}", "BONSAI_MODEL": BONSAI_MODEL,
                               "CAREFLOW_KEEP_ALIVE": KEEP_ALIVE, "CAREFLOW_LOAD_STALL_S": str(LOAD_STALL_S), "CAREFLOW_OLLAMA_LOG": OLLAMA_LOG},
                          stdout=open("/kaggle/working/server.log", "w"), stderr=subprocess.STDOUT)
print("Starting the CareFlow server — the first start downloads Whisper and builds parakeet.cpp for CUDA (5–15 minutes)…", flush=True)
started = time.time()
for step in range(360):  # up to 30 minutes
    time.sleep(5)
    if answers("http://127.0.0.1:8000/health", {"X-CareFlow-Key": KEY}) or server.poll() is not None:
        break
    if step % 6 == 5:  # every 30 seconds
        print(f"   server: {int(time.time() - started) // 60} min · {tail('/kaggle/working/server.log')[:160]}", flush=True)
print(open("/kaggle/working/server.log").read()[-2000:])
if server.poll() is not None:
    raise SystemExit("The server stopped — the log above says why.")

# 4. The public address: a Cloudflare quick tunnel (free, no account; steadier than localtunnel for long requests)
if not os.access("/kaggle/working/cloudflared", os.X_OK):  # downloaded by the last run already: reuse it
    sh("wget -q -O /kaggle/working/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /kaggle/working/cloudflared")
tunnel = subprocess.Popen(["/kaggle/working/cloudflared", "tunnel", "--no-autoupdate", "--url", "http://localhost:8000"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
for line in tunnel.stdout:
    found = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
    if found:
        print("=" * 64)
        print("CareFlow → Configuration → Where the AI runs → Kaggle GPU (remote)")
        print("  Server address:", found.group(0))
        print("  Key:           ", KEY)
        print("  Models:        ", ", ".join(MODELS), "(Ollama) — in GPU memory now:", ", ".join(in_memory()) or "none yet")
        print("  Summaries:     ", BONSAI_MODEL, "(llama-server, second T4):", "ready" if answers(f"http://127.0.0.1:{BONSAI_PORT}/health") else "not running")
        print("  Agents at once:", PARALLEL, "requests per model (OLLAMA_NUM_PARALLEL)")
        print("Keep this notebook running while you use the app.")
        print("=" * 64, flush=True)
        break
'''


def cell(source: str) -> dict:
    return {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": source.splitlines(keepends=True)}


notebook = {
    "cells": [cell("%%writefile /kaggle/working/careflow_gpu_server.py\n" + server), cell(launcher)],
    "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"}, "language_info": {"name": "python"}},
    "nbformat": 4,
    "nbformat_minor": 5,
}
(HERE / "careflow_kaggle.ipynb").write_text(json.dumps(notebook, indent=1), encoding="utf-8")
print("wrote", HERE / "careflow_kaggle.ipynb")
