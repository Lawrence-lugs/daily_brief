# syntax=docker/dockerfile:1
#
# daily-brief container image.
# Build context: project root (..).  Build with: docker build -f container/Dockerfile .
#
# Stage 1: production dependencies only. Omits devDependencies (electron,
# electron-builder, playwright, jsdom).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: runtime image.
FROM node:22-slim
WORKDIR /app

# tini as PID 1 (signal forwarding), ca-certificates for outbound TLS fetches.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Unprivileged user. Data and model-cache dirs are owned by it; named volumes inherit this ownership on first mount.
RUN groupadd -r brief && useradd -m -r -g brief -s /bin/sh brief \
    && mkdir -p /app/data /app/.cache/hf \
    && chown -R brief:brief /app/data /app/.cache

ENV NODE_ENV=production \
    BRIEF_HOST=0.0.0.0 \
    BRIEF_BASE_PATH=/dailydie \
    BRIEF_PORT=4873 \
    BRIEF_DATA_DIR=/app/data \
    TZ=Asia/Shanghai \
    HF_HOME=/app/.cache/hf

EXPOSE 4873

# Production dependencies.
COPY --from=deps /app/node_modules ./node_modules

# Writable model cache for @huggingface/transformers (it caches inside its own package dir).
RUN mkdir -p /app/node_modules/@huggingface/transformers/.cache \
    && chown -R brief:brief /app/node_modules/@huggingface/transformers/.cache

# Application files.
COPY package.json ./
COPY server/ ./server/
COPY ranker/ ./ranker/
COPY scripts/ ./scripts/
COPY src/ ./src/
COPY schema.sql prompt_system.md tailwind.css ./
# Default config templates (tracked in user/defaults). Seeded into /app/data on first start
# only (see user/datadir.js -> seedDataDir); user edits in the volume are kept.
COPY user/defaults/config.json ./user/defaults/config.json
COPY user/defaults/sources.json ./user/defaults/sources.json
COPY user/defaults/perfect_samples.json ./user/defaults/perfect_samples.json
# Backwards-compat: the container's config.json is the runtime config; copy the container
# override over the default so the container behaves as before.
COPY container/config.container.json ./config.json
# Default perfect samples. Seeded into /app/data on first start only; user edits in the volume are kept.
COPY container/defaults/perfect_samples.json ./perfect_samples.json
COPY container/scheduler/entrypoint.sh ./scheduler/entrypoint.sh

USER brief

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
