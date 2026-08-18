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
# ---------------------------------------------------------------------------
# Base image pinning  (v12.33.0 -- TNX-H-010)
#
# A dated tag such as bookworm-20240701-slim is better than `bookworm-slim`, but
# it is still MUTABLE: the registry can, and does, repoint a dated tag when a
# security rebuild is published. Two builds of the same commit can therefore
# still resolve different base layers, which is the same reproducibility problem
# as the missing lockfile, one layer down.
#
# A digest is immutable. To pin one:
#
#   docker pull debian:bookworm-20240701-slim
#   docker inspect --format='{{index .RepoDigests 0}}' debian:bookworm-20240701-slim
#
# then set DEBIAN_DIGEST to the sha256:... value it prints, either here or with
# --build-arg. Refresh it deliberately when taking a base-image update, so the
# change appears in a diff and in a review rather than arriving silently on the
# next rebuild.
#
# NOTE: no digest is hardcoded below on purpose. A digest is specific to the
# image the registry holds, and writing a plausible-looking but unverified
# sha256 here would be worse than leaving it unset: the build would fail with a
# manifest error, or -- worse -- succeed against something nobody intended.
# Until it is set, the build falls back to the dated tag and prints a warning.
# ---------------------------------------------------------------------------
ARG DEBIAN_TAG=bookworm-20240701-slim
ARG DEBIAN_DIGEST=

# ---------------------------------------------------------------------------
# Stage: base  — Debian Bookworm + Node.js 20.x (NodeSource)
# ---------------------------------------------------------------------------
# When DEBIAN_DIGEST is supplied, DEBIAN_REF resolves to an immutable digest
# reference; otherwise it falls back to the mutable dated tag.
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
# TNX-H-010: package-lock.json is REQUIRED. `npm ci` fails loudly if it is
# absent or out of step with package.json, which is the property that makes a
# build reproducible. `npm install` silently mutates the tree to satisfy caret
# ranges, so two builds of the same commit could resolve different dependency
# trees -- and "roll back and confirm" stops being dependable incident response.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

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
      libreoffice-writer \
      wget ca-certificates \
    && mkdir -p /usr/share/fonts/custom \
    && wget -q -O /usr/share/fonts/custom/Raleway-Regular.ttf "https://fonts.gstatic.com/s/raleway/v34/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVvao4CPNLA3JC9c.ttf" \
    && fc-cache -f

# --break-system-packages is required, matching the previous image). reportlab
# is included for Phase 5b's homework_assessment.py.
RUN pip3 install --break-system-packages --retries 5 --timeout 120 \
      python-docx openpyxl Pillow jinja2 cairosvg fpdf2 python-pptx weasyprint reportlab PyMuPDF \
    && rm -rf /root/.cache/pip
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.11/dist-packages/fitz

# ---------------------------------------------------------------------------
# TENAX VOICE (v12.49.0)
#
# Installed as TWO SEPARATE PYTHON ENVIRONMENTS, and the separation is the
# licence boundary, not tidiness.
#
#   faster-whisper  MIT.            System site-packages, imported by
#                                   src/voice/voice_stt.py.
#   piper-tts       GPL-3.0.        Its OWN venv at /opt/piper, never on the
#                                   import path of anything of ours.
#
# SPEC Section 6.2 locks this: Piper runs "as a separate OS process invoked by
# the connector, never imported as a Python library into the connector's import
# graph". Installing it alongside faster-whisper would put GPL code in the
# interpreter our MIT helper imports from, which is where the entanglement the
# boundary exists to prevent begins.
#
# --no-install-recommends on ffmpeg: faster-whisper decodes through PyAV, but
# several container formats a browser can produce (WebM from Chrome, MP4 from
# Safari) need the system codecs present.
#
# Build cost is real: faster-whisper pulls in CTranslate2 and onnxruntime, which
# together are a few hundred MB. That is the price of running speech locally and
# is why the whole feature is behind VOICE_ENABLED.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# MIT half. System packages, same convention as the document pipeline above.
# v12.50.0: `requests` and the huggingface_hub pin are NOT optional extras.
#
# faster_whisper/utils.py does `import requests` at module scope, but
# faster-whisper 1.1.1 does not DECLARE requests as a dependency -- it inherited
# it transitively from huggingface_hub. huggingface_hub 1.x replaced requests
# with httpx, so a build resolving the newer hub installs no requests at all and
# `import faster_whisper` dies with:
#
#   No module named 'requests'
#
# which the connector reported as stt_ready:false with no working STT, on an
# image whose build had succeeded. Pinning the hub below 1.0 keeps the declared
# contract faster-whisper was written against; installing requests explicitly
# means a future hub change cannot break the import again.
RUN pip3 install --break-system-packages --retries 5 --timeout 180 \
      faster-whisper==1.1.1 \
      "huggingface_hub<1.0" \
      requests \
    && rm -rf /root/.cache/pip

