# from sqlalchemy import Column, Integer, String, DateTime, Boolean
# from datetime import datetime, timedelta
# from app.database import Base

# class Session(Base):
#     __tablename__ = "sessions"
#     id = Column(Integer, primary_key=True, index=True)
#     username = Column(String(50), index=True)
#     token_id = Column(String(64), unique=True, index=True)
#     created_at = Column(DateTime, default=datetime.utcnow)
#     expires_at = Column(DateTime)
#     is_active = Column(Boolean, default=True)

#     def expired(self):
#         return datetime.utcnow() >= (self.expires_at or self.created_at + timedelta(minutes=60))




from pydantic import BaseModel
from datetime import datetime

class SessionRecord(BaseModel):
    session_id: str
    username: str
    created_at: datetime
    last_seen_at: datetime
    revoked: bool = False