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

    # --- Say what this deployment will actually talk to -----------------------
    # Both of the day-long faults this exists to prevent were invisible until
    # somebody clicked Generate, and both then surfaced as an opaque 502:
    #
    #   * ai_config.BASE_URL still holding the placeholder, or a dev machine's
    #     127.0.0.1 copied in by a deploy that overwrote config.json.
    #   * The Knowledge Base not reaching the container, so generation ran
    #     ungrounded -- which produces plausible test cases and no error at all.
    #
    # Neither is visible from outside, and the Knowledge Base case is worse
    # than silent: knowledge_base.py logs its success at INFO and its failure
    # at WARNING, and nothing configures the root logger, so a WORKING KB
    # prints nothing and an absent one prints nothing a reader will see. These
    # lines print unconditionally, next to the CORS and database banners that
    # already earn their space for the same reason.
    try:
        from .services.generation.stream import _ai_service_url

        base = (settings.ai_config.BASE_URL or "").strip()
        if settings.LLM_PROVIDER == "ai_service":
            try:
                print(f"[AI] provider=ai_service  chat endpoint: {_ai_service_url()}")
            except Exception as exc:  # noqa: BLE001 - reporting must not fail startup
                print(f"[AI] provider=ai_service  chat endpoint UNRESOLVED: {exc}")
            if "example.com" in base:
                print(
                    "[AI] WARNING: BASE_URL is still the placeholder from "
                    "config.py, so no AI service is configured. Set it in "
                    "app/config.json or from the Settings screen."
                )
            elif "127.0.0.1" in base or "localhost" in base:
                print(
                    "[AI] WARNING: BASE_URL points at localhost. In a container "
                    "that is the container itself, and in the browser it is the "
                    "user's own machine -- a deploy that overwrote "
                    "app/config.json with a development copy looks exactly like "
                    "this."
                )
        else:
            print(f"[AI] provider={settings.LLM_PROVIDER}")
        if (settings.AUTOMATION_LLM_PROVIDER or "").strip():
            from .services.automation.llm import provider_status

            status = provider_status()
            print(f"[AI] Automation Studio (AI Refine, Review, Classify) provider={status['provider']}  {status['detail']}")
    except Exception as exc:  # noqa: BLE001 - never block startup on this
        print(f"[AI] Configuration report skipped: {exc}")

    try:
        from .services.automation import knowledge_base as _kb

        apps = _kb.list_applications()
        if apps:
            names = ", ".join(str(a.get("app_id")) for a in apps if a.get("app_id"))
            print(f"[Knowledge Base] {len(apps)} application(s) at {_kb.get_kb_root()}: {names}")
        else:
            print(
                f"[Knowledge Base] NONE FOUND at {_kb.get_kb_root()}. Generation "
                "will run WITHOUT flow grounding -- test cases will carry "
                "placeholder URLs and selectors instead of verified ones, and "
                "nothing else will report this."
            )
    except Exception as exc:  # noqa: BLE001 - never block startup on this
        print(f"[Knowledge Base] Report skipped: {exc}")

    # schedule cleanup loop (runs in background)
    asyncio.create_task(_session_cleanup_loop())

    # --- Automation Module: reclaim runs abandoned by a restart ---------------
    # Runs execute as asyncio tasks in this process. A restart interrupts the
    # active browser, while server runs that were still queued are safe to
    # restore from the database. Runs in a thread because this is synchronous
    # database work and must not block the event loop during startup.
    try:
        from .services.automation.job_manager import job_manager, sweep_orphaned_runs

        # The endpoints that start runs are synchronous, so FastAPI runs them in
        # a threadpool where there is no event loop and asyncio.create_task()
        # raises. Handing the job manager a reference to this loop lets it
        # schedule work from either context.
        job_manager.bind_loop(asyncio.get_running_loop())

        reclaimed, waiting = await asyncio.to_thread(sweep_orphaned_runs)
        for run_key in waiting:
            job_manager.enqueue(run_key)
        if reclaimed:
            print(f"[Automation] Marked {reclaimed} run(s) abandoned by a restart")
        if waiting:
            print(f"[Automation] Restored {len(waiting)} queued run(s)")
    except Exception as exc:  # noqa: BLE001 - never block startup on this
        print(f"[Automation] Startup hook skipped: {exc}")