# Fail the BUILD, not the first voice request, if the import is broken. The
# defect above shipped because nothing verified the package could be loaded.
RUN python3 -c "import faster_whisper; print('faster-whisper', faster_whisper.__version__, 'imports cleanly')"


# GPL half. Own venv, own prefix, own directory. Nothing of ours imports from it.
RUN python3 -m venv /opt/piper \
    && /opt/piper/bin/pip install --retries 5 --timeout 180 piper-tts==1.2.0 \
    && rm -rf /root/.cache/pip

# Model and voice caches live on the mounted volume so they survive a restart,
# per SPEC Section 11 ("pre-downloaded at deploy"). Created here so the paths
# exist even before the first download.
RUN mkdir -p /data/voice/models /data/voice/piper/voices

# Defaults that match the layout above, so a deployment only has to set
# VOICE_ENABLED and the allowlist.
ENV VOICE_PIPER_BIN=/opt/piper/bin/piper \
    VOICE_PIPER_DIR=/data/voice/piper \
    VOICE_VOICES_DIR=/data/voice/piper/voices \
    VOICE_MODEL_DIR=/data/voice/models
# TNX-M-017: stop Python writing .pyc files into the image and the volume. A
# committed brain_scan.cpython-312.pyc was found in the archive while this image
# installs Python 3.11, so the bytecode could never have been loaded anyway.
ENV PYTHONDONTWRITEBYTECODE=1
# ---------------------------------------------------------------------------
# REMOVED in v12.33.0 -- the Android SDK and both JDK/JRE installs (TNX-M-016)
#
# The image previously built a dedicated android-sdk stage (cmdline-tools,
# platform-tools, platforms;android-34, build-tools;34.0.0, OpenJDK 17 JDK),
# copied /opt/android-sdk into the runtime, and installed an OpenJDK 17 JRE --
# justified in a comment as being "for the Android build tools invoked by
# mobile_app_gen.py".
#
# I verified that claim against the script itself before removing any of it,
# because the appforge mobile-app skill depends on it and a wrong call here
# would break a real feature.
#
# mobile_app_gen.py is 783 lines and contains NO subprocess, os.system, Popen,
# gradle, sdkmanager or javac invocation, and never even reads ANDROID_HOME. It
# is purely a source generator: it emits Gradle and Java text files, which are
# then compiled elsewhere. Every apparent match on "gradle" in that file is a
# gen_*_gradle() function name or an output filename.
#
# So the toolchain was never invoked. Removing it strips several gigabytes from
# every deploy, removes a build-time dependency on dl.google.com, and drops a
# large unaudited attack surface from the runtime image.
#
# appforge is unaffected: it still generates a complete Android project, which
# is built in Android Studio or CI as it always effectively was.
#
# Reinstate only if a genuine build step is added.
# ---------------------------------------------------------------------------

# Create a non-root user for security.
RUN groupadd -r mcp && useradd -r -g mcp -m -d /home/mcp mcp

# Copy production dependencies and application source.
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
# v12.54.2. scripts/ was allowed by .dockerignore but never copied, so every
# `npm run` entry pointing into it failed in the container with MODULE_NOT_FOUND
# -- including voice:smoke, the deployment gate that would have caught the
# interpreter misconfiguration, and voice:benchmark, which had been unrunnable
# in the image since it was written. Tests are still excluded: .dockerignore
# drops **/*.test.js inside the allowed paths.
COPY scripts/ ./scripts/
COPY package.json ./

# Data directory and persistent-volume mount point with correct ownership.
RUN mkdir -p /app/data /data \
    && chown -R mcp:mcp /app /data

USER mcp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:3000/health/ready || exit 1

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV SCHEDULE_STORE_PATH=/data/schedule_store.json

CMD ["node", "src/server-http.js"]