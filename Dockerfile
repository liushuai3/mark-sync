# Multi-stage Dockerfile: build web + backend, then run in a fresh runtime.
FROM node:22-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package*.json ./
COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app/backend
# native deps need build tooling for install; discard after
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && apk add --no-cache tini
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
  && apk del .build-deps

COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=web-builder /app/web/dist /app/web/dist

RUN mkdir -p data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
VOLUME ["/app/backend/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
