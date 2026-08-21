"""
Test script for dual authentication (local + LDAP)
Run this with: python test_auth_source.py
"""
import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import create_engine, text
from app.config import settings
from app.database.users import get_user, create_user
from app.services.ldap_service import ldap_authenticate
from sqlalchemy.orm import sessionmaker

def test_authentication():
    """Test the authentication system with different auth sources"""
    print("=" * 70)
    print("TESTING DUAL AUTHENTICATION SYSTEM (Local + LDAP)")
    print("=" * 70)
    
    # Create engine and session
    engine = create_engine(settings.DATABASE_URL, echo=False)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        print("\n📋 Step 1: Checking existing users...")
        print("-" * 70)
        
        # Get all users
        result = db.execute(text("SELECT username, email, role, auth_source FROM users"))
        users = result.fetchall()
        
        if not users:
            print("⚠️  No users found in database")
        else:
            print(f"Found {len(users)} user(s):")
            for user in users:
                print(f"  • {user[0]:<15} | {user[1]:<25} | {user[2]:<10} | Auth: {user[3]}")
        
        print("\n📋 Step 2: Testing ADMIN user (should be 'local' auth)...")
        print("-" * 70)
        
        admin = get_user(db, "admin")
        if admin:
            print(f"✅ Admin user found:")
            print(f"   Username: {admin['username']}")
            print(f"   Email: {admin['email']}")
            print(f"   Role: {admin['role']}")
            print(f"   Auth Source: {admin['auth_source']}")
            
            # Test admin login
            if admin['auth_source'] == 'local':
                if admin['password'] == 'admin123':
                    print("✅ Admin local authentication: WORKING")
                else:
                    print("❌ Admin local authentication: FAILED")
            else:
                print("⚠️  Admin has non-local auth source!")
        else:
            print("❌ Admin user not found!")
        
        print("\n📋 Step 3: Creating test LDAP user...")
        print("-" * 70)
        
        # Check if test LDAP user exists
        ldap_user = get_user(db, "ldapuser")
        if not ldap_user:
            try:
                ldap_user_data = {
                    "username": "ldapuser",
                    "email": "ldapuser@example.com",
                    "password": "",  # No password stored for LDAP users
                    "role": "user",
                    "roles": ["user"],
                    "category": "development",
                    "is_active": True,
                    "auth_source": "ldap",
                    "must_change_password": False
                }
                create_user(db, ldap_user_data)
                print("✅ Created test LDAP user: ldapuser")
                ldap_user = get_user(db, "ldapuser")
            except Exception as e:
                print(f"❌ Failed to create LDAP user: {e}")
        else:
            print(f"✅ LDAP user already exists: {ldap_user['username']}")
        
        print("\n📋 Step 4: Testing LDAP authentication...")
        print("-" * 70)
        
        if ldap_user:
            print(f"LDAP User Details:")
            print(f"   Username: {ldap_user['username']}")
            print(f"   Email: {ldap_user['email']}")
            print(f"   Auth Source: {ldap_user['auth_source']}")
            
            # Test LDAP authentication with demo password
            print("\n   Testing LDAP auth with demo password 'ldappass'...")
            if ldap_authenticate("ldapuser", "ldappass"):
                print("   ✅ LDAP authentication: SUCCESS")
            else:
                print("   ❌ LDAP authentication: FAILED")
            
            print("\n   Testing LDAP auth with wrong password...")
            if not ldap_authenticate("ldapuser", "wrongpass"):
                print("   ✅ LDAP rejection: WORKING")
            else:
                print("   ❌ LDAP rejection: FAILED")
        
        print("\n📋 Step 5: Creating test LOCAL user...")
        print("-" * 70)
        
        # Check if test local user exists
        local_user = get_user(db, "localuser")
        if not local_user:
            try:
                local_user_data = {
                    "username": "localuser",
                    "email": "localuser@example.com",
                    "password": "localpass123",
                    "role": "user",
                    "roles": ["user"],
                    "category": "development",
                    "is_active": True,
                    "auth_source": "local",
                    "must_change_password": False
                }
                create_user(db, local_user_data)
                print("✅ Created test LOCAL user: localuser")
                local_user = get_user(db, "localuser")
            except Exception as e:
                print(f"❌ Failed to create LOCAL user: {e}")
        else:
            print(f"✅ LOCAL user already exists: {local_user['username']}")
        
        print("\n📋 Step 6: Testing LOCAL authentication...")
        print("-" * 70)
        
        if local_user:
            print(f"Local User Details:")
            print(f"   Username: {local_user['username']}")
            print(f"   Email: {local_user['email']}")
            print(f"   Auth Source: {local_user['auth_source']}")
            
            # Test local authentication
            print("\n   Testing LOCAL auth with correct password...")
            if local_user['password'] == 'localpass123':
                print("   ✅ LOCAL authentication: WORKING")
            else:
                print("   ❌ LOCAL authentication: FAILED")
            
            print("\n   Testing LOCAL auth with wrong password...")
            if local_user['password'] != 'wrongpass':
                print("   ✅ LOCAL rejection: WORKING")
            else:
                print("   ❌ LOCAL rejection: FAILED")
        
        print("\n📋 Step 7: Summary of all users...")
        print("-" * 70)
        result = db.execute(text("SELECT username, email, role, auth_source, is_active FROM users"))
        print(f"\n{'Username':<15} | {'Email':<25} | {'Role':<10} | {'Auth':<10} | {'Active'}")
        print("-" * 70)
        for user in result.fetchall():
            print(f"{user[0]:<15} | {user[1]:<25} | {user[2]:<10} | {user[3]:<10} | {user[4]}")
        
        print("\n" + "=" * 70)
        print("✅ AUTHENTICATION TEST COMPLETED")
        print("=" * 70)
        print("\n📝 Authentication Flow Summary:")
        print("   1. Login request received with username + password")
        print("   2. Check SQLite database for user")
        print("   3. If user NOT found → Reject immediately")
        print("   4. If user found → Check 'auth_source' field:")
        print("      • 'local' → Validate password hash from database")
        print("      • 'ldap'  → Validate via LDAP server")
        print("   5. Return JWT tokens on successful authentication")
        
        print("\n📝 Test Credentials:")
        print("   Admin (local):  username='admin', password='admin123'")
        print("   LDAP user:      username='ldapuser', password='ldappass'")
        print("   Local user:     username='localuser', password='localpass123'")
        
        print("\n📝 LDAP Configuration:")
        print(f"   Server: {settings.LDAP_SERVER_URL}")
        print(f"   Base DN: {settings.LDAP_BASE_DN}")
        print(f"   Bind DN Template: {settings.LDAP_BIND_DN_TEMPLATE}")
        print("   Note: If ldap3 not installed, demo mode uses password='ldappass'")
        
    except Exception as e:
        print(f"\n❌ Error during testing: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    test_authentication()
