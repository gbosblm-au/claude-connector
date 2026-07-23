# Dockerfile  (Phase 10, Workstream 3 — Debian Bookworm migration)
# ---------------------------------------------------------------------------
# Multi-stage build for claude-connector.
# Compatible with Railway, Render, Fly.io, Google Cloud Run, and any Docker host.
#
# Phase 10 migration notes:
#   - Base image moved from node:20-alpine to Debian Bookworm (12). This is a
#     musl -> glibc move; all former apk packages are now apt packages. Debian
#     Bookworm is required for the Android SDK used by the mobile app generation
#     pipeline (scripts/mobile_app_gen.py).
#   - Node.js 20.x is installed via NodeSource (unchanged major version).
#   - Python is Bookworm's default python3, which is 3.11 — NOT 3.12. The Phase
#     10 spec lists 3.12 as the "Bookworm default"; that is inaccurate (Debian 12
#     ships 3.11). If 3.12 is a hard requirement it must come from source or a
#     third-party channel; none of the connector scripts require 3.12, so we use
#     the supported 3.11 here.
#   - OpenJDK 17 (Bookworm default) is installed for Android build support.
#   - The Android SDK is built in an ISOLATED stage (android-sdk) so the base +
#     Node + Python migration can be validated on its own before the large SDK
#     layer is added, per the Phase 10 risk mitigation. Build just the runtime
#     without the SDK by removing the two marked lines in the runtime stage.
#   - reportlab is now installed (Phase 5b's homework_assessment.py needs it; it
#     was previously missing from the image).
#   - Persistent volume: attach one at /data on Railway so the schedule store,
#     self-model queue, and mobile manifest survive redeploys.
# ---------------------------------------------------------------------------

# Pin the Bookworm base by date tag for reproducible builds. Engineering should
# bump this tag deliberately. (debian:bookworm-YYYYMMDD-slim.)
ARG DEBIAN_TAG=bookworm-20240701-slim

# ---------------------------------------------------------------------------
# Stage: base  — Debian Bookworm + Node.js 20.x (NodeSource)
# ---------------------------------------------------------------------------
FROM debian:${DEBIAN_TAG} AS base
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
         | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
         > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && node --version \
    && rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Stage: deps  — production node_modules only
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage: android-sdk  — ISOLATED Android SDK 34 + build-tools + OpenJDK 17
# Validate this stage independently (docker build --target android-sdk .) before
# wiring it into runtime. Produces a self-contained /opt/android-sdk.
# ---------------------------------------------------------------------------
FROM base AS android-sdk
ENV DEBIAN_FRONTEND=noninteractive
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
# Android command-line tools release. Bump deliberately.
ARG ANDROID_CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_PLATFORM=android-34
ARG ANDROID_BUILD_TOOLS=34.0.0

RUN apt-get update && apt-get install -y --no-install-recommends \
      openjdk-17-jdk-headless unzip wget \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p "${ANDROID_HOME}/cmdline-tools" \
    && wget -q -O /tmp/cmdline-tools.zip \
       "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" \
    && unzip -q /tmp/cmdline-tools.zip -d "${ANDROID_HOME}/cmdline-tools" \
    && mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest" \
    && rm /tmp/cmdline-tools.zip

ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"

# Accept licenses non-interactively, then install the required packages.
RUN yes | sdkmanager --licenses > /dev/null \
    && sdkmanager --install "platform-tools" "platforms;${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}" \
    && rm -rf "${ANDROID_HOME}/.android"

# ---------------------------------------------------------------------------
# Stage: runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# System libraries for the document-generation pipeline (weasyprint / cairosvg /
# Pillow need cairo, pango, gdk-pixbuf, ffi), plus base and emoji fonts. These
# are the glibc/apt equivalents of the former Alpine apk packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv python-is-python3 \
      libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf-2.0-0 \
      libffi8 shared-mime-info \
      fontconfig fonts-dejavu fonts-noto-color-emoji \
      wget ca-certificates \
    && mkdir -p /usr/share/fonts/custom \
    && wget -q -O /usr/share/fonts/custom/Raleway-Regular.ttf \
       "https://fonts.gstatic.com/s/raleway/v34/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVvao4CPNLA3JC9c.ttf" \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Python document-generation packages (Bookworm enforces PEP 668, so
# --break-system-packages is required, matching the previous image). reportlab
# is included for Phase 5b's homework_assessment.py.
RUN pip3 install --break-system-packages --retries 5 --timeout 120 \
      python-docx openpyxl Pillow jinja2 cairosvg fpdf2 python-pptx weasyprint reportlab PyMuPDF \
    && rm -rf /root/.cache/pip
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.11/dist-packages/fitz
# Android SDK 34 (isolated stage). Remove these two lines to build a
# document-only image without the mobile pipeline.
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
COPY --from=android-sdk /opt/android-sdk /opt/android-sdk
# OpenJDK 17 runtime for the Android build tools invoked by mobile_app_gen.py.
RUN apt-get update && apt-get install -y --no-install-recommends openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${ANDROID_HOME}/build-tools/34.0.0:${PATH}"

# Create a non-root user for security.
RUN groupadd -r mcp && useradd -r -g mcp -m -d /home/mcp mcp

# Copy production dependencies and application source.
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Data directory and persistent-volume mount point with correct ownership.
RUN mkdir -p /app/data /data \
    && chown -R mcp:mcp /app /data /opt/android-sdk

USER mcp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:3000/health || exit 1

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV SCHEDULE_STORE_PATH=/data/schedule_store.json

CMD ["node", "src/server-http.js"]
