# TikTok Reader - Production Dockerfile (multi-stage)

# ---- build stage ----
FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ---- runtime stage ----
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Issue #2782 (AGPL 対応ソース案内): ライセンス・NOTICE・ソース案内と、本番依存の
# ライセンス表示を runtime image に含める。
COPY LICENSE NOTICE SOURCE.md ./
COPY scripts/generate-third-party-notices.mjs ./scripts/generate-third-party-notices.mjs
RUN node scripts/generate-third-party-notices.mjs > THIRD_PARTY_NOTICES.txt \
  && rm -r scripts

# ビルドステージから成果物のみコピー
COPY --from=builder /app/dist ./dist

# 稼働中のイメージと対応ソースを結び付ける識別子。GET /source が返す。
# 例: docker build --build-arg SOURCE_COMMIT=<SHORT_SHA> .
ARG SOURCE_COMMIT=unknown
ARG TIKTOK_READER_SOURCE_URL=
LABEL org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.source="${TIKTOK_READER_SOURCE_URL}"
ENV NODE_ENV=production \
    SOURCE_COMMIT=${SOURCE_COMMIT} \
    TIKTOK_READER_SOURCE_URL=${TIKTOK_READER_SOURCE_URL}

EXPOSE 8472

CMD ["node", "dist/server.js"]
