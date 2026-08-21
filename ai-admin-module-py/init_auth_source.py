"""
Initialize database and add auth_source column
Run with: python init_auth_source.py
"""
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import create_engine, Column, Integer, String, DateTime, Boolean, JSON
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from datetime import datetime, timezone

# Create Base
Base = declarative_base()

# Define User model directly to avoid circular import
class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    email = Column(String, unique=True)
    password = Column(String)
    role = Column(String)
    roles = Column(JSON)
    category = Column(String, nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime)
    modified_at = Column(DateTime)
    must_change_password = Column(Boolean, default=True)
    token_allocation = Column(Integer, default=10000)
    auth_source = Column(String, default="local", nullable=False)

def init_database():
    """Initialize database with auth_source support"""
    print("=" * 70)
    print("INITIALIZING DATABASE WITH DUAL AUTHENTICATION SUPPORT")
    print("=" * 70)
    
    # Database path
    db_path = Path(__file__).parent / "data" / "admin.db"
    database_url = f"sqlite:///{db_path}"
    
    # Create engine
    engine = create_engine(database_url, echo=True)
    
    print("\n📋 Step 1: Creating all tables...")
    print("-" * 70)
    Base.metadata.create_all(bind=engine)
    print("✅ Tables created successfully")
    
    # Create session
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        # Check if admin user exists
        admin = db.query(User).filter(User.username == "admin").first()
        
        if not admin:
            print("\n📋 Step 2: Creating admin user...")
            print("-" * 70)
            now = datetime.now(timezone.utc)
            admin_user = User(
                username="admin",
                email="admin@example.com",
                password="admin123",
                role="admin",
                roles=["admin"],
                category="system",
                is_active=True,
                auth_source="local",  # Admin always uses local auth
                must_change_password=False,
                token_allocation=100000,
                created_at=now,
                modified_at=now
            )
            db.add(admin_user)
            db.commit()
            print("✅ Admin user created")
            print("   Username: admin")
            print("   Password: admin123")
            print("   Auth Source: local")
        else:
            print("\n✅ Admin user already exists")
            print(f"   Username: {admin.username}")
            print(f"   Auth Source: {admin.auth_source if hasattr(admin, 'auth_source') else 'N/A'}")
        
        # Create sample LDAP user
        ldap_user = db.query(User).filter(User.username == "ldapuser").first()
        if not ldap_user:
            print("\n📋 Step 3: Creating sample LDAP user...")
            print("-" * 70)
            now = datetime.now(timezone.utc)
            ldap_test_user = User(
                username="ldapuser",
                email="ldapuser@example.com",
                password="",  # No password for LDAP users
                role="user",
                roles=["user"],
                category="development",
                is_active=True,
                auth_source="ldap",
                must_change_password=False,
                token_allocation=10000,
                created_at=now,
                modified_at=now
            )
            db.add(ldap_test_user)
            db.commit()
            print("✅ Sample LDAP user created")
            print("   Username: ldapuser")
            print("   Auth Source: ldap")
            print("   Password: ldappass (demo mode)")
        else:
            print("\n✅ LDAP user already exists")
        
        # Create sample local user
        local_user = db.query(User).filter(User.username == "localuser").first()
        if not local_user:
            print("\n📋 Step 4: Creating sample LOCAL user...")
            print("-" * 70)
            now = datetime.now(timezone.utc)
            local_test_user = User(
                username="localuser",
                email="localuser@example.com",
                password="localpass123",
                role="user",
                roles=["user"],
                category="development",
                is_active=True,
                auth_source="local",
                must_change_password=False,
                token_allocation=10000,
                created_at=now,
                modified_at=now
            )
            db.add(local_test_user)
            db.commit()
            print("✅ Sample LOCAL user created")
            print("   Username: localuser")
            print("   Password: localpass123")
            print("   Auth Source: local")
        else:
            print("\n✅ Local user already exists")
        
        # Display all users
        print("\n📋 Step 5: Summary of all users")
        print("-" * 70)
        users = db.query(User).all()
        print(f"\n{'Username':<15} | {'Email':<25} | {'Role':<10} | {'Auth Source':<12} | {'Active'}")
        print("-" * 70)
        for user in users:
            auth_src = user.auth_source if hasattr(user, 'auth_source') else 'N/A'
            print(f"{user.username:<15} | {user.email:<25} | {user.role:<10} | {auth_src:<12} | {user.is_active}")
        
        print("\n" + "=" * 70)
        print("✅ DATABASE INITIALIZATION COMPLETED SUCCESSFULLY")
        print("=" * 70)
        
        print("\n📝 Test Credentials:")
        print("   Admin (local):  username='admin', password='admin123'")
        print("   LDAP user:      username='ldapuser', password='ldappass' (demo mode)")
        print("   Local user:     username='localuser', password='localpass123'")
        
        print("\n📝 Authentication Flow:")
        print("   1. Login request → Check SQLite database first")
        print("   2. User found? → Check 'auth_source' field")
        print("   3. auth_source='local' → Validate password from database")
        print("   4. auth_source='ldap' → Validate via LDAP server")
        print("   5. User NOT found → Reject immediately")
        
        print("\n📝 Next Steps:")
        print("   • Run tests: python test_auth_source.py")
        print("   • Start server: uvicorn app.main:app --reload")
        print("   • Test login: POST /login with {username, password}")
        
    except Exception as e:
        db.rollback()
        print(f"\n❌ Error during initialization: {e}")
        import traceback
        traceback.print_exc()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    init_database()
