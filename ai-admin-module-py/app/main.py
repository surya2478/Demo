from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio
import re
from .database.init_db import init_db
from .database.connection import get_db
from .database.sessions import purge_expired_sessions
from .config import settings  # changed from `from config import settings`


# --- Automation Module: refuse to start on unusable configuration ------------

def _masked_database_url() -> str:
    """The database URL with any embedded password removed."""
    return re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", settings.DATABASE_URL or "")


def _verify_runtime_configuration() -> None:
    """Stop the process rather than serve a configuration that cannot work.

    Both checks guard failure modes that are otherwise completely silent:

      * An empty SECRET_KEY raises nowhere. It signs tokens that never
        validate, so every login fails and nothing in the logs says why.
      * A CORS list without the real frontend origin leaves the backend
        looking healthy in its own logs while the browser refuses every call.

    This matters most in a container. The image deliberately carries no .env
    (see .dockerignore), so the whole configuration arrives through the
    `env_file:` entry on the backend service in docker-compose.yml. Before this
    guard, a missing or wrong env_file still produced a process that started,
    answered /docs, and was broken for every real user.

    Called at import time, ahead of init_db(), so a bad config never gets as
    far as touching the database.
    """
    if not (settings.SECRET_KEY or "").strip():
        raise RuntimeError(
            "SECRET_KEY is empty. Every token this process issued would be "
            "unusable and every login would fail. Set it in the backend's .env "
            "(ai-admin-module-py/.env); in Docker that file reaches the "
            "container through the `env_file:` entry on the backend service in "
            "docker-compose.yml, so check it is present and readable. Generate "
            'one with: python -c "import secrets; print(secrets.token_urlsafe(32))"'
        )

    origins = settings.cors_allow_origins
    if not origins:
        raise RuntimeError(
            "CORS_ALLOW_ORIGINS resolved to an empty list, so no browser origin "
            "can call this API. Set it in the backend's .env as a "
            "comma-separated list of origins."
        )

    # Printed once, deliberately. Which origins are live is the single easiest
    # thing to get wrong when moving between local and a deployment, and it is
    # invisible from outside until a browser silently refuses a request.
    print(f"[Config] APP_ENV={settings.APP_ENV}  CORS origins: {', '.join(origins)}")
    print(f"[Config] Database: {_masked_database_url()}")
    print(
        "[Config] LDAP: "
        + ("configured" if settings.LDAP_SERVER_URL else "not configured (local auth only)")
        + f"  |  Automation: {'enabled' if settings.AUTOMATION_ENABLED else 'disabled'}"
        + f"  |  LLM provider: {settings.LLM_PROVIDER}"
    )


_verify_runtime_configuration()

# app = FastAPI()
app = FastAPI(title="AI- Testing Assistant Admin",root_path="/admin")

# Initialize database before adding routes
init_db()

# means to run periodic cleanup of expired sessions in background task every 2 minutes
# - If purge runs every 1 min, that’s fine 
# - Best Practice
# - Keep purge frequency short (1 min is fine). It ensures expired sessions are cleaned quickly.
# - Do not extend purge interval — keep it at 1 min.
async def _session_cleanup_loop(interval_seconds: int = 1 * 60):
    """Background loop to purge expired sessions periodically."""
    while True:
        try:
            db_gen = get_db()
            db = next(db_gen)
            try:
                purged = purge_expired_sessions(db)
                if purged:
                    print(f"Purged {purged} expired sessions")
            finally:
                # close session generator properly
                try:
                    db.close()
                except Exception:
                    pass
                try:
                    next(db_gen)
                except StopIteration:
                    pass
        except Exception as e:
            print(f"Error purging expired sessions: {e}")
        await asyncio.sleep(interval_seconds)

