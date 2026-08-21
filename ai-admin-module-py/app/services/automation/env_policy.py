"""
What environment a generated test is allowed to see.

--- Automation Module: ported from stlc-platform -----------------------------
Source: app/services/automation_runner/env_policy.py

This is the most important file in the package for reasons that are not
obvious from its size.

Generated specs are LLM output — untrusted input that this deployment executes
as a subprocess of the backend. Without filtering, that subprocess inherits the
backend's entire environment: SECRET_KEY, DATABASE_URL,
LDAP_SERVICE_ACCOUNT_PASSWORD, the Solutions API token. A generated script that
reads `process.env` and prints it would exfiltrate all of it into a log the UI
happily renders.

Upstream ran this as an audit before enforcing, and the result is worth
recording: on a standard deployment 68 of 73 variables were withheld, and
nothing a test legitimately reads was among them.

There is a second, local benefit. The backend image sets HTTP_PROXY for the
corporate proxy, and Chromium would otherwise inherit it and try to proxy
traffic to internal SIT and QA hosts. HTTP_PROXY is not allowlisted, so the
filter removes it and test traffic reaches internal targets directly.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping

from ...config import settings

logger = logging.getLogger(__name__)


# Runtime essentials. Without these the Node launcher fails before a test runs,
# so they are not negotiable through configuration.
_ALWAYS_ALLOWED: frozenset[str] = frozenset(
    {
        # POSIX
        "PATH",
        "HOME",
        "LANG",
        "LC_ALL",
        "TZ",
        "SHELL",
        "USER",
        "LOGNAME",
        "TMPDIR",
        # Windows, for developer machines
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
        "USERPROFILE",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        # Interpreter behaviour the runner sets or depends on
        "PYTHONUNBUFFERED",
        "PYTHONIOENCODING",
        "CI",
    }
)


def _allowlist_entries() -> list[str]:
    raw = getattr(settings, "AUTOMATION_RUNNER_ENV_ALLOWLIST", "") or ""
    return [entry.strip().upper() for entry in raw.split(",") if entry.strip()]


def _matches(name: str, exact: set[str], prefixes: tuple[str, ...]) -> bool:
    return name in exact or (bool(prefixes) and name.startswith(prefixes))


def build_runner_env(
    *,
    source: Mapping[str, str],
    overrides: Mapping[str, str] | None = None,
    runner_name: str = "runner",
) -> tuple[dict[str, str], list[str]]:
    """Build the environment for a runner subprocess.

    Returns `(env, withheld)`. `withheld` names the variables the policy
    removed — record it in run metadata either way, so the audit trail shows
    what the script could reach.

    In audit mode (AUTOMATION_RUNNER_ENV_ALLOWLIST_ENFORCED=false) the
    variables stay in `env` but are still reported, letting a deployment see
    what enforcement would remove before turning it on.

    `overrides` are applied after filtering and always survive: the runner sets
    them itself rather than inheriting them.
    """
    configured = set(_allowlist_entries())
    prefixes = tuple(entry[:-1] for entry in configured if entry.endswith("*"))
    exact = {entry for entry in configured if not entry.endswith("*")} | set(_ALWAYS_ALLOWED)

    allowed: dict[str, str] = {}
    withheld: list[str] = []
    for key, value in source.items():
        if _matches(key.upper(), exact, prefixes):
            allowed[key] = value
        else:
            withheld.append(key)
    withheld.sort()

    enforced = bool(getattr(settings, "AUTOMATION_RUNNER_ENV_ALLOWLIST_ENFORCED", True))
    env = dict(allowed) if enforced else dict(source)
    if overrides:
        env.update(overrides)

    if withheld:
        logger.warning(
            "%s: %d environment variable(s) %s by the automation allowlist: %s",
            runner_name,
            len(withheld),
            "withheld" if enforced else "would be withheld (audit mode)",
            ", ".join(withheld),
        )

    return env, withheld
