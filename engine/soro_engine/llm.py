"""N-ATLaS via llama.cpp (CUDA on Modal, Metal on Apple Silicon)."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from . import prompts
from .config import LLM_CTX, LLM_REPEAT_PENALTY, LLM_TEMPERATURE, Lang


class LLM:
    def __init__(self, gguf_path: Path, n_gpu_layers: int = -1, n_ctx: int = LLM_CTX):
        from llama_cpp import Llama

        if not gguf_path.exists():
            raise FileNotFoundError(f"{gguf_path} missing: run setup_models first")
        self._llm = Llama(
            model_path=str(gguf_path),
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            chat_format="llama-3",
            verbose=False,
        )
        self._lock = threading.Lock()  # a llama.cpp context is not thread-safe

    def chat(self, messages: list[dict], schema: dict | None = None, max_tokens: int = 256) -> str:
        kwargs: dict = dict(temperature=LLM_TEMPERATURE, repeat_penalty=LLM_REPEAT_PENALTY, max_tokens=max_tokens)
        if schema is not None:
            kwargs["response_format"] = {"type": "json_object", "schema": schema}
        with self._lock:
            out = self._llm.create_chat_completion(messages=messages, **kwargs)
        return (out["choices"][0]["message"]["content"] or "").strip()

    def route(self, text: str, lang: Lang, today: str) -> dict:
        raw = self.chat(prompts.route_messages(text, lang, today), schema=prompts.ROUTER_SCHEMA, max_tokens=200)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"intent": "unknown"}

    def adapt(self, tip: str, question: str, lang: Lang) -> str:
        return self.chat(prompts.adapt_messages(tip, question, lang), max_tokens=220)

    def translate(self, text: str, target: Lang) -> str:
        if target == "en":
            return text
        return self.chat(prompts.translate_messages(text, target), max_tokens=max(128, len(text)))
