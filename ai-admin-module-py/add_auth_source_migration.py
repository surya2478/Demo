"""
Script to add auth_source column to users table
Run this with: python add_auth_source_migration.py
"""
import sys
import os
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent))

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

def run_migration():
    """Add auth_source column to users table"""
    print("=" * 60)
    print("Adding auth_source column to users table")
    print("=" * 60)
    
    # Database URL
    db_path = Path(__file__).parent / "data" / "admin.db"
    database_url = f"sqlite:///{db_path}"
    
    # Create engine
    engine = create_engine(database_url, echo=True)
    
    # Create a session
    Session = sessionmaker(bind=engine)
    session = Session()
    
    try:
        # Check if column already exists
        print("\n📋 Checking if auth_source column already exists...")
        result = session.execute(text("PRAGMA table_info(users)"))
        columns = [row[1] for row in result.fetchall()]
        
        if 'auth_source' in columns:
            print("✅ auth_source column already exists in users table")
            return
        
        print("\n➕ Adding auth_source column...")
        
        # Add the column with default value 'local'
        session.execute(text("""
            ALTER TABLE users ADD COLUMN auth_source VARCHAR DEFAULT 'local' NOT NULL
        """))
        
        # Update all existing users to have auth_source = 'local'
        session.execute(text("""
            UPDATE users SET auth_source = 'local' WHERE auth_source IS NULL
        """))
        
        session.commit()
        
        print("✅ Successfully added auth_source column")
        print("✅ All existing users set to 'local' authentication")
        
        # Verify the change
        print("\n📋 Verifying table structure...")
        result = session.execute(text("PRAGMA table_info(users)"))
        print("\nUsers table columns:")
        for row in result.fetchall():
            print(f"  - {row[1]} ({row[2]})")
        
        # Show current users and their auth_source
        print("\n📋 Current users in database:")
        result = session.execute(text("SELECT username, email, role, auth_source FROM users"))
        for row in result.fetchall():
            print(f"  - {row[0]}: {row[1]} | Role: {row[2]} | Auth: {row[3]}")
        
        print("\n" + "=" * 60)
        print("✅ Migration completed successfully!")
        print("=" * 60)
        
    except Exception as e:
        session.rollback()
        print(f"❌ Error during migration: {e}")
        raise
    finally:
        session.close()

if __name__ == "__main__":
    run_migration()
