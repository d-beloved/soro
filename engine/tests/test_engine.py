"""Model-free tests: text cleanup, prompt shape, and the HTTP API with a fake engine."""

import json

import pytest
from fastapi.testclient import TestClient

from soro_engine import prompts
from soro_engine.api import create_api
from soro_engine.text import clean_for_speech, placeholders

TOKEN = "t" * 32


@pytest.mark.parametrize(
    ("raw", "spoken"),
    [
        ("✅ Sale recorded: 3 bags rice — ₦75,000.", "Sale recorded: three bags rice — seventy five thousand naira"),
        ("You owe Alhaji 20k", "You owe Alhaji twenty thousand"),
        ("Data 1500 naira, N2.5m, 20kg, 0.5", "Data one thousand five hundred naira, two million five hundred thousand naira, 20kg, 0.5"),
        ("💡 Money tip\nSave small every day.", "Money tip. Save small every day"),
        ('I heard: "I sell rice"', "I heard: I sell rice"),
        ("Fi owó díẹ̀ pamọ́ lójoojúmọ́.", "Fi owó díẹ̀ pamọ́ lójoojúmọ́"),
    ],
)
def test_clean_for_speech(raw, spoken):
    assert clean_for_speech(raw) == spoken


@pytest.mark.parametrize(
    ("lang", "spoken"),
    [
        ("yo", "Mo tà á ní náírà ẹgbẹ̀rún lọ́nà ọgọ́rùn-ún ó lé márùndínlọ́gbọ̀n"),
        ("ha", "Mo tà á ní naira dubu ɗari da ashirin da biyar"),
        ("ig", "Mo tà á ní naira puku narị na iri abụọ na ise"),
    ],
)
def test_clean_for_speech_says_amounts_in_the_reply_language(lang, spoken):
    assert clean_for_speech("Mo tà á ní ₦125,000", lang) == spoken


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

    def transcribe(self, data, lang, detect=False):
        return {"text": f"heard {len(data)} bytes in {lang}", "lang": "yo" if detect else lang, "seconds": 1.5}

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
    assert r.json() == {"text": "heard 4 bytes in ha", "lang": "ha", "seconds": 1.5}
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


def test_category_kept_only_where_it_applies():
    from soro_engine.prompts import needs_category, tidy_route

    assert tidy_route({"intent": "log_sale", "category": "goods"})["category"] is None
    assert tidy_route({"intent": "log_expense", "category": "personal"})["category"] is None  # not a category
    assert tidy_route({"intent": "log_expense", "category": "goods"})["category"] == "goods"
    assert tidy_route({"intent": "set_budget", "category": "food"})["category"] == "food"
    assert needs_category({"intent": "log_expense"}) and needs_category({"intent": "set_budget", "category": None})
    assert not needs_category({"intent": "log_sale"}) and not needs_category({"intent": "log_expense", "category": "food"})


def test_detect_flag_reaches_the_engine(client):
    r = client.post("/transcribe?lang=en&detect=true", content=b"1234", headers={**AUTH, "Content-Type": "audio/ogg"})
    assert r.json()["lang"] == "yo"


def test_corrections_keep_their_fields():
    from soro_engine.prompts import needs_category, tidy_route

    fix = tidy_route({"intent": "correct_last", "correct_to": "log_expense", "category": "transport"})
    assert fix["correct_to"] == "log_expense" and fix["category"] == "transport"
    assert tidy_route({"intent": "log_sale", "correct_to": "log_expense"})["correct_to"] is None
    # a category call only when the correction turns the record into a spend and says what it was
    assert needs_category({"intent": "correct_last", "correct_to": "log_expense", "item": "tithe"})
    assert not needs_category({"intent": "correct_last", "correct_to": "log_expense"})
    assert not needs_category({"intent": "correct_last", "amount_ngn": 5000})


def test_language_pick_needs_a_clear_win():
    from soro_engine.asr import SWITCH_MARGIN, Guess, pick, score_tokens

    own = Guess("en", "moral data", -0.9)
    assert pick(own, [Guess("yo", "mo ra data", -0.3), Guess("ha", "x", -1.5)]).lang == "yo"
    assert pick(own, [Guess("yo", "mo ra data", -0.9 + SWITCH_MARGIN / 2)]).lang == "en"  # near tie: keep theirs
    assert pick(own, []).lang == "en"
    assert score_tokens([-0.1, -0.2], "") == float("-inf")
    assert score_tokens([-0.1] * 50, "ra " * 40) == float("-inf")  # looping
    assert score_tokens([-0.1, -0.3], "mo ra data") == -0.2
