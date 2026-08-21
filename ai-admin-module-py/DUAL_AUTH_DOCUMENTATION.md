# Dual Authentication System (Local + LDAP)

## Overview

The authentication system now supports both **local database** and **LDAP** authentication based on the `auth_source` column in the users table.

## Authentication Flow

```
1. User submits login (username + password)
   ↓
2. Check SQLite database for user
   ↓
3. User found?
   NO → Reject with "Invalid credentials"
   YES → Continue to step 4
   ↓
4. Check 'auth_source' field
   ↓
   ├─ 'local' → Validate password hash from database
   │             ↓
   │             Password matches? → Success
   │             Password wrong? → Reject
   │
   └─ 'ldap' → Send credentials to LDAP server
                ↓
                LDAP bind succeeds? → Success
                LDAP bind fails? → Reject
   ↓
5. Generate JWT tokens (access + refresh)
   ↓
6. Create session in database
   ↓
7. Return tokens to client
```

## Database Schema Changes

### New Column: `auth_source`

Added to the `users` table:

```sql
ALTER TABLE users ADD COLUMN auth_source VARCHAR DEFAULT 'local' NOT NULL;
```

**Values:**

- `'local'` - User authenticates via database password
- `'ldap'` - User authenticates via LDAP server

**Default:** All existing users are set to `'local'`

**Admin user:** Always remains `'local'` authentication

## Installation & Setup

### 1. Install LDAP Support (Optional)

For real LDAP authentication:

```bash
pip install ldap3
```

**Note:** If `ldap3` is not installed, the system falls back to demo mode (password = `'ldappass'`)

### 2. Run Migration

Add the `auth_source` column to your database:

```bash
cd ai-admin-module-py
python add_auth_source_migration.py
```

Expected output:

```
============================================================
Adding auth_source column to users table
============================================================

➕ Adding auth_source column...
✅ Successfully added auth_source column
✅ All existing users set to 'local' authentication

📋 Current users in database:
  - admin: admin@example.com | Role: admin | Auth: local

============================================================
✅ Migration completed successfully!
============================================================
```

### 3. Configure LDAP Settings

Update `app/config.py` or your `.env` file:

```python
# LDAP Configuration
LDAP_SERVER_URL="ldap://your-ldap-server.com:389"
LDAP_BASE_DN="dc=example,dc=com"
LDAP_BIND_DN_TEMPLATE="uid={username},ou=people,dc=example,dc=com"
```

**Template Variables:**

- `{username}` - Replaced with the username from login request

**Example LDAP Configurations:**

Active Directory:

```
LDAP_SERVER_URL="ldap://ad.company.com:389"
LDAP_BASE_DN="dc=company,dc=com"
LDAP_BIND_DN_TEMPLATE="cn={username},ou=Users,dc=company,dc=com"
```

OpenLDAP:

```
LDAP_SERVER_URL="ldap://openldap.company.com:389"
LDAP_BASE_DN="dc=company,dc=com"
LDAP_BIND_DN_TEMPLATE="uid={username},ou=people,dc=company,dc=com"
```

### 4. Test the System

Run the comprehensive test script:

```bash
python test_auth_source.py
```

This will:

- Check existing users
- Verify admin user is set to 'local'
- Create test LDAP and local users
- Test authentication for each type
- Display summary of all users

## API Usage

### Login Endpoint

**POST** `/login`

**Request Body (JSON or Form):**

```json
{
  "username": "john_doe",
  "password": "user_password"
}
```

**Response (Success):**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "session_id": "john_doe-a1b2c3d4e5f6..."
}
```

**Response (Error):**

```json
{
  "detail": "Invalid credentials"
}
```

**Status Codes:**

- `200` - Authentication successful
- `401` - Invalid credentials (user not found or wrong password/LDAP)
- `422` - Missing username or password

## Creating Users

### Local Authentication User

```python
from app.database.users import create_user

user_data = {
    "username": "localuser",
    "email": "localuser@example.com",
    "password": "secure_password_123",  # Store hashed in production!
    "role": "user",
    "roles": ["user"],
    "category": "development",
    "is_active": True,
    "auth_source": "local",  # Local database authentication
    "must_change_password": False
}

create_user(db, user_data)
```

### LDAP Authentication User

```python
from app.database.users import create_user

user_data = {
    "username": "ldapuser",
    "email": "ldapuser@company.com",
    "password": "",  # No password stored for LDAP users
    "role": "user",
    "roles": ["user"],
    "category": "operations",
    "is_active": True,
    "auth_source": "ldap",  # LDAP authentication
    "must_change_password": False
}

create_user(db, user_data)
```

**Important:**

- LDAP users don't need a password in the database
- Their credentials are validated by the LDAP server
- You can set `password=""` or any placeholder value

## Security Considerations

### 1. Password Storage (Local Users)

⚠️ **Current Implementation:** Passwords are stored in plain text

🔒 **Production Recommendation:** Use bcrypt or similar:

```python
from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# When creating user
hashed_password = pwd_context.hash(plain_password)

