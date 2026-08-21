"""
Script to add token_allocation column to existing users table
Run this script to upgrade your database without using Alembic
"""
import sqlite3
import os

# Path to your SQLite database - try multiple locations
DB_PATHS = [
    os.path.join(os.path.dirname(__file__), "admin.db"),
    os.path.join(os.path.dirname(__file__), "data", "admin.db"),
    os.path.join(os.path.dirname(__file__), "app.db"),
]

def find_database():
    """Find the database file"""
    for path in DB_PATHS:
        if os.path.exists(path):
            return path
    return None

def add_token_allocation_column(db_path):
    """Add token_allocation column to users table"""
    try:
        # Connect to database
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        # Check if column already exists
        cursor.execute("PRAGMA table_info(users)")
        columns = [column[1] for column in cursor.fetchall()]
        
        if 'token_allocation' in columns:
            print("✓ Column 'token_allocation' already exists in users table")
            conn.close()
            return
        
        print("Adding 'token_allocation' column to users table...")
        
        # Add the column with default value
        cursor.execute("""
            ALTER TABLE users 
            ADD COLUMN token_allocation INTEGER DEFAULT 10000
        """)
        
        # Update any existing NULL values to default
        cursor.execute("""
            UPDATE users 
            SET token_allocation = 10000 
            WHERE token_allocation IS NULL
        """)
        
        # Commit changes
        conn.commit()
        
        # Verify the change
        cursor.execute("SELECT COUNT(*) FROM users WHERE token_allocation IS NOT NULL")
        count = cursor.fetchone()[0]
        
        print(f"✓ Successfully added 'token_allocation' column")
        print(f"✓ Updated {count} existing user(s) with default value of 10,000 tokens")
        
        # Show sample data
        cursor.execute("SELECT username, email, token_allocation FROM users LIMIT 5")
        users = cursor.fetchall()
        if users:
            print("\nSample users:")
            for username, email, tokens in users:
                print(f"  - {username} ({email}): {tokens:,} tokens")
        
        conn.close()
        print("\n✓ Migration completed successfully!")
        
    except sqlite3.Error as e:
        print(f"✗ Database error: {e}")
        raise
    except Exception as e:
        print(f"✗ Error: {e}")
        raise

if __name__ == "__main__":
    print("=" * 60)
    print("Adding token_allocation column to users table")
    print("=" * 60)
    
    DB_PATH = find_database()
    
    if not DB_PATH:
        print(f"✗ Database file not found in any of these locations:")
        for path in DB_PATHS:
            print(f"  - {path}")
        print("Please check the database path and try again.")
        exit(1)
    
    print(f"Database found: {DB_PATH}\n")
    add_token_allocation_column(DB_PATH)
