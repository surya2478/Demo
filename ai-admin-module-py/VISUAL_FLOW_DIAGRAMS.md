# Dual Authentication System - Visual Flow

## 🎨 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend / Client                       │
│                                                              │
│  • Login Form (username + password)                          │
│  • Receives JWT tokens                                       │
│  • Stores tokens in localStorage/sessionStorage              │
└────────────────┬────────────────────────────────────────────┘
                 │
                 │ POST /login
                 │ {username, password}
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│              FastAPI Backend (app/routers/auth.py)           │
│                                                              │
│  Step 1: Check SQLite Database                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  db.query(User).filter(username=username).first()    │   │
│  └────────────────┬────────────────────────────────────┘   │
│                   │                                          │
│              ┌────┴─────┐                                    │
│              │  Found?  │                                    │
│              └────┬─────┘                                    │
│                   │                                          │
│          ┌────────┴────────┐                                 │
│          │                 │                                 │
│         NO                YES                                │
│          │                 │                                 │
│          ▼                 ▼                                 │
│    ┌──────────┐    ┌─────────────────────┐                 │
│    │ REJECT   │    │ Check 'auth_source' │                 │
│    │ 401      │    └──────────┬──────────┘                 │
│    └──────────┘               │                             │
│                        ┌──────┴──────┐                      │
│                        │             │                      │
│                    'local'       'ldap'                     │
│                        │             │                      │
└────────────────────────┼─────────────┼──────────────────────┘
                         │             │
                         ▼             ▼
         ┌───────────────────────┐  ┌─────────────────────────┐
         │  Local Authentication │  │  LDAP Authentication    │
         │  (app/database)       │  │  (app/services/ldap)    │
         │                       │  │                         │
         │  • Get password from  │  │  • Connect to LDAP      │
         │    users table        │  │    server               │
         │  • Compare with input │  │  • Attempt bind with    │
         │    password           │  │    user credentials     │
         │  • Return True/False  │  │  • Return True/False    │
         └───────────┬───────────┘  └────────────┬────────────┘
                     │                           │
                     └─────────┬─────────────────┘
                               │
                          ┌────┴─────┐
                          │  Valid?  │
                          └────┬─────┘
                               │
                     ┌─────────┴─────────┐
                     │                   │
                    YES                 NO
                     │                   │
                     ▼                   ▼
          ┌────────────────────┐  ┌──────────┐
          │  Generate Tokens   │  │  REJECT  │
          │  • Access Token    │  │  401     │
          │  • Refresh Token   │  └──────────┘
          │  • Session ID      │
          │                    │
          │  Create Session    │
          │  • Store in DB     │
          │  • Track IP, UA    │
          │                    │
          │  Audit Log         │
          │  • Record login    │
          │  • Include source  │
          └────────┬───────────┘
                   │
                   │ Return tokens
                   ▼
          ┌────────────────────┐
          │   Client Receives  │
          │   • access_token   │
          │   • refresh_token  │
          │   • session_id     │
          └────────────────────┘
```

## 🗄️ Database Schema

```
┌─────────────────────────────────────────────────────────┐
│                    users table                          │
├─────────────┬──────────────┬──────────────┬─────────────┤
│ Column      │ Type         │ Default      │ Nullable    │
├─────────────┼──────────────┼──────────────┼─────────────┤
│ id          │ INTEGER      │ AUTO         │ NO          │
│ username    │ VARCHAR      │ -            │ NO (UNIQUE) │
│ email       │ VARCHAR      │ -            │ NO (UNIQUE) │
│ password    │ VARCHAR      │ -            │ NO          │
│ role        │ VARCHAR      │ -            │ NO          │
│ roles       │ JSON         │ -            │ NO          │
│ category    │ VARCHAR      │ NULL         │ YES         │
│ is_active   │ BOOLEAN      │ TRUE         │ NO          │
│ created_at  │ DATETIME     │ NOW()        │ NO          │
│ modified_at │ DATETIME     │ NOW()        │ NO          │
│ must_change │ BOOLEAN      │ TRUE         │ NO          │
│ token_alloc │ INTEGER      │ 10000        │ NO          │
│ auth_source │ VARCHAR      │ 'local'      │ NO ⭐ NEW   │
└─────────────┴──────────────┴──────────────┴─────────────┘

⭐ auth_source values: 'local' | 'ldap'
```

## 👥 User Types Comparison

```
┌─────────────────┬─────────────────┬─────────────────┐
│  LOCAL USER     │  LDAP USER      │  ADMIN USER     │
├─────────────────┼─────────────────┼─────────────────┤
│ auth_source:    │ auth_source:    │ auth_source:    │
│   'local'       │   'ldap'        │   'local'       │
│                 │                 │                 │
│ password:       │ password:       │ password:       │
│   Stored in DB  │   Empty/NULL    │   Stored in DB  │
│                 │                 │                 │
│ Validation:     │ Validation:     │ Validation:     │
│   DB password   │   LDAP server   │   DB password   │
│   comparison    │   bind attempt  │   comparison    │
│                 │                 │                 │
│ Example:        │ Example:        │ Example:        │
│   localuser     │   ldapuser      │   admin         │
│   localpass123  │   ldappass*     │   admin123      │
│                 │                 │                 │
│ Use Case:       │ Use Case:       │ Use Case:       │
│   Internal      │   Enterprise    │   System        │
│   accounts      │   directory     │   management    │
└─────────────────┴─────────────────┴─────────────────┘

