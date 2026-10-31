"""Quantity parsing. Units are kept exactly as published and never converted.

Decisions:
  * Blank / unreadable -> ``value=None`` (never 0, never invented). A literal "0" stays 0.0.
  * Lump sum / lot ("LS", "lot", "lump sum") is not a quantity: ``value=None`` and the unit is kept
    as published.
  * Ranges ("10-20") and negatives -> ``value=None`` with the original text kept.
  * ``1.000`` (single dot, three digits) is ambiguous (1 or 1000) and is not guessed.
  * "Twelve (12) Nos": the digits in brackets win; if only words are given, simple number words
    (up to hundreds) are read.
"""

from __future__ import annotations

import re
from typing import Any

_WORDS = {
    w: i
    for i, w in enumerate(
        [
            "zero",
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "thirteen",
            "fourteen",
            "fifteen",
            "sixteen",
            "seventeen",
            "eighteen",
            "nineteen",
            "twenty",
        ]
    )
}
_WORDS.update(
    {"thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
)
_LUMP = re.compile(r"^(?:l\.?\s?s\.?|lot|lots|lump\s*-?\s*sum|lumpsum|job|item)$", re.IGNORECASE)
_PREFIX = re.compile(
    r"^\s*(?:qty|quantity|quantities|qnty|q'ty|no\.?\s+of\s+units)\s*[:.\-=]?\s*", re.IGNORECASE
)


def _result(value: float | None, original: str | None, unit: str | None) -> dict[str, Any]:
    return {"value": value, "originalText": original, "unit": unit}


def _words_to_int(s: str) -> int | None:
    toks = [t for t in re.split(r"[\s\-]+", s.lower().strip()) if t and t != "and"]
    if not toks:
        return None
    total = 0
    for t in toks:
        if t in _WORDS:
            total += _WORDS[t]
        elif t == "hundred":
            total = max(total, 1) * 100
        else:
            return None
    return total


def _num(tok: str) -> float | None:
    tok = tok.strip(",.")
    if re.fullmatch(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?", tok):
        return float(tok.replace(",", ""))
    if re.fullmatch(r"\d+(?:\.\d+)?", tok):
        if re.fullmatch(r"\d{1,3}\.\d{3}", tok):
            return None  # 1.000 ambiguous
        return float(tok)
    return None


def parse_quantity(text: str | None) -> dict[str, Any]:
    """Parse "12 pcs", "Twelve (12) Nos", "1,000 pairs", "LS" ... Never raises, never invents."""
    if not isinstance(text, str):
        return _result(None, None, None)
    original = text.strip() or None
    if original is None:
        return _result(None, None, None)
    try:
        s = _PREFIX.sub("", original).strip()
        s = re.sub(r"\s+", " ", s)
        if not s:
            return _result(None, original, None)
        if _LUMP.match(s):
            return _result(None, original, s)
        # range: 10-20, 10 to 20
        if re.search(r"\d\s*(?:-|–|to)\s*\d", s) and not re.match(r"^\d{1,3}(?:,\d{3})+\b", s):
            return _result(None, original, None)
        if re.match(r"^\s*[-−]\s*\d", s):
            return _result(None, original, None)
        paren = re.match(
            r"^(?P<words>[A-Za-z][A-Za-z \-]*?)\s*\(\s*(?P<n>[\d,.]+)\s*\)\s*(?P<unit>.*)$", s
        )
        if paren:
            n = _num(paren["n"])
            words = _words_to_int(paren["words"])
            if n is not None and (words is None or words == n):
                return _result(n, original, _clean_unit(paren["unit"]))
            return _result(None, original, None)
        m = re.match(r"^(?P<n>\d[\d,.]*)\s*(?P<unit>.*)$", s)
        if m:
            n = _num(m["n"])
            if n is None:
                return _result(None, original, None)
            unit = _clean_unit(m["unit"])
            if unit and _LUMP.match(unit) and unit.lower() in {"ls", "l.s", "lump sum"}:
                return _result(None, original, unit)
            return _result(n, original, unit)
        wm = re.match(r"^(?P<w>(?:[A-Za-z]+(?:[\s\-]+(?:and\s+)?)?)+?)\s*(?P<unit>[A-Za-z.]*)$", s)
        if wm:
            # words only, e.g. "twelve" or "twelve pcs"
            toks = s.split()
            for k in range(len(toks), 0, -1):
                n_words = _words_to_int(" ".join(toks[:k]))
                if n_words is not None:
                    return _result(float(n_words), original, _clean_unit(" ".join(toks[k:])))
        if re.fullmatch(r"[A-Za-z][A-Za-z. ]{0,20}", s):
            return _result(None, original, s)  # bare unit, no number
        return _result(None, original, None)
    except Exception:  # noqa: BLE001
        return _result(None, original, None)


def _clean_unit(unit: str) -> str | None:
    unit = unit.strip(" .,;:()-")
    if not unit or unit.lower() == "x":  # "3 x" is a multiplication sign, not a unit
        return None
    return unit
