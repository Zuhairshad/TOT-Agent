"""Relevance: PPE vs riding gear separation, context, exclusions, word boundaries, explanations."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest

from tender_sources.relevance import derive_categories, score_record

sys.path.insert(0, str(Path(__file__).parent / "fixtures"))
from records_helper import default_config, make_record, validate_record

CFG = default_config()


def score(
    title: str, description: str | None = None, items: list[str] | None = None
) -> dict[str, Any]:
    return score_record(title=title, description=description, item_texts=items or [], config=CFG)


def terms(rel: dict[str, Any]) -> set[tuple[str, str]]:
    return {(m["term"], m["group"]) for m in rel["matches"]}


def test_title_match_scores_and_validates_against_schema() -> None:
    rel = score("Supply of 50 motorcycles")
    assert rel["groups"] == ["motorbikes"]
    assert 0.5 <= rel["score"] <= 1.0
    assert rel["matches"][0]["field"] == "title"
    assert "motorcycles" in rel["matches"][0]["context"]
    validate_record(make_record(relevance=rel, categories=derive_categories(rel)))


def test_no_match_scores_zero_with_honest_explanation() -> None:
    rel = score("Construction of a bridge", "Concrete works")
    assert rel["score"] == 0 and rel["groups"] == [] and rel["matches"] == []
    assert rel["explanation"] == "No keyword group matched."
    assert derive_categories(rel) == []


def test_title_weighs_more_than_description_which_weighs_more_than_items() -> None:
    t = score("Supply of motorcycles")["score"]
    d = score("Supply of vehicles", "motorcycles required")["score"]
    i = score("Supply of vehicles", None, ["motorcycles x 10"])["score"]
    assert t > d > i > 0


def test_corroboration_raises_the_score_but_never_above_one() -> None:
    one = score("Supply of motorcycles")["score"]
    many = score("Supply of motorcycles and scooters", "electric motorcycle", ["scooter"])["score"]
    assert one < many <= 1.0


# ---------------------------------------------------------------- word boundaries


@pytest.mark.parametrize(
    "title", ["Goods shipped to Lusaka", "Skippe supplies", "Mapped properties", "Sloppeyard"]
)
def test_ppe_does_not_match_inside_other_words(title: str) -> None:
    assert score(title)["score"] == 0


def test_ppe_matches_as_a_whole_word_case_insensitively() -> None:
    for title in ("Supply of PPE", "supply of ppe kits", "Supply of (PPE)", "PPE-kits"):
        assert ("ppe", "ppe") in terms(score(title)), title


@pytest.mark.parametrize(
    "word", ["scooter", "scooters", "Scooters", "motorbike", "motorbikes", "MOTORCYCLES"]
)
def test_simple_plurals_and_case_match(word: str) -> None:
    assert score(f"Supply of {word}")["groups"] == ["motorbikes"]


@pytest.mark.parametrize(
    "variant", ["motor cycle", "motor-cycle", "Motor Cycles", "motor bike", "motor-bikes"]
)
def test_motorcycle_spelling_variants(variant: str) -> None:
    assert score(f"Purchase of {variant}")["groups"] == ["motorbikes"], variant


def test_term_embedded_in_a_longer_word_does_not_match() -> None:
    assert score("Scooterize programme")["score"] == 0
    assert score("Motorcyclemania")["score"] == 0


def test_generic_words_alone_do_not_match() -> None:
    for title in (
        "Protective coating for walls",
        "Riding school",
        "Safety audit",
        "Equipment hire",
        "Boots and shoes",
    ):
        assert score(title)["score"] == 0, title


# ---------------------------------------------------------------- PPE vs riding gear


def test_safety_helmet_is_ppe_not_riding_gear() -> None:
    rel = score("Supply of safety helmets")
    assert rel["groups"] == ["ppe"]
    assert derive_categories(rel) == ["ppe"]


def test_motorcycle_helmet_is_riding_gear_and_not_also_motorbikes() -> None:
    rel = score("Supply of motorcycle helmets")
    assert rel["groups"] == ["riding_gear"]
    assert derive_categories(rel) == ["riding_gear"]


def test_crash_helmet_is_riding_gear() -> None:
    assert score("Crash helmets")["groups"] == ["riding_gear"]


@pytest.mark.parametrize(
    "title",
    [
        "Helmets for motorcycle riders",
        "Helmets for riders of the project",
        "Supply of helmet for boda boda motorbike taxi",
        "Helmets (for use with scooters)",
    ],
)
def test_bare_helmet_with_riding_context_is_riding_gear(title: str) -> None:
    assert score(title)["matches"][0]["group"] in {"riding_gear", "motorbikes"}
    assert "riding_gear" in score(title)["groups"]
    assert "ppe" not in score(title)["groups"]


def test_bare_helmet_without_riding_context_is_ppe() -> None:
    rel = score("Supply of helmets", "For construction workers on site")
    assert rel["groups"] == ["ppe"]


def test_helmet_context_is_local_not_document_wide() -> None:
    # The motorcycle mention is far away and in another sentence: the helmet stays broad PPE.
    desc = (
        "Hard hats and helmets for the site crew. "
        + ("Lorem ipsum dolor sit amet. " * 8)
        + "Separately: a motorcycle for the manager."
    )
    rel = score("Site supplies", desc)
    groups = {m["term"]: m["group"] for m in rel["matches"]}
    assert groups["helmet"] == "ppe"
    assert groups["motorcycle"] == "motorbikes"


def test_broad_ppe_and_riding_gear_never_collapse_into_one_group() -> None:
    rel = score("Motorcycle riding gloves", "Also protective gloves and coveralls for staff")
    assert {"riding_gear", "ppe"} <= set(rel["groups"])
    assert ("riding gloves", "riding_gear") in terms(rel) and ("protective gloves", "ppe") in terms(
        rel
    )
    assert derive_categories(rel) == ["riding_gear", "ppe"]


def test_ppe_terms_alone_do_not_trigger_riding_gear() -> None:
    rel = score("PPE: reflective vests, safety boots and coveralls")
    assert rel["groups"] == ["ppe"]


# ---------------------------------------------------------------- context


def test_match_context_is_about_80_chars_each_side() -> None:
    pad = "x" * 200
    rel = score_record(title="t", description=f"{pad} motorcycle {pad}", item_texts=[], config=CFG)
    ctx = rel["matches"][0]["context"]
    assert "motorcycle" in ctx
    assert len(ctx) <= 80 + len("motorcycle") + 80
    assert ctx.startswith("x") and ctx.endswith("x")


def test_item_text_matches_are_labelled_item_and_weigh_less() -> None:
    rel = score("Supply of goods", None, ["Reflective vest, orange - 40 pcs"])
    assert rel["matches"][0]["field"] == "item"
    assert rel["score"] == pytest.approx(0.2)


def test_require_context_rule_from_config() -> None:
    cfg = {
        "groups": [
            {"id": "ppe", "label": "PPE", "terms": ["gloves"], "requireContext": ["protective"]}
        ],
        "exclusions": [],
    }
    yes = score_record(title="Protective gloves", description=None, item_texts=[], config=cfg)
    no = score_record(title="Winter gloves for choir", description=None, item_texts=[], config=cfg)
    assert yes["groups"] == ["ppe"] and no["score"] == 0


# ---------------------------------------------------------------- exclusions


def test_motorcycle_insurance_is_excluded_with_a_reason() -> None:
    rel = score("Motorcycle insurance for the fleet")
    assert rel["score"] == 0 and rel["groups"] == []
    assert [e["term"] for e in rel["excluded"]] == ["insurance"]
    assert "motorcycle" in rel["excluded"][0]["reason"]
    assert "insurance" in rel["explanation"]
    assert derive_categories(rel) == []


def test_exclusion_elsewhere_only_demotes_and_says_so() -> None:
    base = score("Supply of motorcycles")["score"]
    rel = score(
        "Supply of motorcycles",
        "Bidders need not provide " + "x " * 60 + "insurance certificates later.",
    )
    assert 0 < rel["score"] < base
    assert rel["groups"] == ["motorbikes"]
    assert rel["excluded"] and rel["excluded"][0]["term"] == "insurance"
    assert "Demoted" in rel["explanation"]


def test_exclusion_hit_never_silently_zeroes_a_title_match() -> None:
    rel = score("Supply of 20 motorcycles", "Software training is not included in this contract")
    assert rel["score"] > 0.3
    assert rel["excluded"], "demotion must be listed"
    assert all(e["reason"] for e in rel["excluded"])


def test_exclusion_only_neutralises_the_match_next_to_it() -> None:
    rel = score("Motorcycle insurance and supply of scooters", None)
    assert rel["groups"] == ["motorbikes"]
    assert ("scooter", "motorbikes") in terms(rel) and ("motorcycle", "motorbikes") not in terms(
        rel
    )
    assert rel["excluded"]


def test_exclusion_respects_word_boundaries() -> None:
    assert score("Supply of motorcycles", "reinsurancex and softwarexyz")["excluded"] == []


# ---------------------------------------------------------------- explanation


def test_explanation_sentence_format() -> None:
    rel = score("Supply of motorcycles", "Includes reflective vest for riders")
    assert (
        rel["explanation"]
        == 'Title mentions "motorcycle" (motorbikes); description mentions "reflective vest" (ppe).'
    )


def test_explanation_for_items() -> None:
    rel = score("Stores supplies", None, ["Coveralls, blue"])
    assert rel["explanation"] == 'Item lines mention "coverall" (ppe).'


def test_scoring_is_deterministic_and_groups_follow_config_order() -> None:
    a = score("PPE and motorcycle", "motorcycle helmet")
    b = score("PPE and motorcycle", "motorcycle helmet")
    assert a == b
    assert a["groups"] == ["motorbikes", "riding_gear", "ppe"]


def test_each_term_field_pair_is_reported_once() -> None:
    rel = score("motorcycle motorcycle motorcycle")
    assert len(rel["matches"]) == 1


# ---------------------------------------------------------------- derive_categories


def test_derive_categories_filters_invalid_ids_and_orders_canonically() -> None:
    rel = {
        "score": 0.5,
        "groups": ["ppe", "bogus", "motorbikes"],
        "matches": [],
        "excluded": [],
        "explanation": "",
    }
    assert derive_categories(rel) == ["motorbikes", "ppe"]


@pytest.mark.parametrize("rel", [{"score": 0, "groups": ["ppe"]}, {}, {"score": 0.4}, None])
def test_derive_categories_empty_when_score_zero_or_malformed(rel: Any) -> None:
    assert derive_categories(rel) == []


def test_bad_config_never_raises() -> None:
    rel = score_record(title="Supply of motorcycles", description=None, item_texts=[], config={})
    assert rel["score"] == 0
    assert score_record(title=None, description=None, item_texts=[None], config=None)["score"] == 0  # type: ignore[arg-type,list-item]


def test_vehicle_word_modifying_a_gear_noun_is_not_a_motorbikes_match() -> None:
    rel = score("Motorcycle riding gloves and motorcycle jackets")
    assert "motorbikes" not in rel["groups"]
    assert "riding_gear" in rel["groups"]
    assert "motorbikes" in score("Motorcycles and riding gloves")["groups"]
