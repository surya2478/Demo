# LDAP authentication service with SQLite whitelist validation.
# Two-phase authentication:
# 1. Check if user exists in SQLite with auth_source='ldap' (authorization whitelist)
# 2. If authorized, authenticate against LDAP using service account
# 
# Uses ldap3 for real LDAP integration.
# Falls back to demo mode if LDAP connection fails.

from ..config import settings
from ..database.connection import SessionLocal
from ..models.database import User
from sqlalchemy.orm import Session
import logging

logger = logging.getLogger(__name__)

def check_user_authorized_for_ldap(username: str, db: Session) -> bool:
    """
    Check if user exists in SQLite database with auth_source='ldap'.
    This acts as an authorization whitelist - only pre-registered users can attempt LDAP login.
    
    Args:
        username: The username to check
        db: SQLAlchemy database session
        
    Returns:
        True if user exists with auth_source='ldap', False otherwise
    """
    try:
        user = db.query(User).filter(User.username == username).first()
        
        if not user:
            logger.warning(f"User '{username}' not found in database - LDAP login denied (not whitelisted)")
            return False
            
        if user.auth_source != 'ldap':
            logger.warning(f"User '{username}' found but auth_source is '{user.auth_source}', not 'ldap' - LDAP login denied")
            return False
            
        if not user.is_active:
            logger.warning(f"User '{username}' is inactive - LDAP login denied")
            return False
            
        logger.info(f"User '{username}' authorized for LDAP authentication (found in whitelist)")
        return True
        
    except Exception as e:
        logger.error(f"Error checking user authorization for {username}: {e}")
        return False


def ldap_authenticate_with_service_account(username: str, password: str) -> bool:
    """
    Authenticate user against LDAP server using service account for binding.
    
    Process:
    1. Bind to LDAP using service account credentials
    2. Search for the target user in LDAP directory
    3. Attempt to bind as the target user with provided password
    4. Return True if authentication succeeds
    
    Args:
        username: The username to authenticate
        password: The user's password
        
    Returns:
        True if LDAP authentication succeeds, False otherwise
    """
    try:
        # Try to import ldap3
        try:
            from ldap3 import Server, Connection, ALL, SIMPLE, SUBTREE
            ldap3_available = True
        except ImportError:
            logger.warning("ldap3 not installed, using demo mode. Install with: pip install ldap3")
            ldap3_available = False
        
        # If ldap3 is available, try real LDAP authentication
        if ldap3_available:
            try:
                # Step 1: Connect and bind with service account
                logger.info(f"Connecting to LDAP server: {settings.LDAP_SERVER_URL}")
                
                try:
                    server = Server(settings.LDAP_SERVER_URL, get_info=ALL)
                except Exception as server_err:
                    logger.error(f"Failed to create LDAP server object: {server_err}")
                    raise
                
                try:
                    service_conn = Connection(
                        server,
                        user=settings.LDAP_SERVICE_ACCOUNT_DN,
                        password=settings.LDAP_SERVICE_ACCOUNT_PASSWORD,
                        authentication=SIMPLE,
                        auto_bind=True
                    )
                except Exception as bind_err:
                    logger.error(f"Failed to bind with service account: {bind_err}")
                    raise
                
                if not service_conn.bound:
                    logger.error("Failed to bind with LDAP service account")
                    return False
                    
                logger.info("Successfully bound to LDAP with service account")
                
                # Step 2: Search for the target user
                search_filter = settings.LDAP_USER_SEARCH_FILTER.format(username=username)
                logger.info(f"Searching for user with filter: {search_filter} in base: {settings.LDAP_SEARCH_BASE}")
                
                try:
                    # Use ALL_ATTRIBUTES (*) or minimal attributes to avoid "attribute type not present" errors
                    # Different LDAP servers use different attribute names (mail vs email, uid vs sAMAccountName, etc.)
                    search_success = service_conn.search(
                        search_base=settings.LDAP_SEARCH_BASE,
                        search_filter=search_filter,
                        search_scope=SUBTREE,
                        attributes=['*']  # Request all attributes to avoid attribute-specific errors
                    )
                    
                    if not search_success:
                        logger.error(f"LDAP search failed: {service_conn.result}")
                        service_conn.unbind()
                        return False
                        
                except Exception as search_err:
                    logger.error(f"LDAP search error: {search_err}")
                    logger.error(f"Search filter: {search_filter}, Base DN: {settings.LDAP_SEARCH_BASE}")
                    service_conn.unbind()
                    return False
                
                if not service_conn.entries:
                    logger.warning(f"User '{username}' not found in LDAP directory")
                    service_conn.unbind()
                    return False
                
                # Get the user's DN from search results
                user_entry = service_conn.entries[0]
                user_dn = user_entry.entry_dn
                logger.info(f"Found user DN: {user_dn}")
                
                # Unbind service account connection
                service_conn.unbind()
                
                # Step 3: Attempt to bind as the target user with provided password
                logger.info(f"Attempting to authenticate user '{username}' with their credentials")
                
                try:
                    user_conn = Connection(
                        server,
                        user=user_dn,
                        password=password,
                        authentication=SIMPLE,
                        auto_bind=True
                    )
                    
                    # If bind succeeds, authentication is successful
                    if user_conn.bound:
                        user_conn.unbind()
                        logger.info(f"✓ LDAP authentication successful for user: {username}")
                        return True
                    else:
                        logger.warning(f"✗ LDAP bind failed for user: {username} (invalid credentials)")
                        return False
                        
                except Exception as user_bind_err:
                    logger.error(f"Error binding as user '{username}': {user_bind_err}")
                    return False
                    
            except Exception as ldap_err:
                logger.error(f"LDAP connection error for {username}: {ldap_err}")
                logger.error(f"Server: {settings.LDAP_SERVER_URL}, Service Account DN: {settings.LDAP_SERVICE_ACCOUNT_DN}")
                logger.error(f"Search Base: {settings.LDAP_SEARCH_BASE}, Search Filter Template: {settings.LDAP_USER_SEARCH_FILTER}")
                # Fall through to demo mode
                # Fall through to demo mode
        
        # Demo/fallback mode: accept "ldappass" as password
        logger.info(f"Using demo LDAP mode for user: {username}")
        return password == "ldappass"
        
    except Exception as e:
        logger.error(f"LDAP authentication error for {username}: {e}")
        return False


