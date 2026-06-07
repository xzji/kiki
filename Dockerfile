FROM node:20-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production
ENV KIKI_DATA_DIR=/data
ENV KIKI_ORCHESTRATOR_MODE=cloud
ENV KIKI_LOCAL_CLI_ONLY=true
ENV KIKI_DISABLE_DEV_ROUTES=true
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

CMD ["pnpm", "start:production"]
