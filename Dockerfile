# Dockerfile
# Multi-stage build for claude-connector.
# Compatible with Railway, Render, Fly.io, Google Cloud Run, and any Docker host.
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

# Copy only what's needed
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

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

CMD ["node", "src/server-http.js"]
