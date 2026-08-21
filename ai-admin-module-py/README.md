# Admin Module Backend (FastAPI)

## Features

- LDAP + JWT auth (mock LDAP, enable real via env)
- RBAC enforcement
- User management CRUD
- Dashboard stats
- Audit logs
- Settings management
- Session management
- Seeded sample users/roles
- Docker-ready

## Quick start (local)

1. python -m venv .venv && source .venv/bin/activate (Windows: .venv\Scripts\activate)
2. pip install -r requirements.txt
3. uvicorn app.main:app --reload

## Seed data

- Auto-seeded on startup:
  - Users: admin, qa_user, manager, tester
  - Default password: Passw0rd!
  - Roles: Admin, QA, Manager, Tester

## Auth

- POST /auth/login?username=admin&password=Passw0rd!
- Response: { access_token, token_type }
- Use the token in query param `token` for protected endpoints (simple demo). For production, use Authorization: Bearer.

## Sample endpoints

- GET /users/?token=... (view)
- POST /users/?token=... (create)
- PUT /users/{id}?token=... (update)
- DELETE /users/{id}?token=...
- GET /dashboard/stats?token=...
- GET /audit/?token=...
- GET /settings/?token=...
- PUT /settings/{key}?value=...&token=...
- GET /sessions/?token=...
- POST /sessions/invalidate/{token_id}?token=...

## Docker

- docker compose up --build
- Visit http://localhost:8003/docs

## LDAP

- Set LDAP_ENABLED=true to require LDAP. The mock accepts password "Passw0rd!".
- Replace services/ldap_service.py with real ldap3 integration for production.

## Notes

- This demo passes tokens via query param for simplicity; switch to Authorization header in production.
- SQLite used for dev; switch DATABASE_URL to PostgreSQL for prod.
