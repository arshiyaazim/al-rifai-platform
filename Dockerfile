# AL-RIFA'I Platform — production image
#
# Two processes run from this one image:
#   app   node deploy/tls-entry.mjs        Next.js + TLS
#   sync  node scripts/sync-worker.mjs     WhatsApp store importer/tailer
FROM node:22-bookworm-slim AS toolchain
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN npm install --global pnpm@11.25.0
WORKDIR /app

FROM toolchain AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm typecheck && pnpm build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=127.0.0.1
WORKDIR /app
RUN groupadd --gid 10001 alrifai && useradd --uid 10001 --gid 10001 --no-create-home alrifai

COPY --from=build --chown=10001:10001 /app/.next/standalone ./
COPY --from=build --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=build --chown=10001:10001 /app/public ./public
COPY --from=build --chown=10001:10001 /app/deploy ./deploy
COPY --from=build --chown=10001:10001 /app/scripts/sync-worker.mjs ./scripts/sync-worker.mjs

USER 10001:10001
EXPOSE 3000 3443
CMD ["node", "deploy/tls-entry.mjs"]
