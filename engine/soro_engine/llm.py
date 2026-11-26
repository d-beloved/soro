"""The language model's jobs (routing, tutoring, translating) on any chat model; llama.cpp is the one backend so far
(CUDA in the container and on Modal, Metal on Apple Silicon)."""

from __future__ import annotations

import json
import re
import threading
from typing import Protocol

from . import prompts
from .amounts import reconcile_amount
from .config import LLM_CTX, Lang, LLMProfile


class ChatModel(Protocol):
    def chat(self, messages: list[dict], schema: dict | None = None, max_tokens: int = 256) -> str:
        """The reply's text. With a schema, the backend must constrain the reply to it, not just ask for it."""
        ...


# Qwen3 and other reasoning models may think out loud first. With a schema, the grammar already rules it out.
_THINKING = re.compile(r"^\s*<think>.*?</think>\s*", re.S)


class LlamaCppChat:
    """Any GGUF through llama.cpp, with JSON schemas enforced by its grammar."""

    def __init__(self, profile: LLMProfile, n_gpu_layers: int = -1, n_ctx: int = LLM_CTX):
        from llama_cpp import Llama

        if not profile.gguf.exists():
            raise FileNotFoundError(f"{profile.gguf} missing: run setup_models first")
        self._llm = Llama(
            model_path=str(profile.gguf),
            n_gpu_layers=n_gpu_layers,
            n_ctx=n_ctx,
            chat_format=profile.chat_format,
            verbose=False,
        )
        self._profile = profile
        self._lock = threading.Lock()  # a llama.cpp context is not thread-safe

    def chat(self, messages: list[dict], schema: dict | None = None, max_tokens: int = 256) -> str:
        p = self._profile
        kwargs: dict = dict(temperature=p.temperature, repeat_penalty=p.repeat_penalty, max_tokens=max_tokens)
        if schema is not None:
            kwargs["response_format"] = {"type": "json_object", "schema": schema}
        with self._lock:
            out = self._llm.create_chat_completion(messages=messages, **kwargs)
        return _THINKING.sub("", out["choices"][0]["message"]["content"] or "").strip()


class LLM:
    def __init__(self, model: ChatModel):
        self.model = model

    def chat(self, messages: list[dict], schema: dict | None = None, max_tokens: int = 256) -> str:
        return self.model.chat(messages, schema, max_tokens)

    def route(self, text: str, lang: Lang, today: str, en_text: str | None = None) -> dict:
        """`en_text`: the English model's hearing of a yo/ha/ig voice note, see SoroEngine.transcribe."""
        text = prompts.router_input(text, en_text)
        raw = self.chat(prompts.route_messages(text, lang, today), schema=prompts.ROUTER_SCHEMA, max_tokens=200)
        return self.finish_route(raw, text)

    def finish_route(self, raw: str, text: str) -> dict:
        """The model's router JSON, checked and completed: `text` as router_input() built it."""
        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            return {"intent": "unknown"}
        result = prompts.tidy_route(result)
        if prompts.needs_category(result):
            result = {**result, "category": self._category(text)}
        return reconcile_amount(result, text)

    def _category(self, text: str) -> str | None:
        raw = self.chat(prompts.category_messages(text), schema=prompts.CATEGORY_SCHEMA, max_tokens=20)
        try:
            return prompts.tidy_route({"intent": "log_expense", **json.loads(raw)}).get("category")
        except (json.JSONDecodeError, TypeError):
            return None

    def adapt(self, tip: str, question: str, lang: Lang) -> str:
        return self.chat(prompts.adapt_messages(tip, question, lang), max_tokens=220)

    def translate(self, text: str, target: Lang) -> str:
        if target == "en":
            return text
        return self.chat(prompts.translate_messages(text, target), max_tokens=max(128, len(text)))
