# from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, DateTime
# from sqlalchemy.orm import relationship
# from datetime import datetime
# from app.database import Base

# class Role(Base):
#     __tablename__ = "roles"
#     id = Column(Integer, primary_key=True, index=True)
#     name = Column(String(50), unique=True, index=True)

# class User(Base):
#     __tablename__ = "users"
#     id = Column(Integer, primary_key=True, index=True)
#     username = Column(String(50), unique=True, index=True, nullable=False)
#     email = Column(String(120), unique=True, index=True, nullable=False)
#     password_hash = Column(String(200), nullable=False)
#     role_id = Column(Integer, ForeignKey("roles.id"), nullable=False)
#     is_active = Column(Boolean, default=True)
#     created_at = Column(DateTime, default=datetime.utcnow)

#     role = relationship("Role", lazy="joined")



from pydantic import BaseModel, EmailStr
from typing import List

class User(BaseModel):
    username: str
    full_name: str
    email: EmailStr | None = None
    roles: List[str]
    disabled: bool = False