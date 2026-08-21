# from fastapi import HTTPException, status

# def require(condition: bool, message: str, code=status.HTTP_403_FORBIDDEN):
#     if not condition:
#         raise HTTPException(status_code=code, detail=message)


# Placeholder for request validators or custom logic if needed later
def non_empty(value: str) -> str:
    if not value or not value.strip():
        raise ValueError("Value cannot be empty")
    return value.strip()