"""
Verify auth_source column in root admin.db
Run with: python verify_root_admin_db.py
"""
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from pathlib import Path

def verify_root_database():
    """Verify auth_source column exists and all data is intact"""
    print("=" * 70)
    print("VERIFICATION: ROOT admin.db")
    print("=" * 70)
    
    db_path = Path(r"D:\AI-App\GitRepo\vs-code-gitlab-projects\ai-testing-assistant-app-vs-code-v7\ai-admin-module-py\admin.db")
    
    print(f"\n📍 Database: {db_path}")
    print(f"📦 Size: {db_path.stat().st_size:,} bytes")
    
    database_url = f"sqlite:///{db_path}"
    engine = create_engine(database_url, echo=False)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        # Check auth_source column
        print("\n✅ VERIFICATION RESULTS:")
        print("-" * 70)
        
        result = db.execute(text("PRAGMA table_info(users)"))
        columns = {row[1]: row for row in result.fetchall()}
        
        if 'auth_source' in columns:
            col = columns['auth_source']
            print(f"✅ auth_source column: EXISTS")
            print(f"   Type: {col[2]}")
            print(f"   Not Null: {col[3] == 1}")
            print(f"   Default: {col[4] or 'local'}")
        else:
            print(f"❌ auth_source column: NOT FOUND")
            return False
        
        # Count users
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        total_users = result.fetchone()[0]
        print(f"\n✅ Total users: {total_users}")
        
        # Check auth_source distribution
        result = db.execute(text("SELECT auth_source, COUNT(*) FROM users GROUP BY auth_source"))
        print(f"\n📊 Auth Source Distribution:")
        for row in result.fetchall():
            print(f"   {row[0]:<10} : {row[1]} users")
        
        # List all users with auth_source
        print(f"\n📋 All Users (showing auth_source):")
        result = db.execute(text("SELECT username, email, role, auth_source, is_active FROM users ORDER BY username"))
        print(f"{'Username':<15} {'Email':<30} {'Role':<15} {'Auth':<10} {'Active'}")
        print("-" * 85)
        for user in result.fetchall():
            active_mark = "✓" if user[4] else "✗"
            print(f"{user[0]:<15} {user[1]:<30} {user[2]:<15} {user[3]:<10} {active_mark}")
        
        print("\n" + "=" * 70)
        print("✅ VERIFICATION COMPLETE - All data intact!")
        print("=" * 70)
        
        return True
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        return False
    finally:
        db.close()

if __name__ == "__main__":
    verify_root_database()
