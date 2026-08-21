import os
from pydantic_settings import BaseSettings
from pydantic import Field, BaseModel
from typing import Dict, Any, List, Optional

class AiEndpointsModel(BaseModel):
    generateTestCases: str = Field(default="/generate/brd-testcases")
    generateVisual: str = Field(default="/generate/visual")
    generateTestData: str = Field(default="/generate/test-data")
    codeChanges: str = Field(default="/code/changes")
    codeGenerateTestCase: str = Field(default="/code/generate-cases")
    codeGenerateUnitTest: str = Field(default="/code/generate-unit-tests")  
    exportText: str = Field(default="/export/test-cases-txt")
    exportExcel: str = Field(default="/export/test-cases-excel")
    kbGenerate: str = Field(default="/kb/generate")
    kbUploadZip: str = Field(default="/kb/upload-zip")
    chatInitiate: str = Field(default="/chat/session-init")
    chatStream: str = Field(default="/chat/message")
    chatSessions: str = Field(default="/chat/sessions")
    chatDelete: str = Field(default="/chat/session/{session_id}")

class AiParametersModel(BaseModel):
    provider: str = Field(default="ollama")
    model: str = Field(default="gemma3:1b")
    temperature: float = Field(default=0.1)
    maxTokens: int = Field(default=4096)
# https://dx12348.etisalat.corp.ae/api/
class AiConfigModel(BaseModel):
    BASE_URL: str = Field(default="https://dx12348.etisalat.corp.ae")
    ENDPOINTS: AiEndpointsModel = Field(default_factory=AiEndpointsModel)
    PARAMETERS: AiParametersModel = Field(default_factory=AiParametersModel)

class Settings(BaseSettings):
    APP_ENV: str = Field(default="dev")
    # Accept DATABASE_URL from .env (prevents extra_forbidden error)
    DATABASE_URL: str = Field(default="sqlite:///./admin.db")
    # --- Automation Module: secret externalised --------------------------------
    # Was a literal default in source. Moved to .env (gitignored) so the JWT
    # signing key is not committed. Set SECRET_KEY in .env; the app will not
    # issue usable tokens with an empty key.
    SECRET_KEY: str = Field(default="")
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(default=45) 
    # 15 minutes session will expire, the same should be set in access token expiry too, in auth.py
    REFRESH_TOKEN_EXPIRE_DAYS: int = Field(default=7)
    JWT_ALGORITHM: str = Field(default="HS256")
    # keep as comma/string for dotenv compatibility
    CORS_ALLOW_ORIGINS: str = Field(default="https://dx12348.etisalat.corp.ae,https://dx12348.etisalat.corp.ae,http://localhost:5175")

    # LDAP Configuration
    LDAP_SERVER_URL: str = Field(default="ldaps://etisalat.corp.ae:636")
    LDAP_BASE_DN: str = Field(default="dc=etisalat,dc=corp,dc=ae")
    
    # LDAP Search Base - Where to search for users (use base DN for corporate AD)
    LDAP_SEARCH_BASE: str = Field(default="DC=etisalat,DC=corp,DC=ae")
    
    # LDAP User Search Filter - Use sAMAccountName for Active Directory
    LDAP_USER_SEARCH_FILTER: str = Field(default="(sAMAccountName={username})")
    
    # LDAP Service Account for binding and searching
    LDAP_SERVICE_ACCOUNT_DN: str = Field(default="cn=SRVQQ239,OU=Non-Prod_ServiceAccounts,OU=Service_Accounts_IDM,dc=etisalat,dc=corp,dc=ae")
    # --- Automation Module: secret externalised --------------------------------
    # Was a literal default in source. Moved to .env (gitignored) so the AD
    # service-account password is not committed. Set
    # LDAP_SERVICE_ACCOUNT_PASSWORD in .env or LDAP authentication will fail.
    LDAP_SERVICE_ACCOUNT_PASSWORD: str = Field(default="")
    
    # Legacy binding template (kept for backward compatibility)
    LDAP_BIND_DN_TEMPLATE: str = Field(default="uid={username},ou=people,dc=etisalat,dc=corp,dc=ae")
    
    COOKIE_SECURE: bool = Field(default=False)
    COOKIE_SAMESITE: str = Field(default="lax")
    COOKIE_DOMAIN: Optional[str] = Field(default=None)
    OSLC_CA_BUNDLE_PATH: Optional[str] = Field(default=None)
    SOLUTIONS_API_BASE_URL: str = Field(default="https://e2e-ai-dev.etisalat.corp.ae")
    SOLUTIONS_API_TIMEOUT_SECONDS: int = Field(default=60)
    SOLUTIONS_API_AUTH_TOKEN: str = Field(default="")

    ROLES: List[str] = Field(default=["Admin", "Manager", "QA", "Tester"])

    # AI Configuration stored under settings.ai_config (typed)
    ai_config: AiConfigModel = Field(default_factory=AiConfigModel)

    class Config:
        env_file = ".env"

    @property
    def cors_allow_origins(self) -> List[str]:
        """
        Return CORS origins as a list. Accepts:
         - comma-separated string in .env (e.g. "http://a,http://b")
         - JSON array string (pydantic will left it as str, still handled)
        """
        raw = self.CORS_ALLOW_ORIGINS or ""
        if isinstance(raw, str):
            raw = raw.strip()
            if raw.startswith("[") and raw.endswith("]"):
                try:
                    import json
                    parsed = json.loads(raw)
                    if isinstance(parsed, list):
                        return [str(x).strip() for x in parsed if str(x).strip()]
                except Exception:
                    pass
            return [s.strip() for s in raw.split(",") if s.strip()]
        return []

# single settings instance to import across the app
settings = Settings()
