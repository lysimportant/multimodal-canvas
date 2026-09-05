# 正式产物与运行依赖分离；不复制主机依赖、.env 或已有业务数据。
FROM node:24.12.0-bookworm-slim AS base
COPY docker/debian.sources /etc/apt/sources.list.d/debian.sources
# slim 镜像未带系统 CA；先用 Node 内置可信根引导 HTTPS，再安装系统 CA。
RUN node -e "require('node:fs').writeFileSync('/tmp/node-ca.crt',require('node:tls').rootCertificates.join('\n'))" \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::https::CaInfo=/tmp/node-ca.crt update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 -o Acquire::https::CaInfo=/tmp/node-ca.crt install --no-install-recommends --yes ca-certificates openssl ffmpeg \
    && rm -rf /var/lib/apt/lists/* /tmp/node-ca.crt
WORKDIR /app

FROM base AS build
ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}/node_modules/.bin:${PATH}
RUN npm install --prefix /opt/pnpm --no-audit --no-fund pnpm@11.19.0
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/credential-crypto/package.json ./packages/credential-crypto/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/observability/package.json ./packages/observability/package.json
COPY packages/providers/package.json ./packages/providers/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
COPY turbo.json tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/build-runtime.mjs ./scripts/build-runtime.mjs
COPY scripts/docker/prepare-prisma.mjs ./scripts/docker/prepare-prisma.mjs
# 浏览器统一访问同源 /v1，不把容器内部地址或凭据编译进静态文件。
ENV VITE_API_BASE_URL=""
RUN pnpm db:generate && pnpm exec turbo run build --env-mode=loose && pnpm build:runtime \
    && pnpm --filter @multimodal-canvas/api deploy --legacy --prod /out/api \
    && pnpm --filter @multimodal-canvas/worker deploy --legacy --prod /out/worker \
    && node scripts/docker/prepare-prisma.mjs /out/api /out/worker

FROM base AS initialize
COPY scripts/docker/init.mjs /app/init.mjs
CMD ["node", "init.mjs"]

# 迁移只使用新 Compose 项目专用数据库，保留正式迁移历史，不执行 db push/reset。
FROM build AS migrate
COPY scripts/docker/runtime.mjs scripts/docker/run.mjs /workspace/docker/
ENV NODE_ENV=production
CMD ["node", "docker/run.mjs", "migrate"]

FROM base AS api
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/api /app
COPY --chown=node:node scripts/docker/runtime.mjs scripts/docker/run.mjs scripts/docker/health.mjs scripts/docker/admin.mjs /app/docker/
USER node
EXPOSE 3000
CMD ["node", "docker/run.mjs", "api"]

FROM base AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /out/worker /app
COPY --chown=node:node scripts/docker/runtime.mjs scripts/docker/run.mjs scripts/docker/health.mjs /app/docker/
USER node
CMD ["node", "docker/run.mjs", "worker"]

FROM caddy:2.10.2-alpine AS web
COPY --from=build /workspace/apps/web/dist /usr/share/caddy
COPY docker/Web.Caddyfile /etc/caddy/Caddyfile
COPY docker/logging.caddy /etc/caddy/logging.caddy
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
