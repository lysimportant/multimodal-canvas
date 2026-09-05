#!/usr/bin/env bash
# Linux/macOS Compose 运维入口：https 使用内部 CA，server 模式要求显式 HTTPS 域名。
# 用法：bash scripts/docker.sh [start|https|server|build|stop|status|admin EMAIL]
# 不安装全局软件、不改系统代理、不删除卷；任何失败均返回非零。
# 环境隔离只适用于脚本子进程；拒绝 source，避免改变调用者的环境及 shell 选项。
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  printf '%s\n' 'Run this script with bash instead of sourcing it.' >&2
  return 1
fi
set -euo pipefail

# profile 只由 action 决定，显式环境变量仍可配置端口；普通 Compose CLI 不受影响。
unset COMPOSE_PROFILES COMPOSE_ENV_FILES
export COMPOSE_DISABLE_ENV_FILE=true

# 校验十进制 TCP 端口；$1 为变量名，$2 为端口值，范围为 1..65535。
# 非法值返回非零，仅输出变量名，不回显环境变量内容或执行 Compose。
validate_port() {
  local name="$1" value="$2"
  [[ "$value" =~ ^[1-9][0-9]{0,4}$ ]] && (( value <= 65535 )) || {
    printf '%s must be an integer from 1 to 65535.\n' "$name" >&2
    return 1
  }
}

# 仅对启动动作增加端口校验，不改变查询和停止的既有行为。
action="${1:-start}"
case "$action" in
  start|https|server)
    export MC_HTTP_PORT="${MC_HTTP_PORT:-8080}"
    validate_port MC_HTTP_PORT "$MC_HTTP_PORT"
    ;;
esac
if [[ "$action" == https ]]; then
  export MC_HTTPS_PORT="${MC_HTTPS_PORT:-8443}"
  validate_port MC_HTTPS_PORT "$MC_HTTPS_PORT"
  if (( MC_HTTPS_PORT == MC_HTTP_PORT )); then
    printf '%s\n' 'MC_HTTPS_PORT must differ from MC_HTTP_PORT.' >&2
    exit 1
  fi
fi

# 定位仓库，避免从其它工作目录误操作同名 Compose 栈。
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
command -v docker >/dev/null || { printf '%s\n' 'Docker is required.' >&2; exit 1; }
docker compose version >/dev/null
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || {
  printf '%s\n' 'This stack requires Linux containers.' >&2
  exit 1
}

# 始终指定文件和项目，避免复用开发项目或环境中的 COMPOSE_FILE。
compose=(docker compose -f "$root/compose.yaml" -p multimodal-canvas-app)
case "$action" in
  start)
    "${compose[@]}" up --detach --wait --wait-timeout 240
    printf 'Web: http://localhost:%s\n' "$MC_HTTP_PORT"
    ;;
  https)
    "${compose[@]}" --profile local-https up -d --wait --wait-timeout 240
    printf 'Web: https://localhost:%s\n' "$MC_HTTPS_PORT"
    printf '%s\n' 'TLS: this endpoint uses an internal CA; the operator must explicitly trust its certificate on each client.'
    ;;
  server)
    : "${MC_DOMAIN:?Set MC_DOMAIN to the server public domain}"
    [[ "$MC_DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] || {
      printf '%s\n' 'MC_DOMAIN must be a DNS name, without scheme, port or path.' >&2
      exit 1
    }
    export MC_PUBLIC_ORIGIN="https://$MC_DOMAIN"
    "${compose[@]}" --profile server up --detach --wait --wait-timeout 240
    printf 'Web: https://%s\n' "$MC_DOMAIN"
    ;;
  build)
    "${compose[@]}" build
    ;;
  stop)
    "${compose[@]}" --profile server --profile local-https stop
    ;;
  status)
    "${compose[@]}" --profile server --profile local-https ps --all
    ;;
  admin)
    [[ $# -eq 2 && -n "$2" ]] || { printf '%s\n' 'Usage: bash scripts/docker.sh admin registered-email' >&2; exit 1; }
    "${compose[@]}" exec -T api node docker/run.mjs admin "$2"
    ;;
  *)
    printf '%s\n' 'Usage: bash scripts/docker.sh [start|https|server|build|stop|status|admin EMAIL]' >&2
    exit 1
    ;;
esac
