# 🔐 Dual Authentication - Quick Reference

## ⚡ Quick Start

### 1. Database Already Initialized ✅

```
✓ auth_source column added to users table
✓ Admin user: local authentication
✓ Test users created (ldapuser, localuser)
```

### 2. Test Credentials

| Type  | Username    | Password       | Auth   |
| ----- | ----------- | -------------- | ------ |
| Admin | `admin`     | `admin123`     | local  |
| LDAP  | `ldapuser`  | `ldappass`     | ldap\* |
| Local | `localuser` | `localpass123` | local  |

\*Demo mode. With real LDAP, use actual LDAP credentials.

## 🎯 Authentication Rules

### ✅ Flow

1. **Check SQLite** → User exists?
2. **NO** → ❌ Reject immediately
3. **YES** → Check `auth_source` field
4. **local** → Validate password from database
5. **ldap** → Validate via LDAP server

### 🔒 Key Points

- ✅ Database checked FIRST (always)
- ✅ User not found = instant rejection
- ✅ Admin = always local auth
- ✅ Each user has ONE auth source

## 📝 API Endpoint

### POST `/login`

**Request:**

```json
{
  "username": "admin",
  "password": "admin123"
}
```

**Success Response:**

```json
{
  "access_token": "eyJhbGc...",
  "refresh_token": "eyJhbGc...",
  "token_type": "bearer",
  "session_id": "admin-abc123..."
}
```

**Error Response:**

```json
{
  "detail": "Invalid credentials"
}
```

## 🧪 Test Commands

### Start Server

```bash
uvicorn app.main:app --reload
```

### Test Admin Login

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
```

### Test LDAP Login

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"ldapuser","password":"ldappass"}'
```

### Test Invalid User

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"fake","password":"any"}'
```

Expected: `{"detail": "Invalid credentials"}`

## 🔧 Create Users

### Local User

```python
from app.database.users import create_user

create_user(db, {
    "username": "john",
    "email": "john@company.com",
    "password": "securepass",
    "role": "user",
    "auth_source": "local"  # ← Database auth
})
```

### LDAP User

```python
from app.database.users import create_user

create_user(db, {
    "username": "jane",
    "email": "jane@company.com",
    "password": "",  # ← No password needed
    "role": "user",
    "auth_source": "ldap"  # ← LDAP auth
})
```

## ⚙️ LDAP Setup

### Install (Optional)

```bash
pip install ldap3
```

Without `ldap3`: Demo mode (password = `ldappass`)

### Configure

Edit `app/config.py`:

```python
LDAP_SERVER_URL = "ldap://your-server.com:389"
LDAP_BASE_DN = "dc=company,dc=com"
LDAP_BIND_DN_TEMPLATE = "uid={username},ou=people,dc=company,dc=com"
```

## 📂 Files Modified

| File                           | Change                      |
| ------------------------------ | --------------------------- |
| `app/models/database.py`       | Added `auth_source` column  |
| `app/database/users.py`        | Return/accept `auth_source` |
| `app/routers/auth.py`          | New auth flow               |
| `app/services/ldap_service.py` | Real LDAP integration       |

## 📂 Files Created

| File                         | Purpose                |
| ---------------------------- | ---------------------- |
| `init_auth_source.py`        | Initialize database    |
| `test_auth_source.py`        | Test suite             |
| `DUAL_AUTH_DOCUMENTATION.md` | Full docs              |
| `DUAL_AUTH_SUMMARY.md`       | Implementation summary |

## 🔍 Verify Database

```bash
sqlite3 data/admin.db "SELECT username, auth_source FROM users"
```

Expected output:

```
admin|local
ldapuser|ldap
localuser|local
```

## ⚠️ Security Notes

### Production Checklist

- [ ] Use password hashing (bcrypt) for local users
- [ ] Enable LDAPS (SSL/TLS) for LDAP connections
- [ ] Set strong admin password
- [ ] Configure proper LDAP bind credentials
- [ ] Enable audit logging
- [ ] Set up monitoring

### Current State

- ⚠️ Passwords stored in plain text (local users)
- ⚠️ LDAP demo mode if ldap3 not installed
- ✅ Admin user protected (can't be deleted)
- ✅ Database checked first (secure flow)
- ✅ Auth source per user (flexible)

## 🆘 Troubleshooting

### Login fails for admin

```bash
# Check admin exists
sqlite3 data/admin.db "SELECT * FROM users WHERE username='admin'"
# Should show auth_source='local'
```

### LDAP not working

```bash
# Check ldap3 installed
pip list | grep ldap3

# Test LDAP connection
python -c "from ldap3 import Server; print('OK')"
```

### Database issues

```bash
# Reinitialize database
python init_auth_source.py

# Backup first
cp data/admin.db data/admin.db.backup
```

## 📊 Status Check

Run comprehensive test:

```bash
python test_auth_source.py
```

Expected output:

```
✅ Admin user found (local auth)
✅ LDAP user found (ldap auth)
✅ Local user found (local auth)
✅ Authentication tests passed
```

## 🎓 Key Concepts

### auth_source Values

- `'local'` - Authenticate with database password
- `'ldap'` - Authenticate with LDAP server

### Authentication Priority

1. **Database lookup** (always first)
2. **User found?** Check auth_source
3. **Validate** based on auth_source
4. **Return tokens** or reject

### Admin User

- Username: `admin`
- Auth: Always `'local'`
- Cannot be deleted
- Full access to system

## 📞 Support

**Documentation:**

- Full: `DUAL_AUTH_DOCUMENTATION.md`
- Summary: `DUAL_AUTH_SUMMARY.md`
- Quick: This file

**Scripts:**

- Initialize: `python init_auth_source.py`
- Test: `python test_auth_source.py`

**Database:**

- Path: `data/admin.db`
- Backup: `data/admin.db.backup` (create manually)

---

**✅ System Ready**  
All users can now authenticate via local database or LDAP based on their `auth_source` setting.
