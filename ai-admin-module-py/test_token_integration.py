#!/usr/bin/env python
"""
Integration Test for Token Tracking in Request Tracker
Tests the complete flow: create log -> extract tokens -> store -> retrieve
"""

import json
import sys
from datetime import datetime
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# Import the service and models
from app.services.request_log_service import RequestLogService
from app.models.request_log import RequestLog, TabEnum
from app.database import Base

def setup_test_db():
    """Setup test database"""
    engine = create_engine('sqlite:///./admin.db', connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)

def test_token_extraction():
    """Test 1: Token extraction function"""
    print("\n" + "="*70)
    print("TEST 1: Token Extraction Function")
    print("="*70)
    
    # Test case 1: Valid token string
    response1 = "Generated test cases [TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836] successfully"
    result1 = RequestLogService.extract_token_counts(response1)
    
    print(f"Input: {response1}")
    print(f"Result: {result1}")
    assert result1 == (435, 1401, 1836), f"Expected (435, 1401, 1836), got {result1}"
    print("✓ PASS: Token extraction successful")
    
    # Test case 2: No tokens
    response2 = "Response without tokens"
    result2 = RequestLogService.extract_token_counts(response2)
    
    print(f"\nInput: {response2}")
    print(f"Result: {result2}")
    assert result2 == (None, None, None), f"Expected (None, None, None), got {result2}"
    print("✓ PASS: Handles missing tokens correctly")
    
    # Test case 3: Multiple token strings (should extract first)
    response3 = "First [TOKEN_COUNTS:Prompt=100,Response=200,Total=300] then [TOKEN_COUNTS:Prompt=10,Response=20,Total=30]"
    result3 = RequestLogService.extract_token_counts(response3)
    
    print(f"\nInput: {response3}")
    print(f"Result: {result3}")
    assert result3 == (100, 200, 300), f"Expected (100, 200, 300), got {result3}"
    print("✓ PASS: Extracts first token pattern found")
    
    print("\n✓ All token extraction tests passed!")

def test_create_log_with_tokens():
    """Test 2: Create log with automatic token extraction"""
    print("\n" + "="*70)
    print("TEST 2: Create Log with Automatic Token Extraction")
    print("="*70)
    
    SessionLocal = setup_test_db()
    db = SessionLocal()
    
    try:
        # Prepare log data with response containing tokens
        log_data = {
            "id": f"test-create-{datetime.now().timestamp()}",
            "timestamp": datetime.now().isoformat() + "Z",
            "tab": "testcases",
            "method": "POST",
            "url": "http://localhost:8000/api/generate",
            "endpoint": "/generate/testcases",
            "user": "test_user",
            "sessionId": "session-123",
            "requestPayload": {"type": "test"},
            "responseData": "Generated 5 test cases\n[TOKEN_COUNTS:Prompt=435,Response=1401,Total=1836]\nExecution completed successfully"
        }
        
        print(f"\nCreating log with ID: {log_data['id']}")
        print(f"Response data: {log_data['responseData'][:100]}...")
        
        # Create log through service
        log = RequestLogService.create_log(db, log_data)
        
        print(f"\n✓ Log created successfully: {log.id}")
        print(f"  - prompt_tokens: {log.prompt_tokens}")
        print(f"  - response_tokens: {log.response_tokens}")
        print(f"  - total_tokens: {log.total_tokens}")
        
        # Verify tokens were extracted
        assert log.prompt_tokens == 435, f"Expected prompt_tokens=435, got {log.prompt_tokens}"
        assert log.response_tokens == 1401, f"Expected response_tokens=1401, got {log.response_tokens}"
        assert log.total_tokens == 1836, f"Expected total_tokens=1836, got {log.total_tokens}"
        
        print("\n✓ Tokens extracted and stored correctly!")
        
        return log.id
        
    finally:
        db.close()

