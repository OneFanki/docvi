#!/bin/sh
# 容器入口：装配 git 凭证（PRD R1）后启动 deployer。
# GIT_CREDENTIALS 由部署方以 secret/env 注入，形如：
#   https://user:token@git.example.com
# 可多行（多个远端）。凭证只写进容器用户 home 的 credential store，
# 不进镜像层、不写数据卷、任何 API 不回显。
set -e

if [ -n "$GIT_CREDENTIALS" ]; then
  mkdir -p "$HOME"
  printf '%s\n' "$GIT_CREDENTIALS" > "$HOME/.git-credentials"
  chmod 600 "$HOME/.git-credentials"
  git config --global credential.helper store
  echo "[entrypoint] git 凭证已装配"
fi

exec node deployer/bin/deployer.mjs
