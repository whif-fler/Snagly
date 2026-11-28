# syntax=docker/dockerfile:1.7
# Multi-stage image: no build tools or npm caches in the runtime layer.
FROM node:26-bookworm-slim AS deps

WORKDIR /app
ENV NODE_ENV=production

# Copy only workspace manifests first so dependency installation is cacheable.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/download-engine/package.json packages/download-engine/package.json
COPY packages/library/package.json packages/library/package.json
COPY packages/media/package.json packages/media/package.json
COPY packages/platform/package.json packages/platform/package.json
COPY packages/storage/package.json packages/storage/package.json

# There are no runtime npm dependencies today; this keeps the lockfile honest
# and installs workspace links if any are added later.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-bookworm-slim AS tools

ARG YTDLP_VERSION=2026.11.23
ARG TARGETARCH

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Download the pinned standalone binary and verify it against the release
# checksum before it enters the runtime image.
RUN set -eux; \
  case "${TARGETARCH:-amd64}" in \
    amd64) asset="yt-dlp_linux" ;; \
    arm64) asset="yt-dlp_linux_aarch64" ;; \
    *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}"; \
  curl -fsSLo "/tmp/${asset}" "${base}/${asset}"; \
  curl -fsSLo /tmp/SHA2-256SUMS "${base}/SHA2-256SUMS"; \
  cd /tmp; \
  grep " ${asset}\$" SHA2-256SUMS | sha256sum -c -; \
  install -m 0755 "/tmp/${asset}" /usr/local/bin/yt-dlp; \
  /usr/local/bin/yt-dlp --version

FROM node:26-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=tools /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=deps /app/node_modules ./node_modules

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

# Fingerprint the web assets so a deploy can never pair a fresh index.html
# with a stale cached app.js/styles.css. Only the hashed names are cached.
RUN set -eu; \
  cd /app/apps/web/public; \
  JS_HASH=$(sha256sum app.js | cut -c1-12); \
  CSS_HASH=$(sha256sum styles.css | cut -c1-12); \
  mv app.js "app.${JS_HASH}.js"; \
  mv styles.css "styles.${CSS_HASH}.css"; \
  for page in index.html privacy.html; do \
    sed -i "s|href=\"/styles.css\"|href=\"/styles.${CSS_HASH}.css\"|; s|src=\"/app.js\"|src=\"/app.${JS_HASH}.js\"|" "$page"; \
    grep -q "styles.${CSS_HASH}.css" "$page"; \
  done; \
  grep -q "app.${JS_HASH}.js" index.html; \
  ! grep -q 'href="/styles.css"' privacy.html

ENV NODE_ENV=production \
  SNAGLY_MODE=cloud \
  SNAGLY_HOST=0.0.0.0 \
  SNAGLY_PORT=4174 \
  SNAGLY_DATA_DIR=/data \
  SNAGLY_WEB_DIR=/app/apps/web/public \
  SNAGLY_MEDIA_ENGINE=real \
  SNAGLY_YTDLP_PATH=/usr/local/bin/yt-dlp \
  SNAGLY_FFMPEG_PATH=/usr/bin/ffmpeg \
  HOME=/tmp

RUN mkdir -p /data \
  && chown -R node:node /data /app

USER node

EXPOSE 4174
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4174/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/src/main.js"]
