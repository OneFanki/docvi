# docvi 部署镜像：平台 + deployer 单容器（PRD R1）。
# 平台版本即镜像 tag（PRD R15）——升级 = pull 新镜像重启，不在容器内原地改代码。
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# pnpm 版本显式钉住：corepack 未固定版本时会去请求 registry 的 `/pnpm/latest`
# 来探测默认版本，该端点被限流（HTTP 429）时构建直接失败——2026-10-20 实测踩到。
# 固定版本后 corepack 只下载该版本 tarball，不再探测 latest。
ARG PNPM_VERSION=12.10.1

# 平台依赖（层缓存友好：先拷清单装依赖，再拷源码）。
# pnpm-workspace.yaml 必须一起拷：onlyBuiltDependencies（esbuild 构建审批）与
# shamefullyHoist 都在它里面，缺了会导致 esbuild 二进制装不上、vite 构建失败。
#
# ⚠️ 各工作区子包的 package.json 也必须先进来：只拷根清单时 pnpm 只装根依赖，
# `packages/editor` 的 @codemirror/* 一个都不会装，构建 web 产物时才报
# 「Rollup failed to resolve import @codemirror/state」（2026-10-24 实测）。
#
# 用逐行列举而不是 `COPY --parents` 通配：后者需要 Dockerfile 1.7 语法（构建前端
# 版本太旧会直接 `unknown flag: --parents` 而失败，GitHub Actions runner 实测踩到），
# 且会随包数量变化悄悄漏拷。新增工作区包时**必须在这里加一行**，否则容器构建
# 会缺该包的依赖。
#
# ELECTRON_SKIP_BINARY_DOWNLOAD：apps/desktop 的 devDependencies 声明了 electron
# （桌面宿主），容器只需要其中的 vite / vue 来构建 web 产物。不跳过的话 postinstall
# 会去下载 100MB+ 的 Electron 运行时，容器里永远用不上，还容易在受限网络下超时。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json ./apps/desktop/
COPY packages/editor/package.json ./packages/editor/
COPY packages/plugin-api/package.json ./packages/plugin-api/
COPY packages/plugin-runtime/package.json ./packages/plugin-runtime/
COPY packages/renderer-core/package.json ./packages/renderer-core/
COPY packages/server/package.json ./packages/server/
COPY packages/shared/package.json ./packages/shared/
COPY plugins/audio/package.json ./plugins/audio/
COPY plugins/base/package.json ./plugins/base/
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && pnpm install --frozen-lockfile

COPY . .

# 前端资产两条产物链：
#  1. 预设插件包（plugins/*/dist）——协议 v1 的 dist/index.js + dist/style.css，
#     deployer 经 /plugins/<name>/<version>/ 伺服；
#  2. app 渲染层的 web 变体（apps/desktop/dist-web）——容器站点伺服的全部 UI，
#     与桌面端同一份源码，宿主由渲染层的 web-host.ts 提供（无 preload）。
RUN node scripts/build-plugins.mjs \
    && pnpm --filter @docvi/desktop exec vite build --config vite.web.config.ts

# deployer 依赖（独立小包，仅 yaml 一个直接依赖）
WORKDIR /app/deployer
COPY deployer/package.json deployer/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

WORKDIR /app
COPY deployer/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
# 容器本地时间（清理 cron 与日志按此解释；compose 可用 TZ 环境变量覆盖）
ENV TZ=Asia/Shanghai
EXPOSE 8080
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