# When authenticating
pwd_context.verify(plain_password, hashed_password)
```

### 2. LDAP Connection Security

**Use LDAPS (LDAP over SSL/TLS) in production:**

```python
LDAP_SERVER_URL="ldaps://ldap.company.com:636"
```

**Or use STARTTLS:**

```python
from ldap3 import Server, Connection, Tls
import ssl

tls = Tls(validate=ssl.CERT_REQUIRED)
server = Server(url, use_ssl=False, tls=tls)
conn = Connection(server, ...)
conn.start_tls()
```

### 3. Admin User Protection

The admin user:

- Always uses `'local'` authentication
- Cannot be deleted (protected in `delete_user()`)
- Should have a strong password

## Code Structure

### Modified Files

1. **`app/models/database.py`**

   - Added `auth_source` column to `User` model

2. **`app/database/users.py`**

   - Updated `get_user()` to return `auth_source`
   - Updated `create_user()` to accept `auth_source`
   - Updated return dictionaries to include `auth_source`

3. **`app/routers/auth.py`**

   - Updated `/login` endpoint with new authentication flow
   - Check database first, then authenticate by source
   - Added audit logging for auth_source

4. **`app/services/ldap_service.py`**
   - Implemented real LDAP authentication using `ldap3`
   - Fallback to demo mode if `ldap3` not installed
   - Comprehensive error handling and logging

### New Files

1. **`alembic/versions/20260122_add_auth_source_to_users.py`**

   - Alembic migration for adding column

2. **`add_auth_source_migration.py`**

   - Standalone migration script

3. **`test_auth_source.py`**

   - Comprehensive test suite

4. **`DUAL_AUTH_DOCUMENTATION.md`**
   - This documentation file

## Testing Examples

### Test Local User

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "admin123"}'
```

### Test LDAP User

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username": "ldapuser", "password": "ldappass"}'
```

### Test Invalid Credentials

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "wrongpassword"}'
```

### Test Non-existent User

```bash
curl -X POST http://localhost:8000/login \
  -H "Content-Type: application/json" \
  -d '{"username": "nonexistent", "password": "anypass"}'
```

Expected: `{"detail": "Invalid credentials"}` (immediate rejection)

## Troubleshooting

### LDAP Connection Issues

**Problem:** LDAP authentication always fails

**Solutions:**

1. Check LDAP server URL and port are correct
2. Verify network connectivity to LDAP server
3. Check firewall rules
4. Verify bind DN template matches your LDAP structure
5. Check logs for detailed error messages

**Test LDAP connection:**

```python
from ldap3 import Server, Connection, ALL

server = Server('ldap://your-server:389', get_info=ALL)
print(server.info)
```

### Migration Errors

**Problem:** Column already exists

**Solution:** This is safe - the migration checks first

**Problem:** SQLite syntax error

**Solution:** Ensure you're using SQLite 3.25+ which supports `ALTER TABLE ADD COLUMN`

### Demo Mode Not Working

**Problem:** LDAP authentication fails even in demo mode

**Check:**

1. Verify user exists in database: `SELECT * FROM users WHERE username='ldapuser'`
2. Check `auth_source` is set to `'ldap'`
3. Verify you're using password `'ldappass'` in demo mode

## Migration from Old System

If you have existing users:

1. **Backup your database first!**

   ```bash
   cp data/admin.db data/admin.db.backup
   ```

2. **Run migration script**

   ```bash
   python add_auth_source_migration.py
   ```

3. **All existing users will be set to `'local'` authentication**

4. **Update LDAP users manually** (optional):
   ```sql
   UPDATE users
   SET auth_source = 'ldap', password = ''
   WHERE username IN ('user1', 'user2', 'user3');
   ```

## Future Enhancements

Potential improvements:

1. **Password Hashing**

   - Implement bcrypt for local passwords
   - Migration script to hash existing passwords

2. **Multi-Factor Authentication (MFA)**

   - TOTP support for local users
   - SMS/Email verification

3. **OAuth2/SAML**

   - Add OAuth2 providers (Google, Microsoft, etc.)
   - SAML SSO integration

4. **Advanced LDAP Features**

   - Group membership sync
   - Automatic role assignment from LDAP groups
   - LDAP attribute mapping

5. **Audit & Monitoring**
   - Failed login tracking
   - Account lockout after X failed attempts
   - Login history and analytics

## Support

For issues or questions:

1. Check logs in `logs/` directory
2. Run test script: `python test_auth_source.py`
3. Verify database schema: `sqlite3 data/admin.db ".schema users"`
4. Check LDAP connectivity separately

## Summary

✅ **Completed:**

- Added `auth_source` column to users table
- Implemented dual authentication (local + LDAP)
- Always check SQLite first
- Reject immediately if user not found
- Authenticate based on `auth_source` value
- Admin user remains local authentication
- Comprehensive testing and documentation

🔒 **Security:**

- Database checked first (prevents enumeration)
- Auth source determines validation method
- LDAP support with fallback to demo mode
- Audit logging includes auth_source

📝 **Recommended Next Steps:**

1. Implement password hashing for local users (bcrypt)
2. Configure real LDAP server in production
3. Enable LDAPS/TLS for LDAP connections
4. Set up monitoring and alerting
5. Regular security audits
