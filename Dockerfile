# Dockerfile
# Multi-stage build for claude-connector.
# Compatible with Railway, Render, Fly.io, Google Cloud Run, and any Docker host.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

# Create a non-root user for security
RUN addgroup -S mcp && adduser -S mcp -G mcp

# Copy only what's needed
COPY --from=deps /app/node_modules ./node_modules
COPY src/ ./src/
COPY package.json ./

# Create data directory with correct ownership
RUN mkdir -p /app/data && chown -R mcp:mcp /app

USER mcp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3000/health || exit 1

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", "src/server-http.js"]
