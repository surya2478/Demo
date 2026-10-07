"""Persistent registry of Squad Knowledge Base names."""
from __future__ import annotations

import json
import re
from pathlib import Path
from threading import RLock

DEFAULT_SQUADS = ["Device Squad", "Smiles"]
SYSTEM_NAMES = {"b2b", "bcrm", "smb"}
_SQUADS_PATH = Path(__file__).resolve().parents[2] / "squad_knowledge_bases.json"
_SQUADS_LOCK = RLock()
_VALID_NAME = re.compile(r"^[\w][\w .&'()-]{0,79}$", re.UNICODE)


def _write(names: list[str]) -> None:
    temporary = _SQUADS_PATH.with_suffix(".json.tmp")
    temporary.write_text(json.dumps({"squads": names}, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(_SQUADS_PATH)


def list_squads() -> list[str]:
    """Read the persisted list, creating it from defaults on first access."""
    with _SQUADS_LOCK:
        if not _SQUADS_PATH.exists():
            _write(DEFAULT_SQUADS.copy())
        try:
            payload = json.loads(_SQUADS_PATH.read_text(encoding="utf-8"))
            names = payload.get("squads", []) if isinstance(payload, dict) else []
            if not isinstance(names, list):
                raise ValueError("The squads field must be a list.")
            result: list[str] = []
            seen: set[str] = set()
            for raw in names:
                name = normalize_squad_name(str(raw), names=[str(v) for v in names])
                key = name.casefold()
                if name and key not in seen and key not in SYSTEM_NAMES:
                    result.append(name)
                    seen.add(key)
            if result:
                return result
        except (OSError, ValueError, TypeError):
            pass

        _write(DEFAULT_SQUADS.copy())
        return DEFAULT_SQUADS.copy()


def normalize_squad_name(value: str, *, names: list[str] | None = None) -> str:
    """Return a canonical registered name, or empty when it is not registered."""
    normalized = " ".join((value or "").split())
    available = names if names is not None else list_squads()
    return next((name for name in available if name.casefold() == normalized.casefold()), "")


def add_squad(value: str) -> list[str]:
    """Add a unique, bounded squad name and return the updated list."""
    name = " ".join((value or "").split())
    if not _VALID_NAME.fullmatch(name):
        raise ValueError("Use 1-80 letters or numbers; spaces and . & ' ( ) - are also allowed.")
    if name.casefold() in SYSTEM_NAMES:
        raise ValueError(f"'{name}' is a Device Squad system, not a squad name.")

    with _SQUADS_LOCK:
        names = list_squads()
        if any(existing.casefold() == name.casefold() for existing in names):
            raise ValueError(f"The squad '{name}' already exists.")
        names.append(name)
        _write(names)
        return names