"""Keyword relevance scoring with context, exclusions and a human-readable explanation. Pure.

How it decides (kept deliberately simple and inspectable):
  * Matching is word-boundary, case-insensitive, allows simple plurals (``scooter``/``scooters``)
    and ``motor cycle`` / ``motor-cycle`` spellings. Only configured terms match, so generic words
    such as "protective" alone never do.
  * Longest match wins on overlapping spans, so ``motorcycle helmet`` is ONE riding_gear match and does
    not also count as a bare ``motorcycle`` motorbikes match; ``safety helmet`` is ppe.
  * A vehicle word directly modifying a gear noun ("motorcycle riding gloves") is not a motorbikes match.
  * A bare ``helmet`` is riding_gear if a motorcycle/rider/riding word is within 60 chars or in the
    same sentence, otherwise ppe (broad PPE stays separate from riding gear).
  * Weights: title 0.6, description 0.3, item/document text 0.2 per distinct (group, term, field);
    combined as ``1 - prod(1 - w)`` so repeated weak evidence never beats a title hit by itself.
  * An exclusion term within 60 chars (or the same sentence) of a match neutralises THAT match
    ("motorcycle insurance") and is listed with the reason; an exclusion elsewhere only scales the
    score by 0.7 (reason listed). Nothing is hidden: ``excluded`` always says why.
"""

from __future__ import annotations

import re
from typing import Any

W_FIELD = {"title": 0.6, "description": 0.3, "item": 0.2, "document": 0.2, "other": 0.2}
CATEGORY_ORDER = ("motorbikes", "riding_gear", "ppe")
_CONTEXT_WORDS = re.compile(
    r"(?<![A-Za-z0-9])(?:motor[\s\-]?cycles?|motor[\s\-]?bikes?|riders?|riding|scooters?|mopeds?|"
    r"two[\s\-]wheelers?)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_GEAR_FOLLOWS = re.compile(
    r"\s+(?:\w+\s+)?(?:helmets?|gloves?|jackets?|boots?|gear|apparel|clothing|suits?|trousers|vests?)\b",
    re.IGNORECASE,
)
_SENT_BREAK = re.compile(r"[.;!?\n|]")
_FIELD_LABEL = {
    "title": "Title mentions",
    "description": "description mentions",
    "item": "item lines mention",
    "document": "document text mentions",
    "other": "text mentions",
}


def _term_pattern(term: str, *, plural: bool = True) -> re.Pattern[str]:
    words = [w for w in re.split(r"[\s\-]+", term.strip().lower()) if w]
    parts: list[str] = []
    i = 0
    while i < len(words):
        w = words[i]
        if w == "motor" and i + 1 < len(words) and words[i + 1] in {"cycle", "bike"}:
            parts.append(f"motor[\\s\\-]?{words[i + 1]}")
            i += 2
            continue
        if w in {"motorcycle", "motorbike"}:
            parts.append(f"motor[\\s\\-]?{w[5:]}")
        else:
            parts.append(re.escape(w))
        i += 1
    body = r"[\s\-]+".join(parts)
    suffix = r"(?:s|es)?" if plural else ""
    return re.compile(rf"(?<![A-Za-z0-9]){body}{suffix}(?![A-Za-z0-9])", re.IGNORECASE)


def _ctx(text: str, start: int, end: int) -> str:
    return " ".join(text[max(0, start - 80) : end + 80].split())


def _sentence_bounds(text: str, pos: int) -> tuple[int, int]:
    before = [m.end() for m in _SENT_BREAK.finditer(text, 0, pos)]
    after = _SENT_BREAK.search(text, pos)
    return (before[-1] if before else 0, after.start() if after else len(text))


_LINK = re.compile(r"[.;!?\n,|]|\b(?:and|or|plus|with)\b", re.IGNORECASE)


def _near(text: str, a: tuple[int, int], b: tuple[int, int]) -> bool:
    """True if two spans are adjacent: <= 30 chars apart with no clause break or conjunction between."""
    lo, hi = min(a[1], b[1]), max(a[0], b[0])
    if hi < lo:  # overlapping
        return True
    return hi - lo <= 30 and not _LINK.search(text[lo:hi])


