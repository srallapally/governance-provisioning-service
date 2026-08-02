# syntax=docker/dockerfile:1
#
# Multi-stage build. `runtime` (the default target) is what a real
# deployment ships: a non-root, dev-dependency-free image with connector
# bundles baked in at build time (immutable, versioned deploys -- decided
# alongside docs/DEPLOYMENT_PLAN.md's k8s design, not chosen ad hoc here).
#
# `deps` is also used directly by docker-compose.yml's `jwks` service (the
# local-dev-only JWT issuer, see scripts/dev-auth.ts) -- it already has every
# dev dependency (tsx, jose) installed, so that service needs no Dockerfile
# of its own.
#
# No native modules in this dependency tree (pure-JS pg driver, no
# pg-native), so alpine costs nothing here and buys a much smaller image.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.test.json ./
COPY src/ ./src/
RUN npm run build

# docker/connector-bundles/ is a placeholder, empty on purpose -- this repo
# doesn't own any real bundle. A real deployment replaces its contents with
# real bundles before running `docker build` (see that directory's own
# README for why this can't just be a build ARG pointing elsewhere: COPY
# can never reach outside the build context, regardless of what a --build-arg
# value says, so an external directory has to be brought inside the context
# first -- there's no way around that).
FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker/connector-bundles/ ./connector-bundles/

ENV NODE_ENV=production \
    PORT=3000 \
    CONNECTOR_BUNDLE_DIR=/app/connector-bundles

USER app
EXPOSE 3000

# node's own fetch, not curl/wget -- keeps the image free of an extra
# package just for this. /healthz needs no bearer token (see
# src/http/healthRoutes.ts) and never touches the store, so this only ever
# reports "is the process alive," matching what a Dockerfile HEALTHCHECK
# (no readiness concept) should ask.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
