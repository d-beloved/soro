"""Model-free tests: text cleanup, prompt shape, and the HTTP API with a fake engine."""

import json

import pytest
from fastapi.testclient import TestClient

from soro_engine import prompts
from soro_engine.api import create_api
from soro_engine.text import clean_for_speech, placeholders, split_sentences

TOKEN = "t" * 32


@pytest.mark.parametrize(
    ("raw", "spoken"),
    [
        ("✅ Sale recorded: 3 bags rice — ₦75,000.", "Sale recorded: 3 bags rice — 75000 naira"),
        ("You owe Alhaji 20k", "You owe Alhaji 20000"),
        ("💡 Money tip\nSave small every day.", "Money tip. Save small every day"),
        ('I heard: "I sell rice"', "I heard: I sell rice"),
        ("Fi owó díẹ̀ pamọ́ lójoojúmọ́.", "Fi owó díẹ̀ pamọ́ lójoojúmọ́"),
    ],
)
def test_clean_for_speech(raw, spoken):
    assert clean_for_speech(raw) == spoken


def test_split_sentences_respects_limit():
    text = "One short sentence. " * 30
    chunks = split_sentences(text, max_chars=100)
    assert all(len(c) <= 100 for c in chunks)
    assert " ".join(chunks).count("One") == 30
    assert split_sentences("word " * 100, max_chars=50)[0].endswith("word")


def test_router_prompt_and_schema():
    msgs = prompts.route_messages("I sell rice 5k", "yo", "2026-10-07")
    assert msgs[0]["role"] == "system" and "2026-10-07" in msgs[0]["content"] and "Yoruba" in msgs[0]["content"]
    assert msgs[-1] == {"role": "user", "content": "I sell rice 5k"}
    # every few-shot answer must satisfy the schema's enums
    props = prompts.ROUTER_SCHEMA["properties"]
    for _, out in prompts.FEW_SHOT:
        assert out["intent"] in props["intent"]["enum"]
        for k, v in out.items():
            assert k in props
            if "enum" in props[k]:
                assert v in props[k]["enum"]


def test_placeholders():
    assert placeholders("Sale {what}{amount}, today {today_total}") == ["{amount}", "{today_total}", "{what}"]


class FakeEngine:
    def status(self):
        return {"asr": True, "llm": True, "tts": True}

    def transcribe(self, data, lang):
        return {"text": f"heard {len(data)} bytes in {lang}", "seconds": 1.5}

    def route(self, text, lang, today):
        return {"intent": "log_sale", "amount_ngn": 5000}

    def adapt(self, tip, question, lang):
        return f"[{lang}] {tip}"

    def translate(self, text, target):
        return f"[{target}] {text}"

    def speak(self, text, lang):
        return b"OggS fake"


@pytest.fixture
def client():
    return TestClient(create_api(FakeEngine(), TOKEN))


AUTH = {"Authorization": f"Bearer {TOKEN}"}


def test_health_is_public(client):
    assert client.get("/health").json()["ok"] is True


def test_auth_required(client):
    assert client.post("/route", json={"text": "x", "lang": "en", "today": "2026-10-07"}).status_code == 401
    bad = {"Authorization": "Bearer nope"}
    assert client.post("/route", json={"text": "x", "lang": "en", "today": "2026-10-07"}, headers=bad).status_code == 401


def test_routes(client):
    r = client.post("/transcribe?lang=ha", content=b"1234", headers={**AUTH, "Content-Type": "audio/ogg"})
    assert r.json() == {"text": "heard 4 bytes in ha", "seconds": 1.5}
    r = client.post("/route", json={"text": "I sell 5k", "lang": "en", "today": "2026-10-07"}, headers=AUTH)
    assert r.json()["intent"]["intent"] == "log_sale"
    r = client.post("/adapt", json={"tip": "Save daily.", "question": "How?", "lang": "ig"}, headers=AUTH)
    assert r.json()["text"] == "[ig] Save daily."
    r = client.post("/speak", json={"text": "hello", "lang": "en"}, headers=AUTH)
    assert r.headers["content-type"] == "audio/ogg" and r.content.startswith(b"OggS")


def test_rejects_unknown_language(client):
    r = client.post("/translate", json={"text": "hi", "target": "fr"}, headers=AUTH)
    assert r.status_code == 422


def test_schema_is_json_serialisable():
    json.dumps(prompts.ROUTER_SCHEMA)