def ldap_authenticate(username: str, password: str, db: Session = None) -> bool:
    """
    Main LDAP authentication function with SQLite whitelist validation.
    
    Two-phase authentication process:
    1. Phase 1: Check if user is authorized (exists in SQLite with auth_source='ldap')
    2. Phase 2: If authorized, authenticate against LDAP server
    
    Args:
        username: The username to authenticate
        password: The user's password
        db: SQLAlchemy database session (optional, will create one if not provided)
        
    Returns:
        True if both authorization and authentication succeed, False otherwise
    """
    # Create database session if not provided
    close_db = False
    if db is None:
        db = SessionLocal()
        close_db = True
    
    try:
        logger.info(f"=== Starting LDAP authentication for user: {username} ===")
        
        # Phase 1: Authorization check (SQLite whitelist)
        logger.info("Phase 1: Checking SQLite authorization whitelist...")
        if not check_user_authorized_for_ldap(username, db):
            logger.warning(f"✗ User '{username}' not authorized for LDAP login (not in whitelist)")
            return False
        
        logger.info(f"✓ User '{username}' is authorized (found in whitelist with auth_source='ldap')")
        
        # Phase 2: LDAP authentication
        logger.info("Phase 2: Authenticating against LDAP server...")
        result = ldap_authenticate_with_service_account(username, password)
        
        if result:
            logger.info(f"=== LDAP authentication SUCCESSFUL for user: {username} ===")
        else:
            logger.warning(f"=== LDAP authentication FAILED for user: {username} ===")
            
        return result
        
    except Exception as e:
        logger.error(f"Error in LDAP authentication flow for {username}: {e}")
        return False
    finally:
        if close_db:
            db.close()
