"""
Test LDAP Authentication with Service Account and SQLite Whitelist

This script tests the two-phase LDAP authentication:
1. SQLite whitelist check (user must exist with auth_source='ldap')
2. LDAP authentication using service account binding

Test scenarios:
- User not in database (should fail at whitelist check)
- User with auth_source='local' (should fail at whitelist check)
- User with auth_source='ldap' but wrong password (should pass whitelist, fail LDAP)
- User with auth_source='ldap' and correct password (should pass both phases)
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.database.connection import SessionLocal, engine, Base
from app.models.database import User
from app.services.ldap_service import ldap_authenticate, check_user_authorized_for_ldap
from datetime import datetime
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

logger = logging.getLogger(__name__)

def setup_test_database():
    """Create test database with sample users"""
    logger.info("Setting up test database...")
    
    # Create all tables
    Base.metadata.create_all(bind=engine)
    
    db = SessionLocal()
    try:
        # Clear existing test users
        db.query(User).filter(User.username.in_(["ldapuser1", "localuser1", "ldapuser2"])).delete(synchronize_session=False)
        db.commit()
        
        # Create test users
        test_users = [
            User(
                username="ldapuser1",
                email="ldapuser1@example.com",
                password="",  # LDAP users don't need password in DB
                role="User",
                roles=["user"],
                category="standard",
                is_active=True,
                created_at=datetime.utcnow(),
                modified_at=datetime.utcnow(),
                auth_source="ldap",  # LDAP user - should authenticate via LDAP
                token_allocation=10000
            ),
            User(
                username="localuser1",
                email="localuser1@example.com",
                password="localpass123",
                role="User",
                roles=["user"],
                category="standard",
                is_active=True,
                created_at=datetime.utcnow(),
                modified_at=datetime.utcnow(),
                auth_source="local",  # Local user - LDAP should be denied
                token_allocation=10000
            ),
            User(
                username="ldapuser2",
                email="ldapuser2@example.com",
                password="",
                role="Admin",
                roles=["admin", "user"],
                category="premium",
                is_active=False,  # Inactive user - should fail
                created_at=datetime.utcnow(),
                modified_at=datetime.utcnow(),
                auth_source="ldap",
                token_allocation=50000
            )
        ]
        
        for user in test_users:
            db.add(user)
        
        db.commit()
        logger.info("✓ Test database setup complete")
        logger.info(f"Created users: ldapuser1 (ldap, active), localuser1 (local, active), ldapuser2 (ldap, inactive)")
        
    except Exception as e:
        logger.error(f"Error setting up test database: {e}")
        db.rollback()
    finally:
        db.close()


def test_whitelist_check():
    """Test the SQLite whitelist authorization check"""
    logger.info("\n" + "="*80)
    logger.info("TEST 1: SQLite Whitelist Authorization Check")
    logger.info("="*80)
    
    db = SessionLocal()
    try:
        # Test 1: User not in database
        logger.info("\n[Test 1.1] User not in database...")
        result = check_user_authorized_for_ldap("nonexistent", db)
        logger.info(f"Result: {'✗ PASS' if not result else '✗ FAIL'} - User not in database should be denied")
        
        # Test 2: User with auth_source='local'
        logger.info("\n[Test 1.2] User with auth_source='local'...")
        result = check_user_authorized_for_ldap("localuser1", db)
        logger.info(f"Result: {'✓ PASS' if not result else '✗ FAIL'} - Local user should be denied LDAP")
        
        # Test 3: User with auth_source='ldap' (active)
        logger.info("\n[Test 1.3] User with auth_source='ldap' (active)...")
        result = check_user_authorized_for_ldap("ldapuser1", db)
        logger.info(f"Result: {'✓ PASS' if result else '✗ FAIL'} - LDAP user should be authorized")
        
        # Test 4: User with auth_source='ldap' (inactive)
        logger.info("\n[Test 1.4] User with auth_source='ldap' (inactive)...")
        result = check_user_authorized_for_ldap("ldapuser2", db)
        logger.info(f"Result: {'✓ PASS' if not result else '✗ FAIL'} - Inactive LDAP user should be denied")
        
    finally:
        db.close()


def test_full_authentication():
    """Test the full two-phase authentication flow"""
    logger.info("\n" + "="*80)
    logger.info("TEST 2: Full Two-Phase LDAP Authentication")
    logger.info("="*80)
    
    db = SessionLocal()
    try:
        # Test 1: User not in whitelist
        logger.info("\n[Test 2.1] User not in whitelist...")
        result = ldap_authenticate("nonexistent", "anypassword", db)
        logger.info(f"Result: {'✓ PASS' if not result else '✗ FAIL'} - Should fail at whitelist check")
        
        # Test 2: User with wrong auth_source
        logger.info("\n[Test 2.2] User with auth_source='local'...")
        result = ldap_authenticate("localuser1", "anypassword", db)
        logger.info(f"Result: {'✓ PASS' if not result else '✗ FAIL'} - Should fail at whitelist check")
        
        # Test 3: LDAP user with wrong password (demo mode: not 'ldappass')
        logger.info("\n[Test 2.3] LDAP user with wrong password...")
        result = ldap_authenticate("ldapuser1", "wrongpassword", db)
        logger.info(f"Result: {'✓ PASS' if not result else '✗ FAIL'} - Should pass whitelist, fail LDAP auth")
        
        # Test 4: LDAP user with correct password (demo mode: 'ldappass')
        logger.info("\n[Test 2.4] LDAP user with correct password...")
        result = ldap_authenticate("ldapuser1", "ldappass", db)
        logger.info(f"Result: {'✓ PASS' if result else '✗ FAIL'} - Should pass both phases")
        
        # Test 5: Inactive LDAP user
        logger.info("\n[Test 2.5] Inactive LDAP user...")
        result = ldap_authenticate("ldapuser2", "ldappass", db)
        logger.info(f"Result: {'✓ PASS' if not result else '✗ FAIL'} - Should fail at whitelist check (inactive)")
        
    finally:
        db.close()


def main():
    """Run all tests"""
    logger.info("Starting LDAP Authentication Test Suite")
    logger.info("Testing two-phase authentication with SQLite whitelist")
    
    try:
        # Setup test environment
        setup_test_database()
        
        # Run tests
        test_whitelist_check()
        test_full_authentication()
        
        logger.info("\n" + "="*80)
        logger.info("TEST SUITE COMPLETE")
        logger.info("="*80)
        logger.info("\nNote: These tests use demo LDAP mode (password='ldappass')")
        logger.info("For production LDAP testing, ensure:")
        logger.info("  1. ldap3 is installed: pip install ldap3")
        logger.info("  2. LDAP server is accessible")
        logger.info("  3. Service account credentials are configured in config.py")
        logger.info("  4. User exists in LDAP directory with matching username")
        
    except Exception as e:
        logger.error(f"Test suite failed: {e}", exc_info=True)
        return 1
    
    return 0


if __name__ == "__main__":
    sys.exit(main())
