#!/usr/bin/env python
"""Verify token columns in database"""
from sqlalchemy import inspect, create_engine

engine = create_engine('sqlite:///./admin.db', connect_args={'check_same_thread': False})

with engine.connect() as conn:
    inspector = inspect(conn)
    columns = [col['name'] for col in inspector.get_columns('request_logs')]
    
    print('Database Columns in request_logs table:')
    print('✓ prompt_tokens present' if 'prompt_tokens' in columns else '✗ prompt_tokens MISSING')
    print('✓ response_tokens present' if 'response_tokens' in columns else '✗ response_tokens MISSING')
    print('✓ total_tokens present' if 'total_tokens' in columns else '✗ total_tokens MISSING')
    print()
    print('All columns:', ', '.join(sorted(columns)))
