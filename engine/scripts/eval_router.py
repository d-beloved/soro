"""Leave-one-out check of the router on any LLM profile (config.LLM_PROFILES). Each FEW_SHOT example is routed with
itself taken out of the prompt, through the same schema and post-processing as production, and compared with its
labels. The model never sees the answer, and every profile gets the same prompt.

  uv run --extra ml python scripts/eval_router.py --profile qwen3-8b       # the GGUF in engine/models
  uv run --no-project --with modal modal run scripts/eval_router_modal.py  # every profile, on a Modal T4
"""

from __future__ import annotations

import argparse
import collections
import json
import time
from pathlib import Path

from soro_engine import prompts

TODAY = "2026-10-07"


def same(got, want) -> bool:
    if isinstance(want, str) and isinstance(got, str):
        return got.casefold().strip() == want.casefold().strip()
    if isinstance(want, (int, float)) and isinstance(got, (int, float)):
        return float(got) == float(want)
    return got == want


def run(llm, limit: int | None = None) -> list[dict]:
    """`llm`: a soro_engine.llm.LLM."""
    rows = []
    for i, (lang, text, want) in enumerate(prompts.FEW_SHOT[:limit]):
        others = prompts.FEW_SHOT[:i] + prompts.FEW_SHOT[i + 1 :]
        t = time.perf_counter()
        raw = llm.chat(prompts.route_messages(text, lang, TODAY, others), schema=prompts.ROUTER_SCHEMA, max_tokens=200)
        got = llm.finish_route(raw, text)
        secs = time.perf_counter() - t
        try:
            model = prompts.tidy_route(json.loads(raw))  # before the amount parser and the category call
        except (json.JSONDecodeError, TypeError):
            model = None
        row = {
            "lang": lang,
            "text": text,
            "want": want,
            "raw": raw,
            "got": got,
            "seconds": round(secs, 2),
            "valid": model is not None and model.get("intent") in prompts.INTENTS,
            "intent": got.get("intent") == want["intent"],
            "fields": all(same(got.get(k), v) for k, v in want.items()),
        }
        if "amount_ngn" in want:
            row["amount"] = same(got.get("amount_ngn"), want["amount_ngn"])
            row["model_amount"] = model is not None and same(model.get("amount_ngn"), want["amount_ngn"])
        rows.append(row)
        mark = "ok " if row["fields"] else ("~  " if row["intent"] else "X  ")
        print(f"{mark}[{lang}] {text[:60]!r} -> {json.dumps(got, ensure_ascii=False)[:120]}", flush=True)
    return rows


def report(name: str, rows: list[dict]) -> str:
    def rate(key: str, subset: list[dict]) -> str:
        have = [r[key] for r in subset if key in r]
        return f"{sum(have)}/{len(have)} ({100 * sum(have) / len(have):.0f}%)" if have else "-"

    lines = [
        f"{name}: {len(rows)} examples, leave-one-out",
        f"  valid JSON in the schema   {rate('valid', rows)}",
        f"  intent                     {rate('intent', rows)}",
        f"  amount (final)             {rate('amount', rows)}",
        f"  amount (model alone)       {rate('model_amount', rows)}",
        f"  every labelled field       {rate('fields', rows)}",
    ]
    by_lang = collections.defaultdict(list)
    for r in rows:
        by_lang[r["lang"]].append(r)
    for lang, subset in sorted(by_lang.items()):
        lines.append(f"  [{lang}] intent {rate('intent', subset)}, amount {rate('amount', subset)}, "
                     f"fields {rate('fields', subset)}")
    lines.append(f"  median seconds per message {sorted(r['seconds'] for r in rows)[len(rows) // 2]}")
    return "\n".join(lines)


def main() -> None:
    from soro_engine.config import LLM_PROFILES
    from soro_engine.llm import LLM, LlamaCppChat

    p = argparse.ArgumentParser()
    p.add_argument("--profile", choices=sorted(LLM_PROFILES), required=True)
    p.add_argument("--limit", type=int, help="only the first N examples (a quick smoke test)")
    p.add_argument("--out", type=Path, help="write every example's result here as JSON")
    a = p.parse_args()

    rows = run(LLM(LlamaCppChat(LLM_PROFILES[a.profile])), a.limit)
    print("\n" + report(a.profile, rows))
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(json.dumps({"profile": a.profile, "rows": rows}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
