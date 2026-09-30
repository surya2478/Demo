# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# AI-Testing admin backend
# ---------------------------------------------------------------------------
# --- Automation Module: three changes in this file -------------------------
#   1. The proxy credential is no longer written into the image. It arrives as
#      a BuildKit secret, which never lands in a layer or in `docker history`.
#   2. The container runs as an unprivileged uid instead of root.
#   3. Node, @playwright/test and Chromium are installed so the Automation
#      Module can execute generated specs. Optional via a build arg.
#
# Build (with an authenticated proxy):
#
#   printf 'http://USER:PASS@proxy.example.com:8080' > .build-proxy
#   DOCKER_BUILDKIT=1 docker build --secret id=build_proxy,src=.build-proxy -t admin_module:latest .
#   rm .build-proxy
#
# Build (no proxy auth needed, or building outside the corporate network):
#
#   DOCKER_BUILDKIT=1 docker build -t admin_module:latest .
#
# Build a lean image without the browser runtime (~1.5 GB smaller; the
# Automation Module then reports its runtime as unavailable rather than
# failing at run time):
#
#   DOCKER_BUILDKIT=1 docker build --build-arg INSTALL_AUTOMATION_RUNTIME=false -t admin_module:latest .
# ---------------------------------------------------------------------------

# Pinned to bookworm rather than floating on `slim`. The Debian release decides
# the library package names below -- on trixie libasound2 becomes libasound2t64
# and the build breaks -- so the base is explicit instead of implied.
FROM python:3.11-slim-bookworm

ARG NODE_MAJOR=20
# Keep in step with the @playwright/test version the runner expects; a host and
# container Playwright mismatch is the usual cause of "works locally, fails in
# the container".
ARG PLAYWRIGHT_VERSION=1.55.0
ARG INSTALL_AUTOMATION_RUNTIME=true

# --- Automation Module: proxy is now a build arg ----------------------------
# The default is the value this file previously hardcoded, so a plain build is
# unchanged. Making it an argument means the image is not welded to one
# network -- pass an empty value to build or run outside the corporate proxy,
# which is also what makes the build verifiable off-site:
#     docker build --build-arg RUNTIME_PROXY= ...
ARG RUNTIME_PROXY=http://proxy.example.com:8080

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Runtime proxy for the application's own outbound calls. No credentials
    # here -- they are only needed to reach the package registries at build
    # time, and those are supplied as a secret below.
    HTTP_PROXY=${RUNTIME_PROXY} \
    HTTPS_PROXY=${RUNTIME_PROXY} \
    http_proxy=${RUNTIME_PROXY} \
    https_proxy=${RUNTIME_PROXY} \
    # --- Automation Module: typo fix ---------------------------------------
    # The lowercase list read "ai-admin-module-pyai-studio.example.com" --
    # a missing comma joined two hosts into one, so neither was matched and
    # calls to dx12348 were proxied despite the uppercase list exempting them.
    # Python's requests library reads the lowercase form first.
    NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/16,192.168.0.0/24,ai-admin-module-py,ai-studio.example.com,*.ai-studio.example.com \
    no_proxy=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/16,192.168.0.0/24,ai-admin-module-py,ai-studio.example.com,*.ai-studio.example.com

# --- Automation Module: browsers outside /root -------------------------------
# Set before any install so both the CLI and any future Python Playwright
# honour it. The default cache is /root/.cache/ms-playwright, readable only by
# root -- which would force the whole container back to running as root just to
# launch a browser. One variable relocates every download.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# --- Automation Module: credential removed from the image --------------------
# Was: pip install ... --proxy http://<user>:<password>@proxy...
# A credential in a RUN instruction is baked into the layer and is readable
# with `docker history` on any host holding the image. It now arrives as a
# BuildKit secret, mounted only for the duration of this command.
#
# The `|| true` on the read is deliberate: with no secret supplied the build
# falls back to the unauthenticated proxy from ENV, so a developer outside the
# corporate network can still build.
COPY requirements.txt /app/requirements.txt
RUN --mount=type=secret,id=build_proxy \
    set -eu; \
    BUILD_PROXY="$(cat /run/secrets/build_proxy 2>/dev/null || true)"; \
    if [ -n "$BUILD_PROXY" ]; then \
        export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
               HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY"; \
    fi; \
    pip install --no-cache-dir --upgrade pip; \
    pip install --no-cache-dir -r /app/requirements.txt

