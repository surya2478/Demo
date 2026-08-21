"""
Verify auth_source column in database
Run with: python verify_auth_column.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

def verify_database():
    """Check if auth_source column exists in users table"""
    print("=" * 70)
    print("VERIFYING AUTH_SOURCE COLUMN IN DATABASE")
    print("=" * 70)
    
    # Database path
    db_path = Path(__file__).parent / "data" / "admin.db"
    print(f"\n📍 Database Location: {db_path.absolute()}")
    print(f"📊 Database Exists: {db_path.exists()}")
    
    if not db_path.exists():
        print("❌ Database file not found!")
        return
    
    print(f"📦 Database Size: {db_path.stat().st_size} bytes")
    
    database_url = f"sqlite:///{db_path}"
    engine = create_engine(database_url, echo=False)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        # Check table structure
        print("\n📋 Checking users table structure...")
        result = db.execute(text("PRAGMA table_info(users)"))
        columns = result.fetchall()
        
        if not columns:
            print("❌ Users table does not exist or is empty!")
            return
        
        print("\n✅ Users table columns:")
        print(f"{'ID':<5} {'Name':<20} {'Type':<15} {'NotNull':<10} {'Default':<15}")
        print("-" * 70)
        
        has_auth_source = False
        for col in columns:
            cid, name, type_, notnull, default, pk = col
            print(f"{cid:<5} {name:<20} {type_:<15} {notnull:<10} {str(default):<15}")
            if name == 'auth_source':
                has_auth_source = True
        
        if has_auth_source:
            print("\n✅ auth_source column EXISTS!")
            
            # Check users
            print("\n📋 Current users in database:")
            result = db.execute(text("SELECT username, email, role, auth_source, is_active FROM users"))
            users = result.fetchall()
            
            if users:
                print(f"\n{'Username':<15} {'Email':<30} {'Role':<10} {'Auth':<10} {'Active'}")
                print("-" * 75)
                for user in users:
                    print(f"{user[0]:<15} {user[1]:<30} {user[2]:<10} {user[3]:<10} {user[4]}")
                print(f"\nTotal users: {len(users)}")
            else:
                print("⚠️  No users found in database")
        else:
            print("\n❌ auth_source column DOES NOT EXIST!")
            print("⚠️  Run: python init_auth_source.py")
        
        print("\n" + "=" * 70)
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()

if __name__ == "__main__":
    verify_database()
