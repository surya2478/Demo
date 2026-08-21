from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from typing import List, Optional
from datetime import datetime
from ..models.database import User
from zoneinfo import ZoneInfo

from ..database.connection import get_db
from ..database.users import get_user, create_user as db_create_user, update_user, delete_user
from ..utils.security import get_current_user_strict
from ..services.audit_logger import audit_log
DUBAI_TZ = ZoneInfo("Asia/Dubai")
router = APIRouter(tags=["Users"])

class UserResponse(BaseModel):
    username: str
    email: EmailStr
    role: str
    roles: List[str]
    category: Optional[str] = None
    is_active: bool
    must_change_password: bool
    token_allocation: int = 10000
    allowed_time_start: Optional[str] = None
    allowed_time_end: Optional[str] = None
    created_at: datetime
    modified_at: datetime

    model_config = {
        "from_attributes": True
    }

class UserListResponse(BaseModel):
    users: List[UserResponse]

    model_config = {
        "from_attributes": True
    }

class CreateUserRequest(BaseModel):
    username: str
    email: EmailStr
    password: str
    role: str
    category: Optional[str] = None
    must_change_password: bool
    token_allocation: int = 10000
    auth_source: str
    is_active: bool = True
    allowed_time_start: Optional[str] = None
    allowed_time_end: Optional[str] = None

class UpdateUserRequest(BaseModel):
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    role: Optional[str] = None
    roles: Optional[List[str]] = None
    category: Optional[str] = None
    is_active: Optional[bool] = None
    must_change_password: Optional[bool] = None
    token_allocation: Optional[int] = None
    auth_source: Optional[str] = None
    allowed_time_start: Optional[str] = None
    allowed_time_end: Optional[str] = None
    model_config = {
        "from_attributes": True
    }

class UpdateMustChangePasswordRequest(BaseModel):
    username: str
    password: str
    must_change_password: bool

    model_config = {
        "from_attributes": True
    }

@router.post("/create", response_model=UserResponse)
async def create_user_endpoint(
    user_data: CreateUserRequest,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """Create a new user"""
    # Check if current user has permission
    if "admin" not in current_user.get("roles", []):
        raise HTTPException(
            status_code=403,
            detail="Only admins can create users"
        )

    # Check if username already exists (sync call, no await)
    existing_user = get_user(db, user_data.username)
    if existing_user:
        raise HTTPException(
            status_code=400,
            detail="Username already registered"
        )

    # Create user with normalized roles
    new_user_data = {
        "username": user_data.username,
        "email": user_data.email,
        "password": user_data.password,
        "role": user_data.role.lower(),
        "roles": [user_data.role.lower()],
        "category": user_data.category,
        "is_active": user_data.is_active,
        "must_change_password": user_data.must_change_password if user_data.must_change_password is not None else True,
        "token_allocation": user_data.token_allocation if user_data.token_allocation is not None else 10000,
        "auth_source": user_data.auth_source if user_data.auth_source else "ldap",
        "allowed_time_start": user_data.allowed_time_start,
        "allowed_time_end": user_data.allowed_time_end,
        "created_at": datetime.now(DUBAI_TZ),
        "modified_at": datetime.now(DUBAI_TZ)
    }

    try:
        # call DB create helper (renamed import to avoid name collision)
        created_user = db_create_user(db, new_user_data)
        
        # # Log the action (sync)
        # audit_log(
        #     actor=current_user.get("username"),
        #     action="create_user",
        #     resource_name="Users",
        #     resource_type="modal",
        #     resource_id="create_user",
        #     module="Users",
        #     actor_role=current_user.get("role"),
        #     status="success",
        #     auth_source=new_user_data["auth_source"],
        #     details={"new user created ": user_data.username}
        # )

        return UserResponse(**created_user)

    except Exception as e:
        # # Log failure (sync)
        # audit_log(
        #     actor=current_user.get("username"),
        #     action="create_user",
        #     resource_name="Users",
        #     resource_type="modal",
        #     resource_id="create_user",
        #     module="Users",
        #     actor_role=current_user.get("role"),
        #     status="error",
        #     details={"error": str(e)}
        # )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to create user: {str(e)}"
        )

@router.get("/user/{username}")
async def read_user(username: str, db: Session = Depends(get_db)):
    # sync DB call
    user = get_user(db, username)
    # # Log the action
    # audit_log(
    #     actor=user.get("username"),
    #     action="get the user details",
    #     actor_role=user.get("role"),
    #     module="Users",
    #     resource_name="User Details",
    #     resource_id="get_user_details",
    #     resource_type="user details",
    #     status="success",
    #     details={"backend endpoint called to get the user details : ", username}
    # )

    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@router.get("/list", response_model=UserListResponse)
