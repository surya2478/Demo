# Role-based permissions configuration
ROLE_PERMISSIONS = {
    "admin": {
        "name": "Administrator",
        "permissions": [
            "user.manage",
            "settings.manage",
            "sessions.manage",
            "audit.view",
            # "reports.manage",
            "dashboard.view",
            "team.manage",
            "testassistant.view",
            'testassistantReport.view',
            "view_testcases",
            "view_visual",
            "view_testdata",
            "view_changes",
            "view_unit",
            "view_kb",
            # --- Automation Module: new permissions ---------------------------
            # Purely additive -- no existing permission changes meaning.
            # automation.execute is enforced server-side because a run spends
            # real CPU, memory and browser time on the backend host.
            "automation.view",
            "automation.execute",
            "automation.approve"
        ]
    },
    "manager": {
        "name": "Manager",
        "permissions": [
            "team.manage",
            # "reports.manage",
            "dashboard.view",
            "user.manage",
            "testassistant.view",
            "view_testcases",
            "view_testdata",
            # --- Automation Module ---
            # A manager can see and run automation, but script approval stays
            # with admins for now.
            "automation.view",
            "automation.execute"
        ]
    },
    "user": {
        "name": "User",
        "permissions": [
            "dashboard.view",
            "testassistant.view",
            "view_testcases",
            "view_testdata",
            "view_visual",
            "view_changes",
            "view_unit",
            "view_kb"

        ]
    },
    "tester": {
        "name": "Tester",
        "permissions": [
            "dashboard.view",
            "testassistant.view",
            "view_testcases",
            "view_testdata"          
        ]
    }
    ,
    "solution": {
        "name": "Solution",
        "permissions": [         
             "dashboard.view", 
            "testassistant.view",
            "view_testcases",
            "view_testdata",
             "view_kb"
           
        ]
    }
    ,
    "tester_level_2": {
        "name": "Tester_Level_2",
        "permissions": [         
             "dashboard.view", 
            "testassistant.view",
            "view_visual" ,
             "view_testcases",
            "view_testdata"           
        ]
    }
     ,
    "code_changes": {
        "name": "Code_Changes",
        "permissions": [          
            "dashboard.view",
            "testassistant.view",
            "view_changes",
            "view_unit"         
        ]
    }
}

def get_role_permissions(role: str):
    # print('role ==> ...... : ',role)
    if not role:
        return []
        println("return role.......",role)
    return ROLE_PERMISSIONS.get(role.lower(), {}).get("permissions", [])

def effective_permissions(user_roles: list) -> list:
    """Return deduplicated list of permissions for given roles."""
    perms = set()
    for r in (user_roles or []):
        if not r:
            continue
        for p in get_role_permissions(r):
            perms.add(p)
    return sorted(perms)

def has_permission(user_roles: list, required_permission: str) -> bool:
    if not required_permission:
        return False
    for role in (user_roles or []):
        if not role:
            continue
        if required_permission in get_role_permissions(role):
            return True
    return False