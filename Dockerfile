# Dockerfile
# Multi-stage build for claude-connector.
# Compatible with Railway, Render, Fly.io, Google Cloud Run, and any Docker host.
#
# v7.1 — Document scripts v2.1.0 (Fable)
#   - Added font-carlito, font-liberation, font-noto so theme presets resolve
#   - Added pypdf (replaces deprecated PyPDF2 for edit_pdf.py)
#   - Added XDG_CACHE_HOME so WeasyPrint font cache is writable by non-root user
#   - Removed duplicated COPY layers from v7.0
#
# v7.0 NOTES:
#   - Added nodemailer / node-cron / luxon for SCOPE-01/03/04/05
#   - Schedule store path defaults to /data/schedule_store.json. On Railway,
#     attach a persistent volume mounted at /data so scheduled sends survive
#     redeployments. Override with SCHEDULE_STORE_PATH if you mount elsewhere.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app

# Create a non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp

# Copy application code (single pass — v7.0 had duplicate COPY layers)
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Install Python and document generation dependencies
USER root
# 1. Install system dependencies, base fonts, emoji support, and download Raleway
RUN apk add --no-cache \
    python3 py3-pip py3-cairo pango gdk-pixbuf libffi fontconfig \
    ttf-dejavu font-noto-emoji font-carlito font-liberation font-noto \
    wget && \
    mkdir -p /usr/share/fonts/custom && \
    wget -q -O /usr/share/fonts/custom/Raleway-Regular.ttf \
      "https://fonts.gstatic.com/s/raleway/v34/1Ptxg8zYS_SKggPN4iEgvnHyvveLxVvao4CPNLA3JC9c.ttf" && \
    fc-cache -f

# 2. Install Python packages
RUN pip3 install --break-system-packages --retries 5 --timeout 120 \
    python-docx openpyxl Pillow jinja2 cairosvg fpdf2 python-pptx \
    weasyprint PyMuPDF pypdf && \
    rm -rf /root/.cache/pip

# Create data directory and schedule store mount point with correct ownership
RUN mkdir -p /app/data /data && chown -R mcp:mcp /app /data

USER mcp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3000/health || exit 1

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV SCHEDULE_STORE_PATH=/data/schedule_store.json
# Ensure WeasyPrint / fontconfig cache is writable by the non-root user
ENV XDG_CACHE_HOME=/data/.cache

CMD ["node", "src/server-http.js"]