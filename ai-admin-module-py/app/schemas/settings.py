from pydantic import BaseModel
from typing import Any, Dict

class SettingBase(BaseModel):
    key: str
    value: Dict[str, Any]

class SettingCreate(SettingBase):
    pass

class SettingUpdate(SettingBase):
    pass

class Setting(SettingBase):
    id: int

    class Config:
        orm_mode = True