*Demo mode password. Real LDAP uses actual directory credentials.
```

## 🔄 State Machine

```
                    ╔═══════════════════╗
                    ║   UNAUTHENTICATED ║
                    ╚═════════╤═════════╝
                              │
                              │ Submit Login
                              ▼
                    ┌─────────────────────┐
                    │  Check Database     │
                    └──────────┬──────────┘
                               │
                       ┌───────┴────────┐
                       │                │
                   User NOT          User
                    Found           Found
                       │                │
                       ▼                ▼
                   ╔═══════╗    ┌──────────────┐
                   ║ ERROR ║    │ Check Source │
                   ╚═══════╝    └───────┬──────┘
                       │                │
                       │         ┌──────┴──────┐
                       │         │             │
                       │      local         ldap
                       │         │             │
                       │         ▼             ▼
                       │   ┌──────────┐  ┌──────────┐
                       │   │ DB Check │  │   LDAP   │
                       │   └─────┬────┘  └─────┬────┘
                       │         │             │
                       │    ┌────┴────┐   ┌────┴────┐
                       │    │         │   │         │
                       │  Valid   Invalid Valid Invalid
                       │    │         │   │         │
                       │    └────┬────┴───┴────┬────┘
                       │         │             │
                       │         ▼             │
                       │    ╔═════════════╗    │
                       │    ║ AUTHENTICATED║    │
                       │    ╚═════════════╝    │
                       │                       │
                       └───────────┬───────────┘
                                   │
                                   ▼
                              ╔═══════╗
                              ║ ERROR ║
                              ╚═══════╝
```

## 📦 Component Interaction

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend Application                     │
│  • Login form                                                │
│  • Token storage                                             │
│  • API requests with Authorization header                    │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ HTTP/HTTPS
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                     FastAPI Router Layer                     │
│  • /login endpoint (auth.py)                                 │
│  • Token generation (utils/token.py)                         │
│  • Security middleware                                       │
└────────┬──────────────────────┬─────────────────────────────┘
         │                      │
         ▼                      ▼
┌────────────────────┐  ┌─────────────────────┐
│  Database Layer    │  │  LDAP Service       │
│  (database/users)  │  │  (services/ldap)    │
│                    │  │                     │
│  • get_user()      │  │  • ldap_auth()      │
│  • create_user()   │  │  • LDAP connect     │
│  • update_user()   │  │  • Bind attempt     │
└────────┬───────────┘  └──────────┬──────────┘
         │                         │
         ▼                         ▼
┌────────────────────┐  ┌─────────────────────┐
│  SQLite Database   │  │  LDAP Server        │
│  (data/admin.db)   │  │  (External)         │
│                    │  │                     │
│  • users table     │  │  • User directory   │
│  • sessions table  │  │  • Group info       │
│  • audit_logs      │  │  • Attributes       │
└────────────────────┘  └─────────────────────┘
```

## 🎯 Decision Tree

```
Is username in SQLite?
├── NO ───────────────────────► REJECT (401)
│
└── YES
    │
    What is auth_source?
    │
    ├── 'local'
    │   │
    │   Does password match DB?
    │   ├── YES ──────────────► SUCCESS (Generate Tokens)
    │   └── NO ───────────────► REJECT (401)
    │
    └── 'ldap'
        │
        Can bind to LDAP server?
        ├── YES ──────────────► SUCCESS (Generate Tokens)
        └── NO ───────────────► REJECT (401)
```

## 🔐 Security Layers

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: Database Check                             │
│ ✓ User must exist in SQLite                         │
│ ✓ Prevents user enumeration                         │
│ ✓ Single source of truth for active users           │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│ Layer 2: Auth Source Routing                        │
│ ✓ Per-user authentication method                    │
│ ✓ 'local' → Database password                       │
│ ✓ 'ldap' → External LDAP server                     │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│ Layer 3: Credential Validation                      │
│ • Local: Password comparison (add bcrypt!)          │
│ • LDAP: Server bind attempt                         │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│ Layer 4: Token Generation                           │
│ ✓ JWT with expiration                               │
│ ✓ Refresh token for renewal                         │
│ ✓ Session tracking in database                      │
└────────────┬────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────┐
│ Layer 5: Audit Logging                              │
│ ✓ Login attempts recorded                           │
│ ✓ Auth source tracked                               │
│ ✓ IP and user agent logged                          │
└─────────────────────────────────────────────────────┘
```

## 📊 Example Scenarios

### Scenario 1: Admin Login (Local)

```
User: admin | Password: admin123

1. Check DB ──────► Found (auth_source='local')
2. Validate ─────► Password matches in DB
3. Generate ─────► Tokens + Session
4. Return ───────► 200 OK with tokens
```

### Scenario 2: LDAP User Login

```
User: ldapuser | Password: ldappass

1. Check DB ──────► Found (auth_source='ldap')
2. Validate ─────► LDAP bind succeeds
3. Generate ─────► Tokens + Session
4. Return ───────► 200 OK with tokens
```

### Scenario 3: Invalid User

```
User: hacker | Password: anything

1. Check DB ──────► NOT Found
2. Reject ───────► Immediate 401
3. No further processing
4. Return ───────► 401 Invalid credentials
```

### Scenario 4: Wrong Password (Local)

```
User: localuser | Password: wrongpass

1. Check DB ──────► Found (auth_source='local')
2. Validate ─────► Password does NOT match
3. Reject ───────► 401
4. Return ───────► 401 Invalid credentials
```

### Scenario 5: LDAP Failure

```
User: ldapuser | Password: wrongpass

1. Check DB ──────► Found (auth_source='ldap')
2. Validate ─────► LDAP bind FAILS
3. Reject ───────► 401
4. Return ───────► 401 Invalid LDAP credentials
```

---

**Legend:**

- ⭐ New feature
- ✓ Security checkpoint
- ─► Flow direction
- ╔═╗ State/Status
- ┌─┐ Process/Component
