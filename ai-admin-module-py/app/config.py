import os
from pydantic_settings import BaseSettings, SettingsConfigDict
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
    # --- The AI service's spelling, not ours ------------------------------
    # config.json is excluded from the image, so a fresh container writes one
    # from these defaults -- which makes them the value a new deployment
    # actually runs on. They said "/chat/session-init" and "/chat/message",
    # and the deployed AI service publishes "/chat/init" and "/chat/stream";
    # its 404 surfaced as a 502 from generation with no hint that an endpoint
    # NAME was the problem. routers/generate.py answers to both spellings,
    # which is why this stayed hidden on the admin backend's own routes.
    chatInitiate: str = Field(default="/chat/init")
    chatStream: str = Field(default="/chat/stream")
    chatSessions: str = Field(default="/chat/sessions")
    chatDelete: str = Field(default="/chat/session/{session_id}")

class AiParametersModel(BaseModel):
    provider: str = Field(default="ollama")
    model: str = Field(default="gemma3:1b")
    temperature: float = Field(default=0.1)
    maxTokens: int = Field(default=4096)
# https://ai-studio.example.com/api/
class AiConfigModel(BaseModel):
    # --- This default decides what an unconfigured deployment talks to -------
    # THIS IS A PLACEHOLDER AND EVERY DEPLOYMENT MUST OVERRIDE IT. The host
    # below does not exist; it is here so no real organisation's address ships
    # in source. Set the real AI service in app/config.json for the
    # environment, or from the Settings screen once the app is up.
    #
    # Why the placeholder still matters: the deployed container has no
    # app/config.json at all -- .dockerignore excludes it, and compose mounts
    # only ./db-backup -- so routers/settings.py writes a fresh one from THIS
    # default on the first read. An unconfigured deployment therefore comes up
    # pointing at a host that does not resolve, which fails loudly and
    # obviously. That is deliberate: the alternative default that suggests
    # itself is "http://localhost:8002", and that one fails quietly instead --
    # it points the deployed Test Assistant at itself and breaks Process
    # Documents, which posts files to generateTestCases and expects the
    # external service's extracted text back.
    #
    # To run generation against this backend on purpose, set it in
    # app/config.json for that environment. Do not move it here. (Squad KB and
    # Automation KB generation reach this backend anyway -- the Test Assistant
    # posts them to /generate/kb-testcases on its own API URL.)
    BASE_URL: str = Field(default="https://ai-studio.example.com")
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
    # The same placeholder host appeared twice here, which looked like a
    # deliberate pair and was a copy-paste: a deployment fronting the app and
    # the AI service on two different hosts has to list both, and whoever
    # copied this line would have kept the duplicate. One placeholder, plus the
    # Vite dev server the frontend actually runs on.
    CORS_ALLOW_ORIGINS: str = Field(default="https://ai-studio.example.com,http://localhost:5175")

    # --- Automation Module: LDAP configuration moved to .env -------------------
    # Every value below previously shipped as a literal default in this file,
    # which meant .env was never consulted: the corporate AD topology (server
    # host, domain DN, and the service-account DN with its full OU path) was
    # baked into source, and one environment could not be pointed at a
    # different directory without editing code.
    #
    # They now default to empty and are read from .env. ldap_service.py already
    # reads them through `settings`, so no call site changes -- but LDAP
    # authentication will fail with a clear configuration error until .env
    # supplies them. See .env.example for the full key list.
    #
    # Local (non-LDAP) authentication is unaffected.
    #
    # Removed as part of this change: LDAP_BASE_DN and LDAP_BIND_DN_TEMPLATE.
    # Both had zero usages outside this file -- LDAP_BIND_DN_TEMPLATE described
    # a direct-bind flow the service-account flow replaced, and its default
    # ("uid=...,ou=people,...") did not even match this Active Directory.
    LDAP_SERVER_URL: str = Field(default="")
    LDAP_SEARCH_BASE: str = Field(default="")
    LDAP_SERVICE_ACCOUNT_DN: str = Field(default="")
    LDAP_SERVICE_ACCOUNT_PASSWORD: str = Field(default="")

    # Kept as a default: this is the standard Active Directory lookup pattern,
    # carries nothing site-specific, and is still overridable from .env.
    LDAP_USER_SEARCH_FILTER: str = Field(default="(sAMAccountName={username})")

    # --- Automation Module: demo fallback is now opt-in ------------------------
    # ldap_service.py ended with a fallback that accepted the literal password
    # "ldappass" for any whitelisted LDAP user whenever the LDAP block raised --
    # including when the service-account bind failed because credentials were
    # missing or wrong. An unreachable directory therefore downgraded to a
    # shared password rather than denying access, and the string is printed in
    # the repository's own documentation.
    #
    # It is now off unless explicitly enabled, so authentication fails closed.
    # Enable only on a developer machine with no directory available.
    LDAP_ALLOW_DEMO_FALLBACK: bool = Field(default=False)

    COOKIE_SECURE: bool = Field(default=False)
    COOKIE_SAMESITE: str = Field(default="lax")
    COOKIE_DOMAIN: Optional[str] = Field(default=None)
    OSLC_CA_BUNDLE_PATH: Optional[str] = Field(default=None)
    SOLUTIONS_API_BASE_URL: str = Field(default="https://solutions.example.com")
    SOLUTIONS_API_TIMEOUT_SECONDS: int = Field(default=60)
    SOLUTIONS_API_AUTH_TOKEN: str = Field(default="")
    ADO_RECORDS_API_URL: str = Field(default="")
    ADO_RECORDS_API_TIMEOUT_SECONDS: int = Field(default=30)
    ADO_RECORDS_API_TOKEN: str = Field(default="")

    # PEM bundle for the AI service's certificate chain, when it is signed by a
    # private/corporate CA the system trust store does not carry.
    AI_SERVICE_CA_BUNDLE_PATH: Optional[str] = Field(default=None)
    # Last resort for a local machine only: skips certificate verification,
    # which removes protection against interception.
    AI_SERVICE_VERIFY_SSL: bool = Field(default=True)
    # Secret. The AI service's own API key, sent as a bearer token by backend
    # callers. Server-side only -- never expose it as a VITE_ variable.
    AI_SERVICE_AUTH_TOKEN: str = Field(default="")

    ROLES: List[str] = Field(default=["Admin", "Manager", "QA", "Tester"])

    # --- Automation Module: runtime settings ----------------------------------
    # All defaulted, so existing deployments start unchanged with the module
    # simply inactive. Override in .env per environment.
    #
    # AUTOMATION_STORAGE_PATH   root for materialised run workspaces, generated
    #                           specs and captured evidence (screenshots, video,
    #                           trace). Gitignored; treat as regenerable output.
    # AUTOMATION_NODE_PATH      how to invoke the Node toolchain. "npx" works
    #                           when Node 20 is on PATH; set an absolute path
    #                           when the backend runs under a service account
    #                           with a different PATH than the shell.
    # AUTOMATION_RUN_TIMEOUT_SECONDS
    #                           wall clock per run before the subprocess is
    #                           killed and the run recorded as timed out.
    # AUTOMATION_HEAL_TIMEOUT_SECONDS
    #                           wall clock for the self-healing stage. The LLM
    #                           call inside it is bounded by a per-socket read
    #                           timeout, which a provider that trickles
    #                           keep-alive bytes never trips -- so the stage
    #                           needs a deadline of its own, or a stalled
    #                           provider parks the run at "running" forever.
    # AUTOMATION_MAX_CONCURRENT_RUNS
    #                           browser runs are memory-hungry and this backend
    #                           is a single process; 1 is the safe default and
    #                           matches the single-concurrency guard.
    # AUTOMATION_ENABLED        master switch. False keeps the routes mounted
    #                           but refusing, so the UI can show a clear reason
    #                           instead of failing opaquely.
    AUTOMATION_ENABLED: bool = Field(default=True)
    AUTOMATION_STORAGE_PATH: str = Field(default="./storage/automation")
    AUTOMATION_NODE_PATH: str = Field(default="npx")
    AUTOMATION_RUN_TIMEOUT_SECONDS: int = Field(default=600)
    # --- Automation Module: test data vault ------------------------------------
    # The Fernet key that encrypts credentials saved in Automation Studio's
    # Test data (usernames, passwords, OTPs). Generate one with
    #   python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    # and keep it out of the database. Unset, a key is derived from SECRET_KEY
    # -- which works, but ties the stored values to that key: rotate SECRET_KEY
    # and they can no longer be read.
    AUTOMATION_SECRETS_KEY: str = Field(default="")
    AUTOMATION_HEAL_TIMEOUT_SECONDS: int = Field(default=120)
    AUTOMATION_MAX_CONCURRENT_RUNS: int = Field(default=1)
    AUTOMATION_DEFAULT_SLOW_MO_MS: int = Field(default=1000)
    # --- Automation Module: AI resolution of guessed locators ------------
    # When the compiler cannot ground a step's locator it infers one from
    # the step's prose and flags the guess. With this on, those flagged
    # steps -- and only those -- are offered to a model before the script
    # is written. ON by default as of this change: it adds a model call per
    # generation, so a deployment that does not want that cost sets it to
    # false in .env rather than discovering it in a bill.
    AUTOMATION_AI_LOCATORS: bool = Field(default=True)

    # Directory holding the Knowledge Base's "applications/" folder. Empty
    # means "use the copy baked into the image at /app/knowledge_base", which
    # is the normal state. Set it to a bind-mounted path to update flow
    # blueprints without rebuilding -- they are the part of this system most
    # likely to change after a deployment goes live.
    AUTOMATION_KB_PATH: str = Field(default="")

    # Which environment variables a generated test may see. Generated specs are
    # LLM output executed as a subprocess of this backend, so without a filter
    # they inherit SECRET_KEY, DATABASE_URL, LDAP_SERVICE_ACCOUNT_PASSWORD and
    # the Solutions API token -- a script that prints process.env would leak all
    # of it into a log the UI renders.
    #
    # Entries may end in * to allow a prefix. Runtime essentials (PATH, HOME,
    # LANG, TZ ...) are always allowed and are listed in
    # services/automation/env_policy.py rather than here.
    #
    # HTTP_PROXY is deliberately absent: the image sets it for the corporate
    # proxy, and Chromium inheriting it would route traffic for internal SIT and
    # QA hosts through a proxy that has no route to them.
    AUTOMATION_RUNNER_ENV_ALLOWLIST: str = Field(
        default="BASE_URL,TARGET_BASE_URL,AUTOMATION_ENV,PLAYWRIGHT_*,PW_*,NODE_*"
    )
    # True: the subprocess receives only allowlisted variables.
    # False: nothing is filtered, but everything that would be filtered is
    # logged -- audit before enforcing on a deployment with unusual scripts.
    AUTOMATION_RUNNER_ENV_ALLOWLIST_ENFORCED: bool = Field(default=True)

    # --- Automation Module: LLM provider ---------------------------------------
    # Where the Studio's own LLM work (test-case refinement, script generation)
    # sends its prompts.
    #
    # "ai_service" is the existing path: the AI service at ai_config.BASE_URL
    # owns the model and its credentials, and this backend holds no key at all.
    # "openrouter" makes this backend the caller, which is why the key lives
    # here and not in ai_config.
    #
    # THE KEY IS SERVER-SIDE ON PURPOSE. It must never move into ai_config, the
    # Settings screen, or a VITE_ variable: ai_config is served to every
    # authenticated user by GET /settings/ai-config and cached in their
    # localStorage, and VITE_ values are inlined into the JavaScript bundle at
    # build time. A key in either is a key every user can read, and the browser
    # calls the AI service directly, so it would also travel to the client on
    # every request.
    LLM_PROVIDER: str = Field(default="ai_service")
    # The Automation Studio's own model (services/automation/llm.py): AI Refine,
    # Quality Review, Auto-Improve, Classify and healing. Empty means
    # LLM_PROVIDER. "azure" sends them to AZURE_OPENAI_* while everything else
    # stays on LLM_PROVIDER; "ai_service" and "openrouter" work here too.
    AUTOMATION_LLM_PROVIDER: str = Field(default="")

    # Direct OpenAI-compatible generation settings. Keep the key server-side;
    # the browser must never receive or choose it.
    OPENAI_API_KEY: str = Field(default="")
    OPENAI_BASE_URL: str = Field(default="https://api.openai.com/v1")
    OPENAI_MODEL: str = Field(default="")
    OPENAI_TIMEOUT_SECONDS: int = Field(default=120)
    FIGMA_VLM_MODEL: str = Field(default="gpt-5.1")
    SQUAD_KB_GENERATION_MODEL: str = Field(default="gpt-5.1")
    SQUAD_KB_GENERATION_PROVIDER: str = Field(default="openai")

    # Azure OpenAI v1 API (services/generation/azure_llm.py). Selected for
    # Knowledge Base generation by SQUAD_KB_GENERATION_PROVIDER=azure. The
    # model is the deployment name; the key stays server-side.
    AZURE_OPENAI_BASE_URL: str = Field(default="")
    AZURE_OPENAI_API_KEY: str = Field(default="")
    AZURE_OPENAI_MODEL: str = Field(default="")
    AZURE_OPENAI_TIMEOUT_SECONDS: int = Field(default=300)
    AZURE_OPENAI_MAX_TOKENS: int = Field(default=16000)
    FIGMA_VLM_PROMPT: str = Field(
        default=(
            "Extract all readable content from this Figma-exported PDF. "
            "Preserve page order, screen names, headings, labels, button text, "
            "field names, validation messages, tables, and visible business rules. "
            "Return clean plain text only. Do not describe images or invent text. "
            "Mark unreadable content as [UNREADABLE]."
        )
    )

    # Squad Knowledge Base retrieval settings. The embedding model must match
    # the vector dimension/model used when the PostgreSQL corpus was indexed.
    SQUAD_KB_DATABASE_URL: str = Field(default="")
    SQUAD_KB_EMBEDDING_MODEL: str = Field(default="octen-embedding")
    SQUAD_KB_EMBEDDING_BASE_URL: str = Field(default="")
    # Secret. Key for SQUAD_KB_EMBEDDING_BASE_URL. Kept separate from
    # OPENAI_API_KEY because the embedding server is usually a different host,
    # and the OpenAI key must not be sent to it. Blank sends no Authorization.
    SQUAD_KB_EMBEDDING_API_KEY: str = Field(default="")
    SQUAD_KB_EMBEDDING_DIMENSIONS: int = Field(default=1024)

    # Server-side Azure AI generation client. The full URL is configurable
    # because Azure OpenAI and Azure AI Projects expose different route shapes.
    AZURE_AI_CHAT_COMPLETIONS_URL: str = Field(default="")
    AZURE_AI_API_KEY: str = Field(default="")
    AZURE_AI_API_VERSION: str = Field(default="")
    AZURE_AI_MODEL: str = Field(default="gpt-5.1")
    AZURE_AI_AUTH_MODE: str = Field(default="api-key")
    AZURE_AI_TIMEOUT_SECONDS: int = Field(default=120)

    # Wall clock for one call on the ai_service path. Separate from
    # OPENROUTER_TIMEOUT_SECONDS because the two providers are tuned
    # independently, and because the Automation module previously read the
    # OpenRouter value here whatever LLM_PROVIDER said -- so raising the AI
    # service's timeout meant setting a variable named after a provider the
    # deployment was not using.
    AI_SERVICE_TIMEOUT_SECONDS: int = Field(default=120)
    # Optional. Sends the Automation module's AI service calls (AI Checks,
    # refine, healing) to a different AI service host than ai_config.BASE_URL.
    # Empty: they use ai_config.BASE_URL, like the Test Assistant tabs.
    AI_SERVICE_CHAT_BASE_URL: str = Field(default="")

    # Secret. Empty means "not configured" -- see openrouter_missing_keys(),
    # which names what is absent rather than failing on an anonymous 401.
    OPENROUTER_API_KEY: str = Field(default="")
    OPENROUTER_BASE_URL: str = Field(default="https://openrouter.ai/api/v1")

    # Deliberately no default. OpenRouter model ids are "vendor/model" slugs and
    # the catalogue moves; guessing one here would silently bill a model nobody
    # chose. Unset is a configuration error that names itself, which is how the
    # LDAP keys above behave too. Pick one from https://openrouter.ai/models.
    #
    # THIS IS ALSO THE PRODUCTION KILL SWITCH, and leaving it unset there is a
    # decision rather than an oversight. routers/generate.py serves
    # /generate/brd-testcases to any authenticated user, and every call spends
    # this backend's OpenRouter credit. Production does not route the Test
    # Assistant there -- ai_config.BASE_URL still points at the external AI
    # service -- so the endpoint is reachable but unused, and an unset model
    # makes it refuse with a 502 naming this setting instead of quietly billing.
    #
    # Setting it in production is therefore the switch that arms generation.
    # Do that in the same change that repoints ai_config.BASE_URL, not before.
    OPENROUTER_MODEL: str = Field(default="")

    OPENROUTER_TIMEOUT_SECONDS: int = Field(default=120)
    OPENROUTER_MAX_TOKENS: int = Field(default=8192)
    # Low by default: this generates test scripts and structured JSON, where
    # reproducibility matters more than variety.
    OPENROUTER_TEMPERATURE: float = Field(default=0.1)
    # Thinking before answering, for models that do it (deepseek-v4-flash and
    # the like). Off by default: the thinking is billed against max_tokens, and
    # on a 16k-character BRD it spent all 4096 of Generate's tokens in 195s and
    # returned no test cases; off, the same call answered in 31s. "off", "on"
    # (the model's own default), or an effort: "low", "medium", "high".
    OPENROUTER_REASONING: str = Field(default="off")

    def openrouter_reasoning(self) -> dict:
        """The request fields OPENROUTER_REASONING adds to an OpenRouter call."""
        value = (self.OPENROUTER_REASONING or "").strip().lower()
        if value in ("", "on", "default"):
            return {}
        if value in ("low", "medium", "high"):
            return {"reasoning": {"effort": value}}
        return {"reasoning": {"enabled": False}}

    # Journey KB extraction from design PDFs (services/journeys/documents.py).
    # Screen-flow PDFs carry their labels in screenshots, which a text model
    # never sees. Set this to an OpenRouter model that accepts images (for
    # example a Claude or GPT-4o class model) and extraction also sends each
    # page as a picture; left empty, extraction reads the page text only and
    # says so on every result.
    JOURNEY_EXTRACTION_VISION_MODEL: str = Field(default="")
    JOURNEY_EXTRACTION_TIMEOUT_SECONDS: int = Field(default=300)

    # Optional attribution, sent as HTTP-Referer and X-Title. OpenRouter uses
    # them to identify the calling app in its dashboards and rankings; both are
    # safe to leave empty.
    OPENROUTER_SITE_URL: str = Field(default="")
    OPENROUTER_APP_NAME: str = Field(default="AI Test Automation Studio")

    # AI Configuration stored under settings.ai_config (typed)
    ai_config: AiConfigModel = Field(default_factory=AiConfigModel)

    class Config:
        env_file = ".env"
        extra = "ignore"

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

    def openrouter_missing_keys(self) -> List[str]:
        """Which required OpenRouter settings are absent.

        Returned as names rather than a bare bool so a caller can say exactly
        what to set. The same shape as the LDAP checks: a configuration problem
        should name itself instead of surfacing later as an opaque 401 from a
        provider the operator may not even know is being used.
        """
        missing = []
        if not (self.OPENROUTER_API_KEY or "").strip():
            missing.append("OPENROUTER_API_KEY")
        if not (self.OPENROUTER_MODEL or "").strip():
            missing.append("OPENROUTER_MODEL")
        if not (self.OPENROUTER_BASE_URL or "").strip():
            missing.append("OPENROUTER_BASE_URL")
        return missing

    @property
    def openrouter_configured(self) -> bool:
        return not self.openrouter_missing_keys()

# single settings instance to import across the app
settings = Settings()
