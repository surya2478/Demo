from sqlalchemy import Column, Integer, String, JSON
from ..database.connection import Base

class Setting(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String, unique=True, index=True)
    value = Column(JSON)  # Store settings as JSON

from pydantic import BaseModel

class AppSettings(BaseModel):
    id: str
    maintenance_mode: bool = False
    theme: str = "light"
    items_per_page: int = 20