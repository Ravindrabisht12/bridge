FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY workers/catalogue-sync/package.json workers/catalogue-sync/package.json
COPY packages/ packages/
RUN npm ci --ignore-scripts
COPY apps/api/ apps/api/
COPY workers/catalogue-sync/ workers/catalogue-sync/
RUN npm run build:api && npm run build:worker

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN mkdir -p /app/assets && chown node:node /app/assets
USER node
EXPOSE 8787
CMD ["node", "apps/api/dist/server.mjs"]
