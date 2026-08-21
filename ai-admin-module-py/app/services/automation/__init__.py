"""
Automation Module — test execution runtime.

--- Automation Module: new package -------------------------------------------

Ported from the Test Automation Studio in the sibling stlc-platform repository,
which this project owns. The port is deliberate rather than a rewrite: these
files carry months of upstream bug fixes that are expensive to rediscover — a
page object's own name compiling into the URL it opened, browsers installed
somewhere only root could reach, a globally installed Playwright that a
generated spec cannot import.

Adapted in three ways, and only three:

  * Settings come from `app.config.settings` (pydantic-settings over .env)
    rather than the upstream `get_settings()` accessor.
  * Storage is rooted at AUTOMATION_STORAGE_PATH rather than a general
    file_storage_path.
  * The pytest runner is omitted. This deployment generates Playwright only;
    adding pytest later means porting one more file, not reshaping these.

Everything else — the runner contract, cancellation semantics, the JSON
reporter parsing, attachment lifting and the environment allowlist — is kept
faithful so upstream fixes remain mergeable by inspection.
"""
