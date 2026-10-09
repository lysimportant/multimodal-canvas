#!/usr/bin/env bash
# Linux/macOS 运维入口；仅加载显式私有配置，不写环境文件、不删除卷。
# build 仅构建；start 启动并执行 migrate deploy；--neon 选择外部数据库，--server 启用 HTTPS。
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  printf '%s\n' '请使用 bash 运行本脚本，不要 source。' >&2
  return 1
fi
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
unset COMPOSE_PROFILES COMPOSE_ENV_FILES
export COMPOSE_DISABLE_ENV_FILE=1

action="${1:-start}"
if (( $# )); then shift; fi
environment_file='.env.compose'
neon=false
server=false
user_id=''
while (( $# )); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || exit 1; environment_file="$2"; shift 2 ;;
    --neon) neon=true; shift ;;
    --server) server=true; shift ;;
    *)
      if [[ "$action" == admin && -z "$user_id" && "$1" =~ ^[1-9][0-9]*$ ]]; then
        user_id="$1"; shift
      else
        printf '%s\n' '用法：bash scripts/docker.sh [build|start|stop|status|admin ID] [--env-file PATH] [--neon] [--server]' >&2
        exit 1
      fi
      ;;
  esac
done
case "$action" in build|start|stop|status|admin) ;; *) printf '%s\n' '不支持的操作。' >&2; exit 1 ;; esac
[[ -f "$environment_file" ]] || { printf '%s\n' '缺少配置，请复制 .env.compose.example 并填写 R2 与独立 New API。' >&2; exit 1; }
[[ -z "${DOCKER_HOST:-}" ]] || { printf '%s\n' '拒绝 DOCKER_HOST 覆盖，请使用本机 Docker context。' >&2; exit 1; }
docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
[[ "$docker_host" == unix:///* || "$docker_host" == npipe:////./pipe/* ]] || { printf '%s\n' '拒绝远程 Docker context。' >&2; exit 1; }
[[ "$(docker info --format '{{.OSType}}')" == linux ]] || { printf '%s\n' '必须使用 Linux containers。' >&2; exit 1; }

compose=(docker compose --env-file "$environment_file" -p multimodal-canvas-app -f compose.yaml)
if $neon; then compose+=(-f compose.neon.yaml); fi
if $server || [[ "$action" == stop || "$action" == status ]]; then compose+=(--profile server); fi
"${compose[@]}" config --quiet
case "$action" in
  build)
    "${compose[@]}" build
    printf '%s\n' '镜像构建完成，未启动服务或执行迁移。'
    ;;
  start)
    if $server; then
      domain=''
      public_origin=''
      while IFS='=' read -r name value; do
        case "$name" in
          MC_DOMAIN) domain="$value" ;;
          CANVAS_WEB_URL) public_origin="$value" ;;
        esac
      done < <("${compose[@]}" config --environment)
      if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ || "$public_origin" != "https://$domain" ]]; then
        printf '%s\n' 'server 模式要求 MC_DOMAIN 与 HTTPS CANVAS_WEB_URL 一致。' >&2
        exit 1
      fi
    fi
    "${compose[@]}" up -d --build --wait --wait-timeout 180
    "${compose[@]}" ps --all
    ;;
  stop) "${compose[@]}" stop; printf '%s\n' '服务已停止，数据和密钥卷保留。' ;;
  status) "${compose[@]}" ps --all ;;
  admin)
    [[ -n "$user_id" ]] || { printf '%s\n' 'admin 必须明确提供 New API 不可变用户 ID。' >&2; exit 1; }
    "${compose[@]}" exec -T api node docker/run.mjs admin "$user_id"
    ;;
esac
