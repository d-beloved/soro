"""Deterministic amount parsing and the check on the router's amount_ngn."""

import pytest

from soro_engine import prompts
from soro_engine.amounts import (
    _YO_LONG,
    _near,
    extract_amount_ngn,
    other_amounts,
    reconcile_amount,
)


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
    assert reconcile_amount(r, "mo ta ata ni ẹ̀ẹ́dógún") == r  # a bare small number: trust the model
    r = {"intent": "log_debt", "counterparty": "Emeka", "amount_ngn": 12500}
    assert reconcile_amount(r, "Emeka jẹ mí ní náírà ẹgbẹ̀rún méjìlá àti ẹ̀ẹ́dẹ́gbẹ̀ta") == r  # was read as 512,000


def test_reconcile_ignores_quantity_and_other_intents():
    r = {"intent": "log_sale", "item": "sachet water", "quantity": 150}
    assert "amount_ngn" not in reconcile_amount(r, "I sell 150 pieces of sachet water")
    r = {"intent": "stock_update", "item": "Indomie", "quantity": 200}
    assert reconcile_amount(r, "I get 200 carton remain") == r


def test_reconcile_lists_amounts_the_record_leaves_out():
    # the router saves one record: the fuel expense is not in it, so the user is told
    r = {"intent": "log_sale", "amount_ngn": 8000}
    assert reconcile_amount(r, "I sell rice 5k and beans 3k, and I buy fuel 2k")["other_amounts"] == [2000]
    r = {"intent": "log_sale", "amount_ngn": 5000}
    assert reconcile_amount(r, "rice 5k, beans 3k")["other_amounts"] == [3000]
    r = {"intent": "log_expense", "amount_ngn": 2000}
    out = reconcile_amount(r, "Na dubu biyar na sayar, sannan na sayi mai dubu biyu")
    assert out["other_amounts"] == [5000]


def test_reconcile_no_other_amounts_when_all_are_in_the_record():
    for r, text in [
        ({"intent": "log_sale", "quantity": 3, "amount_ngn": 75000}, "I sell 3 bags for 75k, 25k each"),
        ({"intent": "log_expense", "amount_ngn": 5500}, "I buy fuel 4500 and transport 1000"),
        ({"intent": "log_sale", "amount_ngn": 5000}, "I sell rice 5k. Yes, 5k"),
        ({"intent": "log_sale", "amount_ngn": 125000}, "I sell 3 bags of rice for 125k"),
        ({"intent": "log_sale", "amount_ngn": 10000}, "rice 5k and beans 5k"),
    ]:
        assert "other_amounts" not in reconcile_amount(r, text), text


def test_other_amounts_skips_intents_that_name_several_amounts():
    for intent in ("correct_last", "debt_paid", "loan_intake", "set_budget"):
        r = {"intent": intent, "amount_ngn": 7000}
        assert "other_amounts" not in reconcile_amount(r, "not 5k, 7k"), intent


def test_other_amounts_rules():
    assert other_amounts(8000, [5000, 3000, 2000]) == [2000]
    assert other_amounts(50000, [25000, 10000], qty=2) == [10000]
    assert other_amounts(9000, [5000, 3000]) == [5000, 3000]  # nothing adds up: both are reported
    assert other_amounts(5000, [5000]) == []


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


# What the Yoruba ASR actually wrote for amounts spoken by our own TTS (scripts/voice_check.py, Oct 2026).
@pytest.mark.parametrize(("heard", "amount"), [
    ("mo ti kọ́ ọjà tí ó tà sílẹ̀ náírà ẹ̀gbẹ̀rún lọ́nà ọgọ́rùn-ún ó lé márùndú lọ́gbọ̀n", 125_000),  # split, "dú"
    ("èmi kàjẹ́ ní náírà rẹ̀gbẹ̀rún méjìlá àti ẹ̀ẹ́dẹ́gbẹ̀ta.", 12_500),  # "rẹ̀gbẹ̀rún"
    ("mo ti kọ ọjà tí ó tà sílẹ̀ náírà ẹgbẹ̀rún lọ́nà márùndínlọ́gárin.", 75_000),  # "lọ́gárin"
    (("owó rẹ̀ lónìí, ọjà tí ó tà náírà mílíọ̀lù kan àti ẹgbẹ̀rún lọ́nà ọ̀dúnrún ó lé àádọ́ta, ìnáwó owó náírà "
      "ẹgbẹ̀rún lọ́nà méjìlélúgójì."), 1_350_000),  # "mílíọ̀lù", "ọ̀dúnrún", "lúgójì"
    ("náírà mílíọ̀nù kan àti ẹgbẹ̀rúnlọ́nà ọ̀ọ́dúnrún", 1_300_000),  # run together
    ("náírà ẹgbẹ̀rún lọ́nà méjìlílógún", 22_000),  # "lí" for "lé"
])
def test_yoruba_as_the_asr_mishears_it(heard, amount):
    assert extract_amount_ngn(heard) == amount


def test_near_misses_between_two_numbers_are_not_guessed():
    assert _near("aadoran", _YO_LONG) is None  # aadorin 70 or aadorun 90
    assert _near("egberan", _YO_LONG) is None  # egberin 800 or egberun 1000
    assert _near("eedegberan", _YO_LONG) is None  # 700 or 900
    assert extract_amount_ngn("náírà ẹgbẹ̀rún lọ́nà márùndínlọ́gọ́ran") == 1000  # 75 or 95: not guessed


def test_near_misses_leave_other_words_alone():
    assert extract_amount_ngn("I sold metals and cement for 5k") == 5000
    assert extract_amount_ngn("Mo ra ẹ̀wà fún ọmọ mi") is None
