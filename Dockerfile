# openbooks — production image (Next.js standalone + bundled bootstrap).
#
# Build:  docker build -t openbooks .
# Run:    use compose.yaml, which executes the privileged bootstrap as a
#         one-shot service before starting web/worker with an RLS-constrained
#         database role.

# --- deps: workspace-aware install ------------------------------------------
FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY schema/package.json schema/
COPY engine/package.json engine/
COPY web/package.json web/
COPY packages/analytics/package.json packages/analytics/
COPY packages/customization/package.json packages/customization/
COPY packages/forms-core/package.json packages/forms-core/
COPY packages/office/package.json packages/office/
COPY packages/pdf/package.json packages/pdf/
COPY packages/reports/package.json packages/reports/
COPY packages/ui/package.json packages/ui/
# npm resolves these workspace dependencies from repository-local, versioned
# tarballs. They must be present in the dependency layer before `npm ci`.
COPY vendor/appkit/ vendor/appkit/
RUN npm ci

# --- build: next standalone + bootstrap bundle -------------------------------
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd web && npx next build
RUN npx esbuild scripts/bootstrap.ts \
      --bundle --platform=node --format=esm \
      --external:pg-native \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/bootstrap.mjs
# The background worker (BullMQ consumers + schedulers) as a self-contained
# bundle, so the same image can run either the web server (default CMD) or the
# worker (command override in the compose `worker` service).
RUN npx esbuild engine/src/worker/index.ts \
      --bundle --platform=node --format=esm \
      --external:pg-native \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/worker.mjs

# --- runtime ------------------------------------------------------------------
FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS runtime
WORKDIR /app
ARG OPENBOOKS_VERSION=development
# HTML-authored reports and forms are printed by the shared Chromium renderer.
# Ship the renderer and deterministic multilingual fonts in the production
# image so PDF availability and typography never depend on the host machine.
# qpdf encrypts confidential record PDFs (pay stubs): neither renderer can
# write an encrypted file, so encryption is a post-processing pass. It is the
# one package here without a version pin — pin it to the distribution's
# current qpdf once that version is verified against this base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      chromium=151.0.7922.71-1~deb13u1 \
      qpdf \
      fonts-liberation=1:2.1.5-3 \
      fonts-noto-core=20201225-2 \
      fonts-noto-cjk=1:20240730+repack1-1 \
      fonts-noto-color-emoji=2.051-0+deb13u1 \
    && rm -rf \
      /var/lib/apt/lists/* \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
      /opt/yarn-* \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg
ENV NODE_ENV=production \
    OPENBOOKS_VERSION=${OPENBOOKS_VERSION} \
    NEXT_TELEMETRY_DISABLED=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# Standalone output is rooted at the monorepo (outputFileTracingRoot):
# node_modules + web/server.js + web/.next live inside it.
COPY --chown=node:node --from=build /app/web/.next/standalone ./
COPY --chown=node:node --from=build /app/web/.next/static ./web/.next/static
COPY --chown=node:node --from=build /out/bootstrap.mjs ./scripts/bootstrap.mjs
COPY --chown=node:node --from=build /out/worker.mjs ./scripts/worker.mjs
# The bootstrap reads migration SQL relative to its own location (/app/scripts → /app).
COPY --chown=node:node schema/migrations ./schema/migrations

EXPOSE 3000
# Database bootstrap is intentionally not part of this process: the web server
# must never receive migration-owner credentials.
USER node
CMD ["node", "web/server.js"]
