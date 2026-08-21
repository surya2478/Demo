"""
Script to add time slot columns to the users table
"""
import sqlite3
import os

# Get the database path
db_path = os.path.join(os.path.dirname(__file__), 'admin.db')

print(f"Connecting to database: {db_path}")

# Connect to the database
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

try:
    # Check if columns already exist
    cursor.execute("PRAGMA table_info(users)")
    columns = [col[1] for col in cursor.fetchall()]
    print(f"Existing columns: {columns}")
    
    # Add allowed_time_start if it doesn't exist
    if 'allowed_time_start' not in columns:
        print("Adding allowed_time_start column...")
        cursor.execute("ALTER TABLE users ADD COLUMN allowed_time_start VARCHAR")
        print("✓ allowed_time_start column added")
    else:
        print("✓ allowed_time_start column already exists")
    
    # Add allowed_time_end if it doesn't exist
    if 'allowed_time_end' not in columns:
        print("Adding allowed_time_end column...")
        cursor.execute("ALTER TABLE users ADD COLUMN allowed_time_end VARCHAR")
        print("✓ allowed_time_end column added")
    else:
        print("✓ allowed_time_end column already exists")
    
    # Commit the changes
    conn.commit()
    print("\n✅ Database migration completed successfully!")
    
    # Verify the columns were added
    cursor.execute("PRAGMA table_info(users)")
    columns = [col[1] for col in cursor.fetchall()]
    print(f"\nFinal columns: {columns}")
    
except Exception as e:
    print(f"❌ Error: {e}")
    conn.rollback()
finally:
    conn.close()
