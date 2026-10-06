"""Deterministic amount parsing and the check on the router's amount_ngn."""

import pytest

from soro_engine import prompts
from soro_engine.amounts import extract_amount_ngn, reconcile_amount


@pytest.mark.parametrize(
    ("text", "amount"),
    [
        # digits, English and Pidgin
        ("mo ra rice agolo kan 10,000", 10000),
        ("Mama Nkechi owe me 5k for the tomatoes", 5000),
        ("I don buy fuel for generator 4500", 4500),
        ("I need loan of 2.5m", 2500000),
        ("sold 2 crates of egg ₦9,000", 9000),
        ("customer pay me N12500", 12500),
        ("I sell 3 bags rice 5 thousand naira", 5000),
        ("I sell three bags of rice seventy five thousand", 75000),
        ("two thousand five hundred naira for transport", 2500),
        ("one hundred and fifty thousand", 150000),
        ("five k for pepper", 5000),
        # Yoruba, with and without tone marks
        ("Mo ta apo iresi meji ni egberun lona ogbon naira", 30000),
        ("Mo ta ata ní ẹgbẹ̀rún márùn-ún naira", 5000),
        ("ẹgbẹ̀rún mẹ́wàá", 10000),
        ("ẹgbàá mẹ́ta ni mo fi ra epo", 6000),
        ("egberun kan", 1000),
        # Hausa
        ("Na sayar da buhun shinkafa uku naira dubu saba'in da biyar", 75000),
        ("Ina bin Musa bashin naira dubu biyar", 5000),
        ("naira dubu biyar da ɗari biyu", 5200),
        ("dubu ɗari biyu", 200000),
        ("dubu goma sha biyar", 15000),
        # Igbo
        ("Erere m akpa osikapa abụọ, puku naira iri ise", 50000),
        ("puku iri abụọ na ise", 25000),
    ],
)
def test_extract(text, amount):
    assert extract_amount_ngn(text) == amount


@pytest.mark.parametrize(
    "text",
    ["I sell three bags of rice", "Good morning o", "mo lo si oke", "How much I don sell this week", "call me 08031234567"],
)
def test_no_amount(text):
    assert extract_amount_ngn(text) is None


def test_reconcile_replaces_invented_amount():
    out = reconcile_amount({"intent": "log_sale", "amount_ngn": 200000}, "Mo ta apo iresi meji ni egberun lona ogbon naira")
    assert out["amount_ngn"] == 30000


def test_reconcile_fills_missing_amount():
    r = {"intent": "log_debt", "counterparty": "Mama Nkechi", "direction": "owed_to_me"}
    assert reconcile_amount(r, "Mama Nkechi owe me 5k for the tomatoes")["amount_ngn"] == 5000


def test_reconcile_keeps_model_when_it_matches_text():
    r = {"intent": "log_sale", "quantity": 2, "amount_ngn": 50000}
    assert reconcile_amount(r, "I sell 2 bags at 25k each") == r  # price x quantity
    r = {"intent": "log_expense", "amount_ngn": 5500}
    assert reconcile_amount(r, "I buy fuel 4500 and transport 1000") == r  # sum
    r = {"intent": "log_sale", "amount_ngn": 15}
    assert reconcile_amount(r, "mo ta ata ni ẹ̀ẹ́dógún") == r  # a form we can't parse: trust the model


def test_reconcile_ignores_quantity_and_other_intents():
    r = {"intent": "log_sale", "item": "sachet water", "quantity": 150}
    assert "amount_ngn" not in reconcile_amount(r, "I sell 150 pieces of sachet water")
    r = {"intent": "stock_update", "item": "Indomie", "quantity": 200}
    assert reconcile_amount(r, "I get 200 carton remain") == r


def test_few_shot_amounts_agree_with_parser():
    for text, out in prompts.FEW_SHOT:
        if out.get("amount_ngn") is not None:
            assert extract_amount_ngn(text) == out["amount_ngn"], text


def test_reconcile_covers_new_intents():
    # a hallucinated amount on the new money intents is replaced by the one in the message
    for intent in ("log_income", "debt_paid", "set_budget", "correct_last"):
        assert reconcile_amount({"intent": intent, "amount_ngn": 7}, "na 50k")["amount_ngn"] == 50000
    # undo has no amount and is left alone
    assert reconcile_amount({"intent": "undo_last"}, "cancel the 5k one") == {"intent": "undo_last"}
