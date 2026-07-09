# Multi-stage Dockerfile
# Stage 1: build everything in one Alpine environment (avoids native-module cross-stage issues)
FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ zip

# --- Backend ---
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/src ./src/
RUN npm run build

# --- Web ---
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY extension/manifest.json /tmp/ext-manifest.json
RUN node -e "const m=require('/tmp/ext-manifest.json');require('fs').writeFileSync('src/lib/extension-meta.js','export const EXTENSION_META = '+JSON.stringify({name:m.name,version:m.version})+';\n')"
RUN npm run build

# --- Extension zip ---
WORKDIR /pack
COPY extension/ ./extension/
RUN VERSION=$(node -e "console.log(require('./extension/manifest.json').version)") \
  && cd extension \
  && zip -r "/app/web/dist/downloads/marksync-extension-${VERSION}.zip" . -x "*.DS_Store" "docs/*" "CLAUDE.md" "TESTING.md" \
  && cp "/app/web/dist/downloads/marksync-extension-${VERSION}.zip" "/app/web/dist/downloads/marksync-extension-latest.zip"

# Stage 2: minimal runtime
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini

WORKDIR /app/backend
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/package.json ./

# web assets + extension downloads
COPY --from=builder /app/web/dist /app/web/dist

RUN mkdir -p data && chown -R node:node /app
USER node

RUN mkdir -p /app/web/dist/downloads && \
    ln -sf /app/web/dist/downloads /app/backend/downloads 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/backend/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