def test_create_log_with_explicit_tokens():
    """Test 3: Create log with explicit token values"""
    print("\n" + "="*70)
    print("TEST 3: Create Log with Explicit Token Values")
    print("="*70)
    
    SessionLocal = setup_test_db()
    db = SessionLocal()
    
    try:
        # Prepare log data with explicit tokens
        log_data = {
            "id": f"test-explicit-{datetime.now().timestamp()}",
            "timestamp": datetime.now().isoformat() + "Z",
            "tab": "visual",
            "method": "POST",
            "url": "http://localhost:8000/api/visual",
            "endpoint": "/generate/visual",
            "user": "test_user",
            "sessionId": "session-456",
            "promptTokens": 200,
            "responseTokens": 500,
            "totalTokens": 700,
            "responseData": "Generated visual output successfully"
        }
        
        print(f"\nCreating log with explicit tokens")
        print(f"Tokens - Prompt: {log_data['promptTokens']}, Response: {log_data['responseTokens']}, Total: {log_data['totalTokens']}")
        
        # Create log through service
        log = RequestLogService.create_log(db, log_data)
        
        print(f"\n✓ Log created: {log.id}")
        print(f"  - prompt_tokens: {log.prompt_tokens}")
        print(f"  - response_tokens: {log.response_tokens}")
        print(f"  - total_tokens: {log.total_tokens}")
        
        # Verify tokens were stored
        assert log.prompt_tokens == 200, f"Expected prompt_tokens=200, got {log.prompt_tokens}"
        assert log.response_tokens == 500, f"Expected response_tokens=500, got {log.response_tokens}"
        assert log.total_tokens == 700, f"Expected total_tokens=700, got {log.total_tokens}"
        
        print("\n✓ Explicit token values stored correctly!")
        
        return log.id
        
    finally:
        db.close()

def test_update_log_with_tokens():
    """Test 4: Update log with token extraction"""
    print("\n" + "="*70)
    print("TEST 4: Update Log with Token Extraction")
    print("="*70)
    
    SessionLocal = setup_test_db()
    db = SessionLocal()
    
    try:
        # First create a log without tokens
        create_data = {
            "id": f"test-update-{datetime.now().timestamp()}",
            "timestamp": datetime.now().isoformat() + "Z",
            "tab": "data",
            "method": "POST",
            "url": "http://localhost:8000/api/data",
            "endpoint": "/generate/data",
            "user": "test_user",
            "responseData": "Initial response without tokens"
        }
        
        log = RequestLogService.create_log(db, create_data)
        log_id = log.id
        
        print(f"\nCreated log: {log_id}")
        print(f"Initial tokens: prompt={log.prompt_tokens}, response={log.response_tokens}, total={log.total_tokens}")
        assert log.total_tokens is None, "Initial log should not have tokens"
        
        # Now update with response containing tokens
        update_data = {
            "responseStatus": 200,
            "responseData": "Generated data [TOKEN_COUNTS:Prompt=350,Response=950,Total=1300] completed",
            "duration": 1234
        }
        
        print(f"\nUpdating log with response containing tokens...")
        print(f"Response data: {update_data['responseData'][:100]}...")
        
        updated_log = RequestLogService.update_log(db, log_id, update_data)
        
        print(f"\n✓ Log updated: {updated_log.id}")
        print(f"  - response_status: {updated_log.response_status}")
        print(f"  - duration: {updated_log.duration}")
        print(f"  - prompt_tokens: {updated_log.prompt_tokens}")
        print(f"  - response_tokens: {updated_log.response_tokens}")
        print(f"  - total_tokens: {updated_log.total_tokens}")
        
        # Verify tokens were extracted from update
        assert updated_log.prompt_tokens == 350, f"Expected prompt_tokens=350, got {updated_log.prompt_tokens}"
        assert updated_log.response_tokens == 950, f"Expected response_tokens=950, got {updated_log.response_tokens}"
        assert updated_log.total_tokens == 1300, f"Expected total_tokens=1300, got {updated_log.total_tokens}"
        assert updated_log.response_status == 200, f"Expected response_status=200, got {updated_log.response_status}"
        
        print("\n✓ Tokens extracted and updated correctly!")
        
        return log_id
        
    finally:
        db.close()

