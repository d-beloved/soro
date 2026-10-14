"""Run the engine on your Mac (Metal for N-ATLaS, MPS for Whisper and OmniVoice), or in the GPU container (Dockerfile).

  uv run python serve_local.py                # everything
  uv run python serve_local.py --no-tts       # faster startup; set VOICE_REPLIES=off in gateway/.env
Then point the gateway at ENGINE_URL=http://localhost:8000.
"""

from __future__ import annotations

import argparse
import logging
import os

import uvicorn

from soro_engine.api import create_api
from soro_engine.engine import Parts, SoroEngine

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--no-asr", action="store_true")
    p.add_argument("--no-llm", action="store_true")
    p.add_argument("--no-tts", action="store_true")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="127.0.0.1", help="0.0.0.0 inside a container, behind the HTTPS proxy")
    a = p.parse_args()

    logging.basicConfig(level=logging.INFO)
    token = os.environ.get("ENGINE_TOKEN")
    if not token:
        raise SystemExit("Set ENGINE_TOKEN (same value as in gateway/.env)")

    engine = SoroEngine(Parts(asr=not a.no_asr, llm=not a.no_llm, tts=not a.no_tts))
    engine.load()
    uvicorn.run(create_api(engine, token), host=a.host, port=a.port)
