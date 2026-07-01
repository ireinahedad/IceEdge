# ── Stage 1 : build TypeScript ────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY package*.json ./
RUN npm ci

# Compiler TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Stage 2 : image de production ─────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Dépendances production uniquement
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copier le build compilé
COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/server.js"]