def test_to_dict_serialization():
    """Test 5: to_dict() includes token fields"""
    print("\n" + "="*70)
    print("TEST 5: JSON Serialization with Token Fields")
    print("="*70)
    
    SessionLocal = setup_test_db()
    db = SessionLocal()
    
    try:
        # Create log with tokens
        log_data = {
            "id": f"test-dict-{datetime.now().timestamp()}",
            "timestamp": datetime.now().isoformat() + "Z",
            "tab": "testcases",
            "method": "POST",
            "url": "http://localhost:8000/api/test",
            "endpoint": "/test",
            "responseData": "Test [TOKEN_COUNTS:Prompt=111,Response=222,Total=333] complete"
        }
        
        log = RequestLogService.create_log(db, log_data)
        log_dict = log.to_dict()
        
        print(f"\nLog to_dict() output:")
        print(json.dumps({
            "id": log_dict.get("id"),
            "promptTokens": log_dict.get("promptTokens"),
            "responseTokens": log_dict.get("responseTokens"),
            "totalTokens": log_dict.get("totalTokens"),
            "tab": log_dict.get("tab")
        }, indent=2))
        
        # Verify token fields are in dict
        assert "promptTokens" in log_dict, "promptTokens missing from to_dict()"
        assert "responseTokens" in log_dict, "responseTokens missing from to_dict()"
        assert "totalTokens" in log_dict, "totalTokens missing from to_dict()"
        
        # Verify values
        assert log_dict["promptTokens"] == 111, f"Expected promptTokens=111, got {log_dict['promptTokens']}"
        assert log_dict["responseTokens"] == 222, f"Expected responseTokens=222, got {log_dict['responseTokens']}"
        assert log_dict["totalTokens"] == 333, f"Expected totalTokens=333, got {log_dict['totalTokens']}"
        
        print("\n✓ Token fields correctly serialized in JSON response!")
        
    finally:
        db.close()

def test_query_logs_with_tokens():
    """Test 6: Query logs and retrieve tokens"""
    print("\n" + "="*70)
    print("TEST 6: Query Logs with Token Data")
    print("="*70)
    
    SessionLocal = setup_test_db()
    db = SessionLocal()
    
    try:
        # Get logs and filter for those with tokens
        from sqlalchemy import not_
        logs_with_tokens = db.query(RequestLog).filter(not_(RequestLog.total_tokens.is_(None))).limit(5).all()
        
        print(f"\nLogs with token data: {len(logs_with_tokens)}")
        
        for log in logs_with_tokens:
            print(f"\n  ID: {log.id}")
            print(f"  Tab: {log.tab.value if isinstance(log.tab, TabEnum) else log.tab}")
            print(f"  Tokens: Prompt={log.prompt_tokens}, Response={log.response_tokens}, Total={log.total_tokens}")
        
        if logs_with_tokens:
            print("\n✓ Successfully queried logs with token data!")
        else:
            print("\n⚠ No logs with token data found (expected on first run)")
        
    finally:
        db.close()

def main():
    """Run all tests"""
    print("\n" + "="*70)
    print("TOKEN TRACKING INTEGRATION TEST SUITE")
    print("="*70)
    
    try:
        # Test 1: Token extraction
        test_token_extraction()
        
        # Test 2: Create with extracted tokens
        test_create_log_with_tokens()
        
        # Test 3: Create with explicit tokens
        test_create_log_with_explicit_tokens()
        
        # Test 4: Update with token extraction
        test_update_log_with_tokens()
        
        # Test 5: JSON serialization
        test_to_dict_serialization()
        
        # Test 6: Query with tokens
        test_query_logs_with_tokens()
        
        print("\n" + "="*70)
        print("✓ ALL TESTS PASSED!")
        print("="*70)
        print("\nSummary:")
        print("  ✓ Token extraction working correctly")
        print("  ✓ Create log with automatic extraction works")
        print("  ✓ Create log with explicit tokens works")
        print("  ✓ Update log with token extraction works")
        print("  ✓ JSON serialization includes token fields")
        print("  ✓ Query logs with token data works")
        print("\nThe token tracking system is fully operational!\n")
        
        return 0
        
    except AssertionError as e:
        print(f"\n✗ TEST FAILED: {e}")
        import traceback
        traceback.print_exc()
        return 1
    except Exception as e:
        print(f"\n✗ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == "__main__":
    sys.exit(main())
