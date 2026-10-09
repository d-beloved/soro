"""Number words for the TTS, checked against forms a native speaker would say (and amounts.py can read back)."""

import pytest

from soro_engine.amounts import extract_amount_ngn
from soro_engine.numwords import say_naira, say_number

CASES = {
    "en": {
        5: "five",
        1005: "one thousand and five",
        12_500: "twelve thousand five hundred",
        125_000: "one hundred and twenty five thousand",
        1_350_000: "one million three hundred and fifty thousand",
    },
    "ha": {
        15: "goma sha biyar",
        1_500: "dubu da ɗari biyar",
        12_500: "dubu goma sha biyu da ɗari biyar",
        75_000: "dubu saba'in da biyar",
        125_000: "dubu ɗari da ashirin da biyar",
        1_350_000: "miliyan ɗaya da dubu ɗari uku da hamsin",
    },
    "ig": {
        15: "iri na ise",
        12_500: "puku iri na abụọ na narị ise",
        75_000: "puku iri asaa na ise",
        125_000: "puku narị na iri abụọ na ise",
        1_350_000: "otu nde na puku narị atọ na iri ise",
    },
    "yo": {
        15: "márùndínlógún",
        21: "mọ́kànlélógún",
        45: "márùndínláàádọ́ta",
        12_500: "ẹgbẹ̀rún méjìlá àti ẹ̀ẹ́dẹ́gbẹ̀ta",
        30_000: "ẹgbẹ̀rún lọ́nà ọgbọ̀n",
        42_000: "ẹgbẹ̀rún lọ́nà méjìlélógójì",
        75_000: "ẹgbẹ̀rún lọ́nà márùndínlọ́gọ́rin",
        125_000: "ẹgbẹ̀rún lọ́nà ọgọ́rùn-ún ó lé márùndínlọ́gbọ̀n",
        100_025: "ẹgbẹ̀rún lọ́nà ọgọ́rùn-ún àti márùndínlọ́gbọ̀n",
        1_350_000: "mílíọ̀nù kan àti ẹgbẹ̀rún lọ́nà ọ̀ọ́dúnrún ó lé àádọ́ta",
    },
}


@pytest.mark.parametrize(("lang", "n", "words"), [(lang, n, w) for lang, cases in CASES.items() for n, w in cases.items()])
def test_say_number(lang, n, words):
    assert say_number(n, lang) == words


def test_naira_order():
    assert say_naira(5000, "en") == "five thousand naira"
    assert say_naira(5000, "yo") == "náírà ẹgbẹ̀rún márùn-ún"
    assert say_naira(5000, "ha") == "naira dubu biyar"


def test_out_of_range_is_left_alone():
    assert say_number(8031234567, "en") is None  # a phone number


# Amounts we speak are amounts we can also hear.
@pytest.mark.parametrize("n", [1_500, 2_500, 9_000, 12_500, 42_000, 75_000, 125_000, 150_000, 1_350_000])
@pytest.mark.parametrize("lang", ["en", "ha", "ig", "yo"])
def test_round_trip_through_the_amount_parser(lang, n):
    assert extract_amount_ngn(say_naira(n, lang)) == n


def test_every_yoruba_amount_round_trips():
    # every form: additive and subtractive tens, "ó lé" inside a group, "àti" between groups
    for n in [*range(1, 1000), *range(1000, 1_000_000, 977), 2_005, 100_025, 999_999, 1_350_000, 25_000_000]:
        assert extract_amount_ngn(say_naira(n, "yo")) == n, (n, say_naira(n, "yo"))
