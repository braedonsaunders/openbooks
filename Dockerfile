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
COPY packages/emails/package.json packages/emails/
COPY packages/forms-core/package.json packages/forms-core/
COPY packages/jobs/package.json packages/jobs/
COPY packages/networking/package.json packages/networking/
COPY packages/office/package.json packages/office/
COPY packages/pdf/package.json packages/pdf/
COPY packages/reports/package.json packages/reports/
COPY packages/ui/package.json packages/ui/
RUN npm ci

# --- build: next standalone + bootstrap bundle -------------------------------
FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd web && NODE_OPTIONS=--max-old-space-size=6144 npx next build --webpack
RUN npx esbuild scripts/bootstrap.ts \
      --bundle --platform=node --format=esm \
      --external:pg-native \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/bootstrap.mjs
# The background worker (BullMQ consumers + schedulers) as a self-contained
# bundle, so the same image can run either the web server (default CMD) or the
# worker (command override in the compose `worker` service). The bundle source
# is the process composition entry (scripts/worker-entry.ts), which registers
# worker-composed duties such as the automation tick before booting
# the worker. Duty registration stays in composition so the worker module
# keeps its declared dependencies and the engine module graph remains acyclic.
RUN npx esbuild scripts/worker-entry.mts \
      --bundle --platform=node --format=esm --conditions=react-server --tsconfig=web/tsconfig.json \
      --external:pg-native --external:jsdom \
      --banner:js="import { createRequire as openbooksCreateRequire } from 'node:module'; const require = openbooksCreateRequire(import.meta.url);" \
      --outfile=/out/worker.mjs
RUN node --check /out/worker.mjs
# Deterministic master demos are prepared explicitly by installation operators.
# The same source is used by the setup wizard when a master is not yet present.
RUN npx esbuild engine/src/sample-companies/cli.ts \
      --bundle --platform=node --format=esm \
      --external:pg-native --external:jsdom \
      --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
      --outfile=/out/sample-companies.mjs
RUN node --check /out/sample-companies.mjs

# --- PDF renderer: verified native browser archive -----------------------------
FROM deps AS pdf-verification
COPY scripts/verify-pdf-browser.mjs ./scripts/
RUN npx esbuild scripts/verify-pdf-browser.mjs \
      --bundle --platform=node --format=esm \
      --banner:js="import { createRequire as openbooksPdfCreateRequire } from 'node:module'; const require = openbooksPdfCreateRequire(import.meta.url);" \
      --outfile=/out/verify-pdf-browser.mjs

FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS pdf-browser
ARG TARGETARCH
WORKDIR /browser-install
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates unzip
COPY scripts/pdf-browser.json scripts/install-pdf-browser.mjs ./
RUN node install-pdf-browser.mjs "$TARGETARCH" /opt/chromium

# --- runtime ------------------------------------------------------------------
FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d AS runtime-base
WORKDIR /app
ARG OPENBOOKS_VERSION=development
# HTML-authored reports and forms are printed by the shared Chromium renderer.
# Ship the renderer and deterministic multilingual fonts in the production
# image so PDF availability and typography never depend on the host machine.
# qpdf encrypts confidential record PDFs (pay stubs): neither renderer can
# write an encrypted file, so encryption is a post-processing pass. The browser
# uses Google's versioned native releases, checksum-pinned for both supported
# architectures; the fonts stay pinned for deterministic typography.
# The renderer runs sandboxed by default (packages/pdf/src/browser-pool.ts)
# even though this image runs as non-root node: Chrome sandboxes via
# unprivileged user namespaces, which needs no root. Swarm's default seccomp
# profile denies the unshare the sandbox needs, so there the launch falls
# back to --no-sandbox with a warning (or set OPENBOOKS_CHROMIUM_NO_SANDBOX=1
# to skip the doomed first attempt); the child environment is scrubbed of
# secrets either way.
RUN apt-get update \
    # Base-image security rot: the node:24-trixie-slim digest still ships
    # util-linux 2.41-5 (CVE-2026-53615, fixed in 2.41.5-0+deb13u1) and no
    # rebuilt base exists yet. Upgrade only the already-installed packages so
    # OS security fixes land without disturbing the pinned font set below.
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
      libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 \
      libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
      libgtk-3-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
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
COPY --from=pdf-browser /opt/chromium /opt/chromium
RUN ln -s /opt/chromium/chrome /usr/bin/chromium
COPY --chown=node:node scripts/pdf-browser.json ./scripts/
COPY --chown=node:node --from=pdf-verification /out/verify-pdf-browser.mjs ./scripts/verify-pdf-browser.mjs
RUN su -s /bin/sh node -c 'node scripts/verify-pdf-browser.mjs'

FROM runtime-base AS runtime
# Standalone output is rooted at the monorepo (outputFileTracingRoot):
# node_modules + web/server.js + web/.next live inside it.
COPY --chown=node:node --from=build /app/web/.next/standalone ./
COPY --chown=node:node --from=build /app/web/.next/static ./web/.next/static
COPY --chown=node:node --from=build /out/sample-companies.mjs ./scripts/sample-companies.mjs
COPY --chown=node:node --from=build /out/bootstrap.mjs ./scripts/bootstrap.mjs
COPY --chown=node:node --from=build /out/worker.mjs ./scripts/worker.mjs
# The bootstrap reads migration SQL relative to its own location (/app/scripts → /app).
COPY --chown=node:node schema/migrations ./schema/migrations
RUN set -eu; \
    output=$(node scripts/worker.mjs 2>&1) && { echo "worker unexpectedly started without database credentials" >&2; exit 1; }; \
    printf '%s' "$output" | grep -Fq 'OPENBOOKS_BYPASS_DB_URL must name the dedicated BYPASSRLS login'
RUN NODE_ENV=test OPENBOOKS_DB_URL= node --conditions=react-server --input-type=module \
    -e "const entry = await import('./scripts/worker.mjs'); const transfer = await entry.loadDataTransferWorker(); if (typeof transfer.startDataTransferWorker !== 'function') throw new Error('Transfer worker startup did not load'); console.log('Deferred transfer runtime verified');"

EXPOSE 3000
# Database bootstrap is intentionally not part of this process: the web server
# must never receive migration-owner credentials.
USER node
CMD ["node", "web/server.js"]
