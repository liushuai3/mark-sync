FROM node:22-alpine AS builder
RUN apk add --no-cache python3 make g++ zip
WORKDIR /app

# Backend deps + build
COPY backend/package*.json /app/backend/
RUN cd /app/backend && npm ci --no-audit --no-fund
COPY backend/tsconfig.json backend/src /app/backend/src/
RUN cd /app/backend && npm run build

# Web build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY extension/manifest.json /tmp/ext-manifest.json
RUN node -e "const m=require('/tmp/ext-manifest.json');require('fs').writeFileSync('src/lib/extension-meta.js','export const EXTENSION_META = '+JSON.stringify({name:m.name,version:m.version})+';\n')"
RUN npm run build

# Extension zip
RUN cd /app/extension \
  && VERSION=$(node -e "console.log(require('/tmp/ext-manifest.json').version)") \
  && mkdir -p /app/web/dist/downloads \
  && zip -r "/app/web/dist/downloads/marksync-extension-${VERSION}.zip" . -x "*.DS_Store" "docs/*" "CLAUDE.md" "TESTING.md" \
  && cp "/app/web/dist/downloads/marksync-extension-${VERSION}.zip" "/app/web/dist/downloads/marksync-extension-latest.zip"

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app/backend
COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/node_modules ./node_modules
COPY --from=builder /app/backend/package.json ./
COPY --from=builder /app/web/dist /app/web/dist
RUN mkdir -p data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
VOLUME ["/app/backend/data"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
