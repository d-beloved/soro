"""Drafts Yoruba/Hausa/Igbo versions of the 30 curated tips with N-ATLaS (via the running engine).

  ENGINE_URL=https://...modal.run ENGINE_TOKEN=... uv run python scripts/translate_tips.py
Writes supabase/seed/tip_translations.json; then `cd gateway && npm run tips:sync`.
A native speaker must review each language before it is marked reviewed in the tips table.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
SEED = ROOT / "supabase/seed/tips.sql"
OUT = ROOT / "supabase/seed/tip_translations.json"

TIP_ROW = re.compile(r"\('([a-z_0-9]+)',\s*'[a-z_]+',\s*'((?:[^']|'')*)'\)")


def main() -> None:
    url = os.environ.get("ENGINE_URL", "http://localhost:8000").rstrip("/")
    token = os.environ["ENGINE_TOKEN"]
    tips = {tid: text.replace("''", "'") for tid, text in TIP_ROW.findall(SEED.read_text())}
    print(f"{len(tips)} tips found")

    done: dict[str, dict[str, str]] = json.loads(OUT.read_text()) if OUT.exists() else {}
    with httpx.Client(timeout=180, headers={"Authorization": f"Bearer {token}"}) as client:
        for tid, text in tips.items():
            entry = done.setdefault(tid, {})
            for lang in ("yo", "ha", "ig"):
                if entry.get(lang):
                    continue
                r = client.post(f"{url}/translate", json={"text": text, "target": lang})
                r.raise_for_status()
                entry[lang] = r.json()["text"].strip()
                print(f"[{lang}] {tid}: {entry[lang][:70]}")
            OUT.write_text(json.dumps(done, ensure_ascii=False, indent=2) + "\n")  # save as we go
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
