#!/usr/bin/env python
"""Add token columns to request_logs table"""
from sqlalchemy import create_engine, text

engine = create_engine('sqlite:///./admin.db')

try:
    with engine.connect() as conn:
        # Add prompt_tokens column
        conn.execute(text('ALTER TABLE request_logs ADD COLUMN prompt_tokens INTEGER'))
        print("✓ Added prompt_tokens column")
        
        # Add response_tokens column
        conn.execute(text('ALTER TABLE request_logs ADD COLUMN response_tokens INTEGER'))
        print("✓ Added response_tokens column")
        
        # Add total_tokens column
        conn.execute(text('ALTER TABLE request_logs ADD COLUMN total_tokens INTEGER'))
        print("✓ Added total_tokens column")
        
        conn.commit()
        print("\n✓ All columns added successfully")
except Exception as e:
    if "duplicate column name" in str(e).lower():
        print("⚠ Columns already exist - skipping")
    else:
        print(f"✗ Error: {e}")
        raise
