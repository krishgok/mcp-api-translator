# syntax=docker/dockerfile:1.7
# Multi-stage build: tsup compiles TS in a full node image, then we ship a
# distroless runtime that only has node + prod deps. Result is small and has
# no shell, apt, or package manager on the runtime image.

FROM node:20-alpine AS build
WORKDIR /app

# Install with the lockfile first so subsequent source changes stay cache-friendly.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Drop devDependencies so the runtime stage only carries what dist/ imports.
RUN npm prune --omit=dev

FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY LICENSE NOTICE ./

# Distroless nodejs images set ENTRYPOINT=["/nodejs/bin/node"]; CMD supplies the script.
CMD ["dist/index.js"]
