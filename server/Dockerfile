# ── Stage 1 : build TypeScript ────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY package*.json ./
RUN npm ci

# Compiler TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2 : image de production ─────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

# tini = minimal init: reaps zombies and, crucially, forwards SIGTERM/SIGINT to
# Node so the graceful-shutdown handler in server.ts actually runs on deploys.
RUN apk add --no-cache tini

# Dépendances production uniquement
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copier le build compilé (owned by the non-root `node` user baked into the image)
COPY --from=builder --chown=node:node /app/dist ./dist

# Drop root — a compromised process shouldn't run as uid 0.
USER node

EXPOSE 3001

# Container-level liveness probe (independent of the orchestrator's own checks).
# Uses busybox wget (present in alpine); hits the dependency-free /health route.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# tini as PID 1 → signals reach Node.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