@app.on_event("startup")
async def start_background_tasks():
    # --- Read the live AI configuration into memory --------------------------
    # config.json is written by the Settings screen and read back by the
    # frontend, but until this call nothing loaded it into settings.ai_config
    # -- GET /settings/ai-config returned the file to the browser without
    # publishing it. Anything server-side that resolves ai_config therefore
    # used the defaults in config.py instead of the deployed configuration.
    #
    # services/automation/llm.py is the caller that makes this matter: with
    # LLM_PROVIDER=ai_service it posts to ai_config.BASE_URL +
    # ENDPOINTS.chatStream, so a stale copy silently sends the Automation
    # module's prompts somewhere other than the AI service the Settings screen
    # names.
    try:
        from .routers.settings import load_ai_config_from_disk

        load_ai_config_from_disk()
    except Exception as exc:  # noqa: BLE001 - never block startup on this
        print(f"[Settings] ai_config load skipped: {exc}")

    # schedule cleanup loop (runs in background)
    asyncio.create_task(_session_cleanup_loop())

    # --- Automation Module: reclaim runs abandoned by a restart ---------------
    # Runs execute as asyncio tasks in this process, so a restart orphans any
    # that were in flight. Without this sweep they stay at "running" forever and
    # the UI polls them indefinitely; marking them blocked tells the truth and
    # lets the operator retrigger. Runs in a thread because it is synchronous
    # SQLite work and must not block the event loop during startup.
    try:
        from .services.automation.job_manager import job_manager, sweep_orphaned_runs

        # The endpoints that start runs are synchronous, so FastAPI runs them in
        # a threadpool where there is no event loop and asyncio.create_task()
        # raises. Handing the job manager a reference to this loop lets it
        # schedule work from either context.
        job_manager.bind_loop(asyncio.get_running_loop())

        reclaimed = await asyncio.to_thread(sweep_orphaned_runs)
        if reclaimed:
            print(f"[Automation] Marked {reclaimed} run(s) abandoned by a restart")
    except Exception as exc:  # noqa: BLE001 - never block startup on this
        print(f"[Automation] Startup hook skipped: {exc}")

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import routers
from .routers import audit, auth, dashboard, users, settings as settings_router, session as session_router, request_tracker, oslc_rqm_rtc, solutions_proxy, test_case_reviews, automation, generate

# Include routers
app.include_router(auth.router, prefix="/auth", tags=["Authentication"])
app.include_router(users.router, prefix="/user", tags=["Users"])
app.include_router(audit.router, prefix="/audit", tags=["Audit"])
app.include_router(session_router.router, prefix="/session", tags=["Sessions"])
app.include_router(settings_router.router, prefix="/settings", tags=["Settings"])
app.include_router(dashboard.router, prefix="/dashboard", tags=["Dashboard"])
# --- Automation Module: removed a shadowed router registration ---------------
# routers/config.py declares GET and PUT on "/settings/ai-config" -- the exact
# paths settings_router already serves via its "/settings" prefix on the line
# above. FastAPI matches in registration order, so settings_router won every
# request and the config.py handlers were unreachable.
#
# That mattered beyond tidiness: the two implementations disagree. settings.py
# persists to app/config.json, config.py only mutates the in-memory object, and
# config.py additionally requires admin on GET where settings.py allows any
# authenticated user. Anyone reading config.py would reasonably conclude the AI
# config is not persisted and admin-gated -- both false at runtime.
#
# The file is left in place; only the dead registration is removed. Verified
# before removal: four handlers were registered on that path, both GET and PUT
# resolving to app.routers.settings.
app.include_router(request_tracker.router, prefix="/request-tracker", tags=["Request Tracker"])
app.include_router(oslc_rqm_rtc.router, prefix="/oslc-rqm-rtc", tags=["OSLC RQM/RTC"])
app.include_router(solutions_proxy.router, tags=["Solutions Proxy"])
app.include_router(test_case_reviews.router, prefix="/test-case-reviews", tags=["Test Case Reviews"])
# --- Automation Module: the module's single mount point -----------------------
app.include_router(automation.router, prefix="/automation", tags=["Automation Studio"])
# --- Generation: the paths the external AI service used to serve --------------
# The prefix reproduces ai_config.ENDPOINTS, which are all rooted at /generate.
# Set ai_config.BASE_URL to this backend and the Test Assistant tabs land here
# instead of on the external service.
app.include_router(generate.router, prefix="/generate", tags=["Generation"])
app.include_router(generate.router, tags=["Generation & Chat"])