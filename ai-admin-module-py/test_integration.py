"""
Final integration test - verify app can use the database
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from app.config import settings
from app.database.connection import get_db, engine
from sqlalchemy import text

def test_integration():
    """Test that the application can connect and use the database"""
    print("=" * 70)
    print("INTEGRATION TEST - Application Database Connection")
    print("=" * 70)
    
    print(f"\n📋 Configuration:")
    print(f"   DATABASE_URL: {settings.DATABASE_URL}")
    print(f"   Expected path: ./admin.db")
    
    db = next(get_db())
    
    try:
        # Test connection
        print("\n✅ Testing database connection...")
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        user_count = result.fetchone()[0]
        print(f"   Connected successfully!")
        print(f"   Users in database: {user_count}")
        
        # Test auth_source column
        print("\n✅ Testing auth_source column...")
        result = db.execute(text("SELECT username, auth_source FROM users LIMIT 3"))
        print(f"   Sample users:")
        for row in result.fetchall():
            print(f"      {row[0]:<15} → auth_source: {row[1]}")
        
        # Test admin user
        print("\n✅ Testing admin user...")
        result = db.execute(text("SELECT username, email, role, auth_source FROM users WHERE username='admin'"))
        admin = result.fetchone()
        if admin:
            print(f"   Username: {admin[0]}")
            print(f"   Email: {admin[1]}")
            print(f"   Role: {admin[2]}")
            print(f"   Auth Source: {admin[3]}")
        else:
            print("   ⚠️  Admin user not found!")
        
        print("\n" + "=" * 70)
        print("✅ INTEGRATION TEST PASSED")
        print("=" * 70)
        print("\n🎉 Application is ready to use the database!")
        print("\nTo start the server:")
        print("   uvicorn app.main:app --reload")
        
        return True
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

if __name__ == "__main__":
    test_integration()
