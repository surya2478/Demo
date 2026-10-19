"""Expert Editor's bounded, persisted repair protocol.

Memory records observations and outcomes, not invented selectors or credentials.
The model can recommend a permitted operation; deterministic gates authorize it.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class RecoveryAdvice(BaseModel):
    action: Literal["retry_stage", "refresh_runtime", "recapture", "request_input", "repair_code"]
    reason: str = Field(min_length=5, max_length=600)

    @field_validator('reason', mode='before')
    @classmethod
    def bound_explanation(cls, value):
        # Explanation length must not invalidate an otherwise valid action.
        # Keep strict validation for action names and non-string payloads.
        return value[:600] if isinstance(value, str) else value


def classify(message: str) -> tuple[str, str]:
    text = message.lower()
    if any(x in text for x in ("rejected the configured", "invalid credential", "test data is incomplete", "missing username", "external sign-in", "sign-in success is unverified", "mfa", "captcha")):
        return "authentication_or_data", "request_input"
    if any(x in text for x in ("daily quota", "per day", "returned 401", "returned 403", "not configured")):
        return "provider_configuration", "request_input"
    if any(x in text for x in ("has no attribute", "typeerror", "keyerror", "nameerror")):
        return "software_contract", "repair_code"
    if any(x in text for x in ("browser runtime", "not installed", "chromium could not launch")):
        return "runtime", "refresh_runtime"
    if "omitted or duplicated step decisions" in text:
        return "model_contract", "retry_stage"
    if any(x in text for x in ("timed out", "timeout", "returned 429", "returned 50", "could not be reached", "queue is busy")):
        return "transient", "retry_stage"
    if any(x in text for x in ("no observed", "unverified", "missing controls", "could not identify controls", "held the proposed mapping", "held the repair")):
        return "missing_evidence", "recapture"
    return "needs_review", "request_input"


def _gap_key(message: str) -> str:
    """Separate a newly missing journey step from a previously exhausted one."""
    steps = set()
    for sentence in re.split(r"[.!?;]|\b(?:but|however)\b", message, flags=re.I):
        if re.search(r"\b(?:correctly|properly) mapped\b|\bas required\b", sentence, re.I):
            continue
        if not re.search(r"\b(?:missing|unresolved|unverified|lack|lacks|lacking|cannot|no|null)\b", sentence, re.I):
            continue
        for mention in re.finditer(r"\bsteps?\s+(\d+(?:\s*(?:,|and|-)\s*\d+)*)", sentence, re.I):
            values = [int(value) for value in re.findall(r"\d+", mention.group(1))]
            if "-" in mention.group(1) and len(values) == 2 and 0 < values[1] - values[0] <= 20:
                steps.update(range(values[0], values[1] + 1))
            else:
                steps.update(values)
    steps = sorted(steps)
    return "steps:" + ",".join(map(str, steps)) if steps else "unspecified"


def record_failure(check, stage: str, message: str) -> dict:
    state = dict(check.steps or {})
    setup = state.get("_agent_setup") or {}
    category, action = classify(message)
    scope = {key: setup.get(key) for key in ("app_key", "environment", "profile_id")}
    gap = _gap_key(message) if category == "missing_evidence" else "general"
    signature = hashlib.sha256(json.dumps([scope, getattr(check, "source_row", None), stage, category, gap], sort_keys=True, default=str).encode()).hexdigest()
    history = list(state.get("_recovery_history") or [])
    prior = [item for item in history if item.get("fingerprint") == signature or (
        # Previous records predate gap-specific fingerprints. Preserve their
        # consumed attempts without making a *different* missing step inherit them.
        item.get("stage") == stage and item.get("category") == category
        and item.get("scope") == scope and _gap_key(item.get("reason") or "") == gap
    )]
    recaptures_used = sum(item.get("status") == "retrying" and item.get("action") == "recapture"
                          for item in prior)
    total_recaptures = sum(item.get("status") == "retrying" and item.get("action") == "recapture"
                           for item in history)
    entry = {"fingerprint": signature, "scope": scope, "stage": stage, "category": category,
             "gap": gap, "action": action, "attempt": len(prior) + 1,
             "recaptures_used": recaptures_used, "total_recaptures": total_recaptures,
             "status": "proposed",
             "at": datetime.utcnow().isoformat(), "reason": message[:600]}
    history.append(entry)
    state["_recovery_history"] = history[-30:]
    state["_recovery_pending"] = entry
    check.steps = state
    return entry


def decide(entry: dict, *, should_stop=lambda: False) -> RecoveryAdvice:
    from . import agent_reviews, expert_editor
    return expert_editor.coordinate_recovery(entry, should_stop=should_stop)


def allowed(entry: dict, advice: RecoveryAdvice) -> bool:
    # A second identical full recrawl cannot invent absent browser controls;
    # allow one fresh capture, then return the specific evidence gap. Transient
    # model/runtime retries retain their separate two-cycle budget.
    within_budget = (int(entry.get("recaptures_used", entry["attempt"] - 1)) < 1
                     and int(entry.get("total_recaptures", 0)) < 3) if advice.action == "recapture" else entry["attempt"] <= 2
    return (within_budget and advice.action == entry["action"]
            and advice.action in {"retry_stage", "refresh_runtime", "recapture"}
            and entry["stage"] in {"requirements_guide", "navigation_guide", "automation", "analysis", "audit", "expert_editor"})
