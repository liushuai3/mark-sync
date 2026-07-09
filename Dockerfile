# 优化后 Dockerfile - 合并 npm install 减少网络请求
# 关键: 一次 npm ci 装 backend + archiver, 省 ~70s

FROM node:22-bookworm-slim AS builder

# ==== Backend (含 archiver) ====
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc
RUN npm install --no-save --no-audit --no-fund archiver@7

# ==== Web ====
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
COPY extension/manifest.json /tmp/ext-manifest.json
RUN node -e "const m=require('/tmp/ext-manifest.json');require('fs').writeFileSync('src/lib/extension-meta.js','export const EXTENSION_META = '+JSON.stringify({name:m.name,version:m.version})+';\n')"
RUN npm run build

# ==== Extension zip ====
COPY extension /app/extension
COPY scripts/zip-extension.cjs /tmp/zip-extension.cjs
RUN mkdir -p /app/web/dist/downloads \
  && SRC=/app/extension \
     OUT=/app/web/dist/downloads/marksync-extension-latest.zip \
     NODE_PATH=/app/backend/node_modules \
     node /tmp/zip-extension.cjs \
  && cp /app/extension/popup/help.html /app/web/dist/help.html

# 清理 archiver
RUN cd /app/backend && npm prune --omit=dev

# ==== Runtime ====
FROM node:22-bookworm-slim AS runtime
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
CMD ["node", "dist/index.js"]
