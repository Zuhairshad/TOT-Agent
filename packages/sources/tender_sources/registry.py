"""Adapter registry: add a source = one file in adapters/ + one line here."""

from __future__ import annotations

from collections.abc import Callable

from tender_sources.adapters.base import SourceAdapter
from tender_sources.adapters.tendersontime import TendersOnTimeAdapter
from tender_sources.adapters.worldbank import WorldBankAdapter

_FACTORIES: dict[str, Callable[[], SourceAdapter]] = {
    "worldbank": WorldBankAdapter,
    "tendersontime": TendersOnTimeAdapter,
}


class UnknownSource(KeyError):
    pass


def adapter_ids() -> list[str]:
    return sorted(_FACTORIES)


def get_adapter(source_id: str) -> SourceAdapter:
    try:
        return _FACTORIES[source_id]()
    except KeyError:
        raise UnknownSource(
            f"unknown source {source_id!r}; known: {', '.join(adapter_ids())}"
        ) from None


def register(source_id: str, factory: Callable[[], SourceAdapter]) -> None:
    """Used by tests to plug in fake adapters."""
    _FACTORIES[source_id] = factory