async def list_users(
    skip: int = 0,
    limit: int = 100,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """List all users (admin only)"""
    # Check if current user has permission
    if "admin" not in current_user.get("roles", []):
        raise HTTPException(
            status_code=403,
            detail="Only admins can list users"
        )

    users = db.query(User).offset(skip).limit(limit).all()
    user_list = []
    
    for user in users:
        user_dict = {
            "username": user.username,
            "email": user.email,
            "role": user.role,
            "roles": user.roles if isinstance(user.roles, list) else [user.role],
            "category": user.category,
            "is_active": user.is_active,
            "must_change_password" :user.must_change_password ,
            "token_allocation": user.token_allocation if hasattr(user, 'token_allocation') else 10000,
            "allowed_time_start": user.allowed_time_start if hasattr(user, 'allowed_time_start') else None,
            "allowed_time_end": user.allowed_time_end if hasattr(user, 'allowed_time_end') else None,
            "created_at": user.created_at.astimezone(DUBAI_TZ) if user.created_at else None,
            "modified_at": user.modified_at.astimezone(DUBAI_TZ) if user.modified_at else None
        }
        user_list.append(user_dict)

    # print(f"user details for audit log: {user_dict} ")
    print(f"current user details for audit log: {current_user} ")
    # Log the action
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="view users list",
    #     actor_role=current_user.get("role"),
    #     resource_name="Users",
    #     resource_id="list_users",
    #     resource_type="users list",
    #     module="Users",
    #     status="success",
    #     details={"viewed the user list": len(user_list)}
    # )


    return {"users": user_list}

@router.put("/update/{username}", response_model=UserResponse)
async def update_user_endpoint(
    username: str,
    payload: UpdateUserRequest,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """Update a user (admin or the user themself)"""
    # permission: admin can update anyone, others only themselves
    current_roles = current_user.get("roles", [])
    if "admin" not in current_roles and current_user.get("username") != username:
        raise HTTPException(status_code=403, detail="Not authorized to update this user")

    update_data = payload.dict(exclude_unset=True)
    # normalize role -> roles if provided as single role
    if "role" in update_data and "roles" not in update_data:
        update_data["roles"] = [update_data["role"]]

    updated = update_user(db, username, update_data)
    if not updated:
        raise HTTPException(status_code=404, detail="User not found")

    # # audit
    # audit_log(
    #     actor=current_user.get("username"),
    #     action="update",
    #     actor_role=current_user.get("role"),
    #     resource_name="Users",
    #     resource_type="modal",
    #     resource_id="update_user",
    #     module="Users",
    #     status="success",
    #     details={"/update backend endpoint called to update the role for user": username}
    # )

    # build response (DB helper returns dict)
    return UserResponse(
        username=updated["username"],
        email=updated["email"],
        role=updated.get("role", ""),
        roles=updated.get("roles", []),
        category=updated.get("category"),
        is_active=updated.get("is_active", True),
        must_change_password=updated.get("must_change_password", False),
        token_allocation=updated.get("token_allocation", 10000),
        allowed_time_start=updated.get("allowed_time_start"),
        allowed_time_end=updated.get("allowed_time_end"),
        created_at=updated.get("created_at").now(DUBAI_TZ),
        modified_at=updated.get("modified_at").now(DUBAI_TZ),
    )

@router.get("/dashboard/recent")
def recent_users_summary(
    limit: int = 10,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """
    Admin-only: return total users count and recent users list.
    Response:
      {
        "total_users": int,
        "recent_users": [ {user fields} ... ]
      }
    """
    # authorize admin
    roles = current_user.get("roles", []) if isinstance(current_user, dict) else []
    if isinstance(roles, str):
        roles = [roles]
    if "admin" not in [r.lower() for r in roles]:
        raise HTTPException(status_code=403, detail="Admin access required")

    total_users = db.query(User).count()

    recent_users = (
        db.query(User)
        .order_by(User.created_at.desc())
        #.limit(limit)
        .all()
    )

    recent_list = []
    for u in recent_users:
        recent_list.append({
            "username": u.username,
            "email": u.email,
            "role": u.role,
            "roles": u.roles if isinstance(u.roles, list) else [u.role],
            "category": u.category,
            "is_active": u.is_active,
            "must_change_password": u.must_change_password,
            "token_allocation": u.token_allocation if hasattr(u, 'token_allocation') else 10000,
            "created_at": u.created_at.astimezone(DUBAI_TZ),
            "modified_at": u.modified_at.astimezone(DUBAI_TZ),
        })

    return {"total_users": total_users, "recent_users": recent_list}

@router.put("/must_change_password", response_model=UserResponse)
async def update_must_change_password_endpoint(
    payload: UpdateMustChangePasswordRequest,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """Update password and must_change_password flag for a user (admin or user themself)."""
    # normalize roles and authorize
    roles = current_user.get("roles", []) if isinstance(current_user, dict) else []
    if isinstance(roles, str):
        roles = [roles]
    if "admin" not in [r.lower() for r in roles] and current_user.get("username") != payload.username:
        raise HTTPException(status_code=403, detail="Not authorized to modify this user")

    if not payload.password or len(payload.password.strip()) == 0:
        raise HTTPException(status_code=400, detail="Password cannot be empty")

    update_data = {
        "password": payload.password,
        "must_change_password": payload.must_change_password,
        "modified_at": datetime.utcnow()
    }

    try:
        updated = update_user(db, payload.username, update_data)
        if not updated:
            raise HTTPException(status_code=404, detail="User not found")

        # # audit success
        # audit_log(
        #     actor=current_user.get("username"),
        #     action="update_password_and_must_change_flag",
        #     resource_name="Users",
        #     resource_type="modal",
        #     resource_id="update_must_change_password",
        #     module="Users",
        #     actor_role=current_user.get("role"),
        #     status="success",
        #     details={"user ": payload.username, " updated his password because must_change_password flag is ": payload.must_change_password}
        # )

        return UserResponse(
            username=updated["username"],
            email=updated["email"],
            role=updated.get("role", ""),
            roles=updated.get("roles", []),
            category=updated.get("category"),
            is_active=updated.get("is_active", True),
            must_change_password=updated.get("must_change_password", False),
            token_allocation=updated.get("token_allocation", 10000),
            created_at=updated.get("created_at").now(DUBAI_TZ),
            modified_at=updated.get("modified_at").now(DUBAI_TZ),
        )

    except HTTPException:
        raise
    except Exception as e:
        # # audit failure
        # audit_log(
        #     actor=current_user.get("username"),
        #     action="update_password_and_must_change_flag",
        #     resource_name="Users",
        #     module="Users",
        #     resource_type="modal",
        #     resource_id="update_must_change_password",
        #     actor_role=current_user.get("role"),
        #     status="error",
        #     details={"updated_username": payload.username, "error": str(e)}
        # )
        raise HTTPException(status_code=500, detail=f"Failed to update password and must_change_password: {str(e)}")
    
@router.delete("/delete/{username}")
async def delete_user_endpoint(
    username: str,
    current_user=Depends(get_current_user_strict),
    db: Session = Depends(get_db)
):
    """Delete/deactivate a user (admin only)"""
    # Check if current user has permission (admin only)
    current_roles = current_user.get("roles", [])
    if "admin" not in current_roles:
        raise HTTPException(
            status_code=403,
            detail="Only admins can delete users"
        )
    
    # Prevent self-deletion
    if current_user.get("username") == username:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete your own account"
        )
    
    try:
        print('Attempting to delete user from router call :', username)
        # Call DB delete helper (marks user as inactive)
        success = delete_user(db, username)
        if not success:
            raise HTTPException(
                status_code=404,
                detail=f"User '{username}' not found"
            )
        
        # # Audit success
        # audit_log(
        #     actor=current_user.get("username"),
        #     action="delete_user",
        #     resource_name="Users",
        #     resource_type="user",
        #     resource_id=username,
        #     module="Users",
        #     actor_role=current_user.get("role"),
        #     status="success",
        #     details={"deleted_user": username}
        # )
        
        return {
            "message": f"User '{username}' has been deleted successfully",
            "username": username
        }
    
    except HTTPException:
        raise
    except Exception as e:
        # # Audit failure
        # audit_log(
        #     actor=current_user.get("username"),
        #     action="delete_user",
        #     resource_name="Users",
        #     resource_type="user",
        #     resource_id=username,
        #     module="Users",
        #     actor_role=current_user.get("role"),
        #     status="error",
        #     details={"deleted_user": username, "error": str(e)}
        # )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to delete user: {str(e)}"
        )