# --- Automation Module: browser runtime --------------------------------------
# Chromium's system libraries are listed explicitly rather than obtained via
# `playwright install --with-deps`, which resolves Ubuntu package names and
# fails on Debian.
#
# Node arrives from NodeSource. typescript and @types/node are not optional:
# the static quality gate runs `tsc --noEmit` over generated bundles, and
# without the Node type declarations every bundle fails on "Cannot find name
# 'process'" -- a false rejection worse than the defect the check exists to
# catch.
#
# IMPORTANT for whoever wires the runner: these packages are installed
# GLOBALLY, and NodeSource puts the global root at /usr/lib/node_modules --
# not /usr/local/lib/node_modules. A generated spec that does
# `import { test } from '@playwright/test'` will NOT resolve it, and setting
# NODE_PATH does not help: Node only walks parent directories looking for a
# node_modules folder, and Playwright's TypeScript loader is no different.
#
# The fix belongs in the workspace materialiser, not here -- symlink each run
# workspace's node_modules to `npm root -g`, which is what the ported
# workspace.py already does. Verified in this image: with that symlink a
# generated spec runs as uid 10001 and captures video, trace and screenshot.
RUN --mount=type=secret,id=build_proxy \
    set -eu; \
    if [ "$INSTALL_AUTOMATION_RUNTIME" != "true" ]; then \
        echo "INSTALL_AUTOMATION_RUNTIME=false -- skipping Node, Playwright and Chromium."; \
        exit 0; \
    fi; \
    BUILD_PROXY="$(cat /run/secrets/build_proxy 2>/dev/null || true)"; \
    if [ -n "$BUILD_PROXY" ]; then \
        export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
               HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY"; \
        npm_config_proxy="$BUILD_PROXY"; npm_config_https_proxy="$BUILD_PROXY"; \
        export npm_config_proxy npm_config_https_proxy; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
        fonts-liberation fonts-unifont fonts-noto-color-emoji \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 \
        libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 \
        libnspr4 libnss3 libpango-1.0-0 \
        libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
        libxkbcommon0 libxrandr2; \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; \
    apt-get install -y --no-install-recommends nodejs; \
    npm install -g \
        "@playwright/test@${PLAYWRIGHT_VERSION}" \
        typescript@5.4.5 \
        @types/node@20.14.2; \
    npx --yes playwright install chromium; \
    # World-readable and traversable so the unprivileged runtime uid below can
    # launch Chromium.
    chmod -R a+rX /ms-playwright; \
    rm -rf /var/lib/apt/lists/*

COPY . /app

# --- Company CA: trusted by every outbound call the backend makes -------------
# The browser trusts the internal Etisalat CA through Windows; this container
# only knows the public CAs, so its calls to the AI service at dx12348 (AI
# Checks, refine, healing, KB generation) failed the TLS handshake while the
# same model answered the browser. Any *.crt in certs/ (PEM: root and
# intermediate) is added to the system store here, and requests / Node are
# pointed at that store -- which still holds every public CA, so OpenRouter and
# OpenAI keep verifying. Verification stays on; AI_SERVICE_CA_BUNDLE_PATH can
# stay empty. An empty certs/ folder changes nothing.
RUN set -eu; \
    if ls /app/certs/*.crt >/dev/null 2>&1; then \
        cp /app/certs/*.crt /usr/local/share/ca-certificates/; \
        update-ca-certificates; \
    fi
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

# storage/automation holds run workspaces and evidence (AUTOMATION_STORAGE_PATH).
RUN mkdir -p /app/data /app/logs /app/storage/automation

# --- Automation Module: drop root ---------------------------------------------
# The image previously ran uvicorn as root with no USER directive. That uid also
# becomes the account generated Playwright specs execute under, and those specs
# are LLM output -- untrusted input. Running them as root inside a container
# with host bind mounts is more privilege than the work needs.
#
# uid/gid 10001 matches the convention the sibling platform uses, so a host-side
# chown is portable between the two.
#
# NOTE for deployment: docker-compose.yml bind-mounts ./data, ./logs and
# ./app/config.json from the host. Those paths are host-owned and must be made
# writable by uid 10001 once, or the container will fail to start:
#     sudo chown -R 10001:10001 ./data ./logs ./app/config.json
RUN groupadd -g 10001 appgroup \
    && useradd -r -u 10001 -g appgroup -d /app appuser \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 8002

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8002"]