def _find_matches(field: str, text: str, groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cands: list[dict[str, Any]] = []
    gids = {g["id"] for g in groups}
    for g in groups:
        for term in g.get("terms", []):
            for m in _term_pattern(term).finditer(text):
                req = g.get("requireContext") or []
                if req:
                    window = text[max(0, m.start() - 80) : m.end() + 80]
                    if not any(_term_pattern(r).search(window) for r in req):
                        continue
                cands.append(
                    {
                        "term": term.lower(),
                        "group": g["id"],
                        "field": field,
                        "span": m.span(),
                        "text": text,
                    }
                )
    if {"riding_gear", "ppe"} <= gids:
        for m in _term_pattern("helmet").finditer(text):
            window = text[max(0, m.start() - 60) : m.end() + 60]
            s0, s1 = _sentence_bounds(text, m.start())
            riding = bool(_CONTEXT_WORDS.search(window) or _CONTEXT_WORDS.search(text[s0:s1]))
            cands.append(
                {
                    "term": "helmet",
                    "group": "riding_gear" if riding else "ppe",
                    "field": field,
                    "span": m.span(),
                    "text": text,
                }
            )
    # longest match wins on overlapping spans
    cands.sort(key=lambda c: c["span"][0] - c["span"][1])
    kept: list[dict[str, Any]] = []
    for c in cands:
        s, e = c["span"]
        if any(k["span"][0] <= s and e <= k["span"][1] for k in kept):
            continue
        kept.append(c)
    if "riding_gear" in gids:
        # "motorcycle riding gloves": the vehicle word is only a modifier of the gear noun
        kept = [
            k
            for k in kept
            if not (k["group"] == "motorbikes" and _GEAR_FOLLOWS.match(text, k["span"][1]))
        ]
    return sorted(kept, key=lambda c: c["span"][0])


def score_record(
    *, title: str, description: str | None, item_texts: list[str], config: dict[str, Any]
) -> dict[str, Any]:
    """Score one record against a SearchConfig dict. Never raises."""
    try:
        return _score(title or "", description, item_texts or [], config or {})
    except Exception:  # noqa: BLE001
        return {
            "score": 0.0,
            "groups": [],
            "matches": [],
            "excluded": [],
            "explanation": "Relevance could not be computed.",
        }


def _score(
    title: str, description: str | None, item_texts: list[str], config: dict[str, Any]
) -> dict[str, Any]:
    groups = list(config.get("groups", []))
    exclusions = [str(x) for x in config.get("exclusions", []) if str(x).strip()]
    texts: list[tuple[str, str]] = [("title", title)]
    if description:
        texts.append(("description", description))
    texts += [("item", t) for t in item_texts if t]

    counted: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []
    neutralised: list[tuple[str, str]] = []  # (match term, exclusion term)
    weak_hits: set[str] = set()
    all_ex_hits: list[tuple[str, str]] = []
    for field, text in texts:
        matches = _find_matches(field, text, groups)
        ex_hits: list[tuple[str, tuple[int, int]]] = []
        for ex in exclusions:
            for m in _term_pattern(ex).finditer(text):
                ex_hits.append((ex, m.span()))
        for mt in matches:
            killer = next((ex for ex, sp in ex_hits if _near(text, mt["span"], sp)), None)
            if killer:
                neutralised.append((mt["term"], killer))
                excluded.append(
                    {
                        "term": killer,
                        "reason": f'"{mt["term"]}" in {field} sits next to "{killer}" '
                        f"({_ctx(text, *mt['span'])!r}), so it is not counted.",
                    }
                )
            else:
                counted.append(mt)
        all_ex_hits.extend(
            (field, ex)
            for ex, sp in ex_hits
            if not any(_near(text, mt["span"], sp) for mt in matches)
        )

    if counted:
        for field, ex in all_ex_hits:
            weak_hits.add(ex)
            if not any(e["term"] == ex for e in excluded):
                excluded.append(
                    {"term": ex, "reason": f'"{ex}" appears in the {field}; score reduced (x0.7).'}
                )

    seen: set[tuple[str, str, str]] = set()
    rows: list[dict[str, Any]] = []
    for c in counted:
        key = (c["group"], c["term"], c["field"])
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            {
                "term": c["term"],
                "group": c["group"],
                "field": c["field"],
                "context": _ctx(c["text"], *c["span"]),
            }
        )
    prod = 1.0
    for r in rows:
        prod *= 1.0 - W_FIELD.get(r["field"], 0.2)
    score = 1.0 - prod
    if weak_hits:
        score *= 0.7
    score = round(max(0.0, min(1.0, score)), 2)
    present = {r["group"] for r in rows}
    group_ids = [g["id"] for g in groups if g["id"] in present]
    return {
        "score": score,
        "groups": group_ids,
        "matches": rows,
        "excluded": excluded,
        "explanation": _explain(rows, neutralised, weak_hits),
    }


def _explain(rows: list[dict[str, Any]], neutralised: list[tuple[str, str]], weak: set[str]) -> str:
    parts: list[str] = []
    for field in ("title", "description", "item", "document", "other"):
        by_group: dict[str, list[str]] = {}
        for r in rows:
            if r["field"] == field and r["term"] not in by_group.setdefault(r["group"], []):
                by_group[r["group"]].append(r["term"])
        if by_group:
            chunks = [
                ", ".join(f'"{t}"' for t in terms) + f" ({g})" for g, terms in by_group.items()
            ]
            parts.append(f"{_FIELD_LABEL[field]} {' and '.join(chunks)}")
    if not parts:
        if neutralised:
            m, ex = neutralised[0]
            return f'Matched "{m}" but it sits next to excluded term "{ex}", so it is not counted.'
        return "No keyword group matched."
    text = "; ".join(parts) + "."
    if text[0].islower():
        text = text[0].upper() + text[1:]
    if neutralised:
        m, ex = neutralised[0]
        text += f' "{m}" next to excluded "{ex}" was not counted.'
    if weak:
        text += " Demoted by exclusion " + ", ".join(f'"{w}"' for w in sorted(weak)) + "."
    return text


def derive_categories(relevance: dict[str, Any]) -> list[str]:
    """Category ids (motorbikes|riding_gear|ppe) from a Relevance dict; empty when score is 0."""
    if not isinstance(relevance, dict) or not relevance.get("score"):
        return []
    groups = set(relevance.get("groups") or [])
    return [c for c in CATEGORY_ORDER if c in groups]
