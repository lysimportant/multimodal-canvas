#!/usr/bin/env bash
# Applied on the server after the archive SHA-256 was verified. Keep .env.compose and volumes intact.
set -euo pipefail
umask 077

archive_name="${1:?archive name required}"
database_mode="${2:?database mode required}"
gateway_mode="${3:?gateway mode required}"
release_id="${4:?release id required}"
project='/opt/multimodal-canvas'
cd "$project"

[[ "$archive_name" =~ ^\.incoming-[0-9]{14}-[a-f0-9]{8}\.tar\.gz$ ]] || { echo 'Invalid archive name.' >&2; exit 1; }
[[ "$release_id" =~ ^[0-9]{14}-[a-f0-9]{8}$ ]] || { echo 'Invalid release id.' >&2; exit 1; }
[[ "$database_mode" =~ ^(Auto|Local|Neon)$ ]] || { echo 'Invalid database mode.' >&2; exit 1; }
[[ "$gateway_mode" =~ ^(Auto|On|Off)$ ]] || { echo 'Invalid gateway mode.' >&2; exit 1; }
[[ -f .env.compose ]] || { echo 'Server .env.compose is missing; no server settings were replaced.' >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || { echo 'Server must be x86_64.' >&2; exit 1; }
[[ -z "${DOCKER_HOST:-}" ]] || { echo 'DOCKER_HOST must be unset on the server.' >&2; exit 1; }
docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
[[ "$docker_host" == unix:///* ]] || { echo 'Server Docker context must use a local Unix socket.' >&2; exit 1; }
docker info >/dev/null

services="$(docker ps -a --filter 'label=com.docker.compose.project=multimodal-canvas-app' --format '{{.Label "com.docker.compose.service"}}')"
has_service() { grep -Fxq "$1" <<< "$services"; }

existing_database=''
if has_service api; then
  api_container="$(docker ps -a --filter 'label=com.docker.compose.project=multimodal-canvas-app' --filter 'label=com.docker.compose.service=api' --format '{{.ID}}' | head -n 1)"
  api_environment="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$api_container")"
  if grep -q '^DATABASE_URL=.' <<< "$api_environment"; then existing_database=Neon
  else existing_database=Local
  fi
  unset api_environment
elif has_service postgres; then existing_database=Local
fi

if [[ "$database_mode" == Auto ]]; then
  if [[ -n "$existing_database" ]]; then database_mode="$existing_database"
  else echo 'Cannot identify the existing database mode; run with -Database Local or -Database Neon.' >&2; exit 1
  fi
fi
if [[ "$gateway_mode" == Auto ]]; then
  if has_service gateway; then gateway_mode=On
  elif has_service web; then gateway_mode=Off
  else echo 'Cannot identify the existing gateway mode; run with -Gateway On or -Gateway Off.' >&2; exit 1
  fi
fi

if [[ -n "$existing_database" && "$database_mode" != "$existing_database" ]]; then
  echo "Existing application uses $existing_database; refusing a database-mode switch." >&2; exit 1
fi

stage="$(mktemp -d "$project/.deploy-staging.XXXXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
tar -xzf "$archive_name" -C "$stage" compose.yaml compose.neon.yaml docker scripts

unset COMPOSE_ENV_FILES
export COMPOSE_DISABLE_ENV_FILE=1 COMPOSE_PROFILES=''
preview=(docker compose --env-file "$project/.env.compose" -p multimodal-canvas-app -f "$stage/compose.yaml")
if [[ "$database_mode" == Neon ]]; then preview+=(-f "$stage/compose.neon.yaml"); fi
if [[ "$gateway_mode" == On ]]; then preview+=(--profile server); fi
"${preview[@]}" config --quiet

if [[ "$gateway_mode" == On ]]; then
  configuration="$("${preview[@]}" config --environment)"
  domain="$(sed -n 's/^MC_DOMAIN=//p' <<< "$configuration" | tail -n 1)"
  web_url="$(sed -n 's/^CANVAS_WEB_URL=//p' <<< "$configuration" | tail -n 1)"
  if [[ ! "$domain" =~ ^[A-Za-z0-9.-]+$ || "$web_url" != "https://$domain" ]]; then
    echo 'MC_DOMAIN and HTTPS CANVAS_WEB_URL must match when the gateway is enabled.' >&2
    exit 1
  fi
fi

backup="$project/.deploy-backups/$release_id"
mkdir -p "$backup/docker" "$project/docker"
for path in compose.yaml compose.neon.yaml docker/Caddyfile docker/logging.caddy; do
  if [[ -f "$project/$path" ]]; then cp -p -- "$project/$path" "$backup/$path"; fi
done

if [[ "$database_mode" == Local ]] && has_service postgres; then
  postgres_container="$(docker ps -q --filter 'label=com.docker.compose.project=multimodal-canvas-app' --filter 'label=com.docker.compose.service=postgres' | head -n 1)"
  [[ -n "$postgres_container" ]] || { echo 'Existing PostgreSQL is stopped; cannot make a pre-deployment backup.' >&2; exit 1; }
  docker exec "$postgres_container" pg_dump -U canvas -d canvas -Fc > "$backup/canvas.pgdump"
  [[ -s "$backup/canvas.pgdump" ]] || { echo 'PostgreSQL backup is empty.' >&2; exit 1; }
  echo "PostgreSQL backup: $backup/canvas.pgdump"
fi

echo "Database: $database_mode; gateway: $gateway_mode"
echo "Previous Compose files: $backup"
tar -xOzf "$archive_name" images.tar | docker load
install -m 0644 "$stage/compose.yaml" "$project/compose.yaml"
install -m 0644 "$stage/compose.neon.yaml" "$project/compose.neon.yaml"
install -m 0644 "$stage/docker/Caddyfile" "$project/docker/Caddyfile"
install -m 0644 "$stage/docker/logging.caddy" "$project/docker/logging.caddy"

compose=(docker compose --env-file .env.compose -p multimodal-canvas-app -f compose.yaml)
if [[ "$database_mode" == Neon ]]; then compose+=(-f compose.neon.yaml); fi
if [[ "$gateway_mode" == On ]]; then compose+=(--profile server); fi
"${compose[@]}" config --quiet
"${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 180
"${compose[@]}" ps --all
rm -f -- "$archive_name"
echo 'Server deployment completed; .env.compose and Docker volumes were preserved.'
