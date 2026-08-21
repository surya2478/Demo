from __future__ import annotations
from datetime import datetime, timezone
from pathlib import Path
import json
from typing import List, Dict, Any, Optional
from zoneinfo import ZoneInfo

DATA_FILE = Path(__file__).with_name("audit.json")

# use Dubai / Abu Dhabi timezone
DUBAI_TZ = ZoneInfo("Asia/Dubai")


def _to_iso(dt: datetime) -> str:
    """Return ISO string in Dubai timezone with offset."""
    if dt.tzinfo is None:
        # assume dt is in UTC if naive -> convert to Dubai
        dt = dt.replace(tzinfo=timezone.utc).astimezone(DUBAI_TZ)
    else:
        dt = dt.astimezone(DUBAI_TZ)
    return dt.isoformat()


def _from_iso(s: str) -> datetime:
    """
    Parse ISO timestamp and return datetime in Dubai timezone.
    Handles strings with Z (UTC), with offset, or naive datetimes.
    """
    if not s:
        return datetime.now(DUBAI_TZ)
    try:
        # handle trailing Z (UTC)
        if s.endswith("Z"):
            dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        else:
            dt = datetime.fromisoformat(s)
    except Exception:
        # fallback: try parsing without offset
        try:
            dt = datetime.fromisoformat(s)
        except Exception:
            return datetime.now(DUBAI_TZ)
    # if parsed datetime is naive, assume UTC then convert to Dubai
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(DUBAI_TZ)


def _load() -> List[Dict[str, Any]]:
    if not DATA_FILE.exists():
        return []
    raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    for e in raw:
        # migrate older entries without id
        if "id" not in e:
            e["id"] = None
        if "timestamp" in e and isinstance(e["timestamp"], str):
            try:
                e["timestamp"] = _from_iso(e["timestamp"])
            except Exception:
                e["timestamp"] = datetime.now(DUBAI_TZ)
    return raw


def _save(db: List[Dict[str, Any]]) -> None:
    dump = []
    for e in db:
        copy = dict(e)
        if isinstance(copy.get("timestamp"), datetime):
            copy["timestamp"] = _to_iso(copy["timestamp"])
        dump.append(copy)
    DATA_FILE.write_text(json.dumps(dump, indent=2, ensure_ascii=False), encoding="utf-8")


# in-memory list of audit entries (each entry is a dict)
DB_AUDIT: List[Dict[str, Any]] = _load()


# Expected fields / new columns for audit_logs
DEFAULT_FIELDS = {
    "id": None,
    "actor_id": None,
    "actor_username": None,
    "actor_role": None,       # "user" or "admin"
    "module": "Unknown",        # e.g. Dashboard, Users, Sessions, Settings, Test Assistant
    "submodule": None,         # e.g. Test Cases, Visual, Test Data, Changes, Unit, KB
    "action": "unknown",       # navigate, create, update, delete, extend, etc.
    "resource_type": None,
    "resource_id": None,
    "resource_name": None,
    "status": "success",       # success | failure | warning
    "details": None,           # JSON/dict
    "ip_address": None,
    "user_agent": None,
    "timestamp": None,         # datetime in memory (Dubai tz)
}


def _next_id() -> int:
    try:
        ids = [int(e.get("id")) for e in DB_AUDIT if e.get("id") is not None]
        return (max(ids) + 1) if ids else 1
    except Exception:
        return len(DB_AUDIT) + 1


def _ensure_details_serializable(details: Any) -> Optional[Dict[str, Any]]:
    if details is None:
        return None
    if isinstance(details, dict):
        return details
    # try to coerce simple types to dict
    try:
        return {"value": details}
    except Exception:
        return {"unserializable": str(details)}


def _normalize_entry(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Return normalized audit entry with default keys and proper timestamp."""
    entry: Dict[str, Any] = {}
    for k, v in DEFAULT_FIELDS.items():
        entry[k] = raw.get(k, v)

    # prefer some alternate keys for backward compatibility
    if not entry["actor_username"]:
        entry["actor_username"] = raw.get("actor") or raw.get("username") or raw.get("user")

    if not entry["actor_id"]:
        entry["actor_id"] = raw.get("actor_id") or raw.get("user_id")

    if not entry["module"]:
        entry["module"] = raw.get("module") or "Unknown"

    if not entry["action"]:
        entry["action"] = raw.get("action") or "unknown"

    entry["details"] = _ensure_details_serializable(raw.get("details", entry["details"]))

    # timestamp normalization
    ts = raw.get("timestamp", entry["timestamp"])
    if isinstance(ts, str):
        try:
            entry["timestamp"] = _from_iso(ts)
        except Exception:
            entry["timestamp"] = datetime.now(DUBAI_TZ)
    elif isinstance(ts, datetime):
        entry["timestamp"] = ts.astimezone(DUBAI_TZ) if ts.tzinfo else ts.replace(tzinfo=timezone.utc).astimezone(DUBAI_TZ)
    else:
        # if not provided, set now
        entry["timestamp"] = datetime.now(DUBAI_TZ)

    return entry


def append_audit(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Append an audit entry, normalize fields, assign id and persist to disk.

    Returns the normalized entry (with id and timestamp).
    """
    norm = _normalize_entry(entry)

    # assign id if missing
    if not norm.get("id"):
        norm["id"] = _next_id()

    # ensure created timestamp is datetime object in memory
    if not isinstance(norm["timestamp"], datetime):
        norm["timestamp"] = datetime.now(DUBAI_TZ)

    DB_AUDIT.append(norm)
    _save(DB_AUDIT)
    return norm


def get_all_audits() -> List[Dict[str, Any]]:
    """Return a shallow copy of in-memory audits."""
    print(f"[AUDIT] Returning all {len(DB_AUDIT)} audit entries")   
    return list(DB_AUDIT)


def find_by_actor(actor_username: str) -> List[Dict[str, Any]]:
    return [e for e in DB_AUDIT if e.get("actor_username") == actor_username]


def find_by_role(role: str) -> List[Dict[str, Any]]:
    return [e for e in DB_AUDIT if (e.get("actor_role") or "").lower() == (role or "").lower()]


def find_recent(limit: int = 100) -> List[Dict[str, Any]]:
    items = sorted(DB_AUDIT, key=lambda x: x.get("timestamp") or datetime.min, reverse=True)
    return items[:limit]


__all__ = ["DB_AUDIT", "append_audit", "get_all_audits", "find_by_actor", "find_by_role", "find_recent"]