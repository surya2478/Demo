"""
Add auth_source column to admin.db (root directory)
Preserves all existing data
Run with: python migrate_root_admin_db.py
"""
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from pathlib import Path

def migrate_root_database():
    """Add auth_source column to root admin.db without removing data"""
    print("=" * 70)
    print("MIGRATING ROOT admin.db - ADDING auth_source COLUMN")
    print("=" * 70)
    
    # Target database path
    db_path = Path(r"D:\AI-App\GitRepo\vs-code-gitlab-projects\ai-testing-assistant-app-vs-code-v7\ai-admin-module-py\admin.db")
    
    print(f"\n📍 Target Database: {db_path}")
    print(f"📊 Database Exists: {db_path.exists()}")
    
    if not db_path.exists():
        print("❌ Database file not found at specified location!")
        print("⚠️  Please verify the path is correct.")
        return False
    
    print(f"📦 Database Size: {db_path.stat().st_size} bytes")
    
    # Create connection
    database_url = f"sqlite:///{db_path}"
    engine = create_engine(database_url, echo=False)
    Session = sessionmaker(bind=engine)
    db = Session()
    
    try:
        # Check if users table exists
        print("\n📋 Step 1: Checking users table...")
        result = db.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name='users'"))
        if not result.fetchone():
            print("❌ Users table does not exist in this database!")
            return False
        
        print("✅ Users table found")
        
        # Count existing users
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        user_count = result.fetchone()[0]
        print(f"📊 Current user count: {user_count}")
        
        # Show current users
        if user_count > 0:
            print("\n📋 Current users in database:")
            result = db.execute(text("SELECT username, email, role FROM users"))
            print(f"{'Username':<20} {'Email':<30} {'Role':<10}")
            print("-" * 65)
            for user in result.fetchall():
                print(f"{user[0]:<20} {user[1]:<30} {user[2]:<10}")
        
        # Check if auth_source column already exists
        print("\n📋 Step 2: Checking for auth_source column...")
        result = db.execute(text("PRAGMA table_info(users)"))
        columns = [row[1] for row in result.fetchall()]
        
        if 'auth_source' in columns:
            print("✅ auth_source column already exists!")
            print("⚠️  No migration needed.")
            
            # Show current auth_source values
            result = db.execute(text("SELECT username, auth_source FROM users"))
            print("\n📋 Current auth_source values:")
            print(f"{'Username':<20} {'Auth Source':<15}")
            print("-" * 40)
            for user in result.fetchall():
                print(f"{user[0]:<20} {user[1]:<15}")
            
            return True
        
        print("⚠️  auth_source column NOT found - will add it now")
        
        # Add the column
        print("\n📋 Step 3: Adding auth_source column...")
        print("   SQL: ALTER TABLE users ADD COLUMN auth_source VARCHAR DEFAULT 'local' NOT NULL")
        
        db.execute(text("""
            ALTER TABLE users ADD COLUMN auth_source VARCHAR DEFAULT 'local' NOT NULL
        """))
        
        print("✅ Column added successfully")
        
        # Set all existing users to 'local'
        print("\n📋 Step 4: Setting auth_source='local' for all existing users...")
        db.execute(text("""
            UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL OR auth_source = ''
        """))
        
        db.commit()
        print("✅ All existing users set to 'local' authentication")
        
        # Verify the changes
        print("\n📋 Step 5: Verifying changes...")
        result = db.execute(text("PRAGMA table_info(users)"))
        print("\n✅ Updated table structure:")
        print(f"{'ID':<5} {'Column Name':<25} {'Type':<15} {'NotNull':<10}")
        print("-" * 60)
        for col in result.fetchall():
            cid, name, type_, notnull, default, pk = col
            marker = "⭐" if name == 'auth_source' else "  "
            print(f"{marker} {cid:<3} {name:<25} {type_:<15} {notnull:<10}")
        
        # Verify user count unchanged
        result = db.execute(text("SELECT COUNT(*) FROM users"))
        new_user_count = result.fetchone()[0]
        
        if new_user_count != user_count:
            print(f"\n⚠️  WARNING: User count changed from {user_count} to {new_user_count}")
        else:
            print(f"\n✅ User count unchanged: {user_count} users")
        
        # Show final state
        print("\n📋 Final user state:")
        result = db.execute(text("SELECT username, email, role, auth_source FROM users"))
        print(f"{'Username':<20} {'Email':<30} {'Role':<10} {'Auth':<10}")
        print("-" * 75)
        for user in result.fetchall():
            print(f"{user[0]:<20} {user[1]:<30} {user[2]:<10} {user[3]:<10}")
        
        print("\n" + "=" * 70)
        print("✅ MIGRATION COMPLETED SUCCESSFULLY")
        print("=" * 70)
        print("\n📝 Summary:")
        print(f"   • auth_source column added to users table")
        print(f"   • All {user_count} existing users set to 'local' authentication")
        print(f"   • No data was deleted or lost")
        print(f"   • Database location: {db_path}")
        
        return True
        
    except Exception as e:
        db.rollback()
        print(f"\n❌ Error during migration: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        db.close()

if __name__ == "__main__":
    success = migrate_root_database()
    if success:
        print("\n🎉 Migration successful! Database is ready to use.")
    else:
        print("\n❌ Migration failed. Please check the error messages above.")
