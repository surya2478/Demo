from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import asyncio
from .database.init_db import init_db
from .database.connection import get_db
from .database.sessions import purge_expired_sessions
from .config import settings  # changed from `from config import settings`

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
    # schedule cleanup loop (runs in background)
    asyncio.create_task(_session_cleanup_loop())

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Import routers
from .routers import audit, auth, dashboard, users, settings as settings_router, session as session_router, request_tracker, oslc_rqm_rtc, solutions_proxy, test_case_reviews, automation

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