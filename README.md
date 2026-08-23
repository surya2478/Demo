# AI Testing Assistant & Admin Platform (`ai-testing-app-new`)

An enterprise-grade, AI-powered test engineering, automation orchestration, and administrative management platform. The system streamlines test design, visual testing, synthetic test data generation, change impact analysis, automated test execution, and enterprise governance with Role-Based Access Control (RBAC) and Dual Authentication (LDAP / Local).

---

## 📑 Table of Contents

- [Project Scope & Capabilities](#project-scope--capabilities)
- [System Architecture](#system-architecture)
- [Module Breakdown](#module-breakdown)
  - [1. AI Test Assistant](#1-ai-test-assistant)
  - [2. Automation Studio](#2-automation-studio)
  - [3. Administration & Governance](#3-administration--governance)
  - [4. Enterprise Integrations (OSLC / IBM RQM / RTC)](#4-enterprise-integrations-oslc--ibm-rqm--rtc)
  - [5. Request Tracker & Token Analytics](#5-request-tracker--token-analytics)
- [Directory Structure](#directory-structure)
- [Authentication & Security](#authentication--security)
- [Getting Started & Local Setup](#getting-started--local-setup)
  - [Backend Setup (`ai-admin-module-py`)](#backend-setup-ai-admin-module-py)
  - [Frontend Setup (`ai-test-assistant-frontend`)](#frontend-setup-ai-test-assistant-frontend)
- [Docker Deployment](#docker-deployment)
- [Environment Configuration](#environment-configuration)

---

## 🎯 Project Scope & Capabilities

The **AI Testing Assistant** platform provides an end-to-end ecosystem for QA teams, automation engineers, managers, and administrators:

1. **Intelligent Test Engineering**: Accelerates test case creation, requirement parsing, unit test creation, visual testing, and synthetic test data generation using state-of-the-art LLMs.
2. **Automation Studio**: Tracks automation candidate backlog, schedules and triggers test automation runs, monitors execution states in real-time, and captures structured run logs.
3. **Manager Review & Approval**: Comprehensive review workflows for test artifacts before syncing with external Test Management systems.
4. **Enterprise Governance & Security**: Dual authentication (Active Directory / LDAP + Local SQLite/PostgreSQL fallback), fine-grained RBAC permissions, time-slot access windows, and active session monitoring with remote invalidation.
5. **Token Quota & Usage Analytics**: Monitors model tokens, tracks prompt/completion usage per user/department, and provides exportable analytics reports (CSV/JSON).

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Frontend (React + Vite + Tailwind)                   │
│                                                                        │
│  ┌────────────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │   Test Assistant   │  │ Automation Studio  │  │ Admin Dashboard  │  │
│  │ (Cases, Visual, KB,│  │(Candidates, Runs,  │  │ (Users, Sessions,│  │
│  │  Data, Unit, Diff) │  │    Run Details)    │  │  Audit, Quotas)  │  │
│  └─────────┬──────────┘  └─────────┬──────────┘  └────────┬─────────┘  │
└────────────┼───────────────────────┼──────────────────────┼────────────┘
             │                       │                      │
             ▼                       ▼                      ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        FastAPI Backend Engine                          │
│                                                                        │
│  ┌────────────────────┐  ┌────────────────────┐  ┌──────────────────┐  │
│  │ Auth & RBAC Guard  │  │  Automation Engine │  │ Request Tracker  │  │
│  │ (LDAP + Local DB)  │  │(Task Mgr, Sweeper) │  │ & Token Monitor  │  │
│  └─────────┬──────────┘  └─────────┬──────────┘  └────────┬─────────┘  │
│            │                       │                      │            │
│  ┌─────────┴──────────┐  ┌─────────┴──────────┐  ┌────────┴─────────┐  │
│  │ User & Time Slots  │  │ OSLC RQM/RTC Sync  │  │ Session Purger   │  │
│  └────────────────────┘  └────────────────────┘  └──────────────────┘  │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
             ┌───────────────────────┴───────────────────────┐
             ▼                                               ▼
┌───────────────────────────┐                   ┌────────────────────────┐
│   SQLite / PostgreSQL     │                   │ Enterprise LDAP / ALM  │
│ (Users, Sessions, Audits) │                   │  (AD & IBM RQM / RTC)  │
└───────────────────────────┘                   └────────────────────────┘
```

---

## 🧩 Module Breakdown

### 1. AI Test Assistant
- **Test Cases Generation**: AI-guided generation of manual and automated test scripts based on user stories and requirements.
- **Visual Testing**: Automated visual UI validation and layout difference inspection.
- **Data Generation (`DataTab`)**: Synthetic test data synthesizer with customizable formats (JSON, tabular, masked PII).
- **Impact & Change Analysis (`Changes`)**: Analyzes code/schema diffs to pinpoint impacted test scenarios and recommend regression suites.
- **Unit Testing (`Unit`)**: Automated generation of unit test suites with assertion coverage.
- **Knowledge Base (`KB`)**: Contextual repository grounding test generation against enterprise specifications.

### 2. Automation Studio
- **Candidates**: Prioritized backlog of test cases evaluated for test automation feasibility and ROI.
- **Test Runs**: Multi-environment execution orchestrator with real-time progress indicators.
- **Run Detail**: Deep inspection of step-by-step test execution, error logs, and execution traces.
- **Fault-Tolerant Sweeper**: Automated background worker (`sweep_orphaned_runs`) that cleans up runs orphaned by server restarts.

### 3. Administration & Governance
- **User Management**: Add, update, and manage users, their assigned roles, and `auth_source` (`local` vs `ldap`).
- **User Time Slots**: Configure allowed access windows and scheduling restrictions per user.
- **Session Control**: Real-time table of active user sessions with token expiry counters and one-click remote session revocation.
- **Audit Logs**: Tamper-evident logging of login events, auth sources, endpoint interactions, and IP addresses.
- **Manager Review (`ReviewAndApproval`)**: Approval gates for test plans before they are promoted or exported.

### 4. Enterprise Integrations (OSLC / IBM RQM / RTC)
- **OSLC Connector**: Direct REST/OSLC bridging to IBM Engineering Lifecycle Management (Jazz / RQM / RTC).
- **Test Case Export & Synchronization**: Syncs reviewed and approved test cases directly into external ALM suites.

### 5. Request Tracker & Token Analytics
- **Token Quota Management**: Sets and monitors token caps across users and departments.
- **Request Tracker Dashboard**: Real-time visualization of LLM latency, token distribution, provider metrics, and consumption history.
- **Data Export & CLI**: Export logs as JSON/CSV or run `analyze_requests.py` for offline auditing.

---

## 📁 Directory Structure

```
c:/AI-Testing/
├── .env                              # Root environment variables
├── docker-compose.yml                # Multi-container orchestration (Backend + Frontend)
├── INTEGRATION_EXAMPLE.ts            # Integration reference for Request Tracker
├── analyze_requests.py               # CLI tool for offline request log analytics
│
├── ai-admin-module-py/               # Backend Service (FastAPI)
│   ├── app/
│   │   ├── config.py                 # Pydantic settings & validation
│   │   ├── main.py                   # App entrypoint, middleware, background workers
│   │   ├── database/                 # SQLAlchemy models, connections & session manager
│   │   ├── routers/                  # API Routers (auth, users, audit, sessions, automation, oslc)
│   │   ├── services/                 # Business logic (ldap_service, automation job manager, etc.)
│   │   └── schemas/                  # Pydantic schemas for requests/responses
│   ├── Dockerfile                    # Backend Docker container definition
│   ├── requirements.txt              # Python dependencies
│   └── tests/                        # Backend test suites (Auth, Token, LDAP, Timezone)
│
└── ai-test-assistant-frontend/       # Frontend Application (React + Vite + TypeScript)
    ├── src/
    │   ├── components/               # UI widgets (Sidebar, TopHeader, Modals, Dashboards)
    │   ├── pages/                    # Main views (Dashboard, Users, Sessions, Settings, etc.)
    │   │   ├── test-assistant/       # Test Assistant sub-tabs (TestCases, Visual, Data, KB, Unit)
    │   │   └── automation/           # Automation Studio sub-tabs (Candidates, Runs, RunDetail)
    │   ├── routes.tsx                # Dynamic RBAC routing and permission guards
    │   ├── hooks/                    # Custom React hooks (useAuth, etc.)
    │   └── services/                 # Axios HTTP client and API integration
    ├── package.json                  # Node.js dependencies and build scripts
    └── tailwind.config.js            # Tailwind CSS configuration with custom dark theme
```

---

## 🔐 Authentication & Security

- **Dual Authentication**: 
  - Checks user existence in the local database first to prevent enumeration.
  - Users with `auth_source="ldap"` authenticate against corporate Active Directory / LDAP servers via `ldap3`.
  - Users with `auth_source="local"` authenticate against local secure credentials.
  - The built-in `admin` account is locked to `local` auth to prevent lockout during external LDAP outages.
- **Session Purge Worker**: An asynchronous background task purges expired JWT tokens from the session table every 60 seconds.
- **Protected Endpoints**: Endpoint access is enforced via JWT claims and RBAC matrix.

---

## 🚀 Getting Started & Local Setup

### Prerequisites
- **Python 3.11+**
- **Node.js 18+ & npm/pnpm**
- **Docker & Docker Compose** (for containerized deployment)

### Backend Setup (`ai-admin-module-py`)

1. Open a terminal in `ai-admin-module-py`:
   ```bash
   cd ai-admin-module-py
   ```
2. Create and activate a virtual environment:
   ```bash
   # Windows
   python -m venv .venv
   .venv\Scripts\activate

   # Linux / macOS
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Configure environment variables in `ai-admin-module-py/.env` (refer to `.env.example`).
5. Run the FastAPI development server:
   ```bash
   uvicorn app.main:app --reload --port 8003
   ```
6. Access the Swagger documentation at: `http://localhost:8003/admin/docs`

### Frontend Setup (`ai-test-assistant-frontend`)

1. Open a terminal in `ai-test-assistant-frontend`:
   ```bash
   cd ai-test-assistant-frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
4. Access the web interface at: `http://localhost:5175` (or configured port).

---

## 🐳 Docker Deployment

The platform includes a root `docker-compose.yml` for unified deployment:

```bash
# Build and run containers
docker compose up --build -d

# View container logs
docker compose logs -f

# Stop containers
docker compose down
```

- **Backend**: Available on port `8002` (or `8003`).
- **Frontend**: Available on port `5173`.

---

## ⚙️ Environment Configuration

### Backend (`ai-admin-module-py/.env`)
| Variable | Description |
| :--- | :--- |
| `SECRET_KEY` | Secret key used for signing JWT tokens. |
| `DATABASE_URL` | SQLAlchemy connection string (e.g., `sqlite:///./admin.db` or PostgreSQL). |
| `CORS_ALLOW_ORIGINS` | Comma-separated list of allowed frontend origins. |
| `LDAP_SERVER_URL` | LDAP server connection URI (optional; enables LDAP auth). |
| `LDAP_BASE_DN` | Base DN for user lookups in LDAP. |
| `AUTOMATION_ENABLED` | Toggle Automation Studio execution engine (`true`/`false`). |
| `LLM_PROVIDER` | Default LLM provider backend for AI test generation. |

### Frontend (`ai-test-assistant-frontend/.env`)
| Variable | Description |
| :--- | :--- |
| `VITE_API_URL` | Base URL of the backend FastAPI service. |