class _ErrorsAsJson:
    """An unhandled error becomes a JSON 500 *inside* CORS.

    Starlette answers an unhandled exception from its outermost layer, outside
    CORSMiddleware, so the 500 carries no Access-Control-Allow-Origin and the
    browser reports "blocked by CORS policy" / "Network Error" -- hiding the
    real message. Caught here, the page shows what went wrong and the log has
    the traceback.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        started = False

        async def tracked(message):
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, tracked)
        except Exception as exc:  # noqa: BLE001
            import json as _json
            import logging as _log

            _log.getLogger("app.errors").exception("Unhandled error on %s %s", scope.get("method"), scope.get("path"))
            if started:
                raise
            body = _json.dumps({"detail": f"Server error: {exc.__class__.__name__}: {exc}"[:500]}).encode()
            await send({"type": "http.response.start", "status": 500,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})


# Added before CORS, so CORS wraps it and its 500s carry the CORS headers.
app.add_middleware(_ErrorsAsJson)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    # Collector endpoints use a short-lived crawl credential rather than a
    # user token.  Extension IDs differ per browser and installation, so their
    # schemes must be allowed by pattern rather than enumerated in deployment
    # configuration.
    allow_origin_regex=r"^(chrome-extension|moz-extension|safari-web-extension)://.+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import routers
from .routers import ado_api, audit, auth, dashboard, users, settings as settings_router, session as session_router, request_tracker, oslc_rqm_rtc, solutions_proxy, test_case_reviews, test_case_workflows, automation, generate, ai_checks, projects, test_data as test_data_router, knowledge_base_page

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
app.include_router(test_case_workflows.router, prefix="/test-case-workflows", tags=["Test Case Workflows"])
app.include_router(ai_checks.router, prefix="/test-assistant/ai-checks", tags=["AI Checks"])
app.include_router(projects.router, prefix="/projects", tags=["Projects"])
app.include_router(ado_api.router, prefix="/ado-api", tags=["ADO API"])
# --- Automation Module: the module's single mount point -----------------------
app.include_router(test_data_router.router, prefix="/automation/test-data", tags=["Automation Studio: Test data"])
app.include_router(knowledge_base_page.router, prefix="/automation/knowledge-base", tags=["Automation Studio: Knowledge Base"])
app.include_router(automation.router, prefix="/automation", tags=["Automation Studio"])
# --- AI R&D Lab: independent; a failure to load it never stops the app --------
try:
    from .routers import rnd_lab
    app.include_router(rnd_lab.router, prefix="/rnd-lab", tags=["AI R&D Lab"])
except Exception:  # noqa: BLE001
    import logging as _logging
    _logging.getLogger(__name__).exception("AI R&D Lab did not load; the rest of the app is unaffected.")
# --- Generation: the paths the external AI service used to serve --------------
# The prefix reproduces ai_config.ENDPOINTS, which are all rooted at /generate.
# Set ai_config.BASE_URL to this backend and the Test Assistant tabs land here
# instead of on the external service.
app.include_router(generate.router, prefix="/generate", tags=["Generation"])
app.include_router(generate.router, tags=["Generation & Chat"])
# --- Coverage Analysis: requirement documents vs an existing test case sheet ---
# Loaded like the R&D Lab: routers/coverage.py (and app/schemas/coverage.py) come
# from the team's tree, and the app must start without them.
try:
    from .routers import coverage
    app.include_router(coverage.router, prefix="/coverage", tags=["Coverage Analysis"])
except Exception:  # noqa: BLE001
    import logging as _logging
    _logging.getLogger(__name__).warning("Coverage Analysis did not load (routers/coverage.py or schemas/coverage.py missing); /coverage is unavailable.")
