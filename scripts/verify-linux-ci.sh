#!/usr/bin/env bash
# 本脚本只由隔离容器运行；仅接受同一网络命名空间内的一次性本机测试设施。
set -Eeuo pipefail
cd /workspace

if [[ "${ACCEPTANCE_ISOLATED:-}" != 'true' ]]; then
  printf '%s\n' '必须通过 verify-linux-ci.ps1 创建隔离容器后运行' >&2
  exit 1
fi

mkdir -p test-results/ci
# 保存所有独立检查的失败名称；脚本收尾时统一判定，不覆盖前面的失败。
failed_checks=()
scope="${ACCEPTANCE_SCOPE:-full}"
packages=()
case "$scope" in
  full) ;;
  delta)
    IFS=',' read -r -a packages <<< "${ACCEPTANCE_PACKAGES:-}"
    if [[ "${#packages[@]}" -eq 0 ]]; then
      printf '%s\n' 'delta 验收必须指定包名' >&2
      exit 1
    fi
    for package in "${packages[@]}"; do
      case "$package" in
        api|web|worker|providers|domain|observability|credential-crypto|ui) ;;
        *) printf '不支持的验收包：%s\n' "$package" >&2; exit 1 ;;
      esac
    done
    ;;
  *) printf '不支持的验收范围：%s\n' "$scope" >&2; exit 1 ;;
esac
printf 'scope=%s packages=%s\n' "$scope" "${packages[*]}" > test-results/ci/scope.txt

# 记录各独立检查并继续收集证据；参数为检查名和命令，任一失败会使脚本最终非零退出。
run_check() {
  local label="$1"
  shift
  if "$@"; then
    printf '%s: passed\n' "$label" >> test-results/ci/checks.txt
  else
    local status="$?"
    printf '%s: failed (%s)\n' "$label" "$status" >> test-results/ci/checks.txt
    failed_checks+=("$label")
  fi
}

export CI=true NODE_ENV=test WORKER_PROVIDER=mock RUN_SERVICE=memory
export NEW_API_BASE_URL='' NEW_API_API_KEY=''
unset DATABASE_URL REDIS_URL S3_BUCKET TEST_DATABASE_URL TEST_REDIS_URL TEST_S3_ENDPOINT
unset REQUIRE_INTEGRATION_SERVICES REQUIRE_PRODUCTION_ENTRY MEDIA_REAL_TESTS MEDIA_OPS_INTEGRATION

node --version
pnpm --version
ffmpeg -version
ffprobe -version
openssl version
pnpm install --offline --frozen-lockfile
pnpm exec prisma generate

# 先构建全部 workspace 包，确保跨 API/Worker 动态源码导入不依赖宿主残留 dist。
pnpm exec turbo run build --force --concurrency=1
if [[ "$scope" == 'full' ]]; then
run_check lint pnpm exec turbo run lint --force --concurrency=1 --continue=dependencies-successful
run_check typecheck pnpm exec turbo run typecheck --force --concurrency=1 --continue=dependencies-successful
run_check format pnpm format:check
run_check unit pnpm exec turbo run test --force --concurrency=1 --continue=dependencies-successful -- --maxWorkers=1 --minWorkers=1
else
  run_check format pnpm format:check
  for package in "${packages[@]}"; do
    run_check "$package-lint" pnpm --filter "@multimodal-canvas/$package" lint
    run_check "$package-typecheck" pnpm --filter "@multimodal-canvas/$package" typecheck
    run_check "$package-unit" pnpm --filter "@multimodal-canvas/$package" test \
      --maxWorkers=1 --minWorkers=1 --reporter=default --reporter=json \
      --outputFile="../../test-results/ci/$package-unit.json"
  done
fi

if [[ "$scope" == 'full' ]]; then
export TEST_DATABASE_URL='postgresql://ci_user:ci_password@127.0.0.1:5432/multimodal_canvas_ci?schema=public'
export TEST_REDIS_URL='redis://127.0.0.1:6379/15'
export TEST_REDIS_NAMESPACE='multimodal-canvas:linux-ci'
export TEST_S3_ENDPOINT='http://127.0.0.1:9000'
export TEST_S3_REGION='us-east-1'
export TEST_S3_BUCKET='multimodal-canvas-linux-ci'
export TEST_S3_ACCESS_KEY='ci-minio-user'
export TEST_S3_SECRET_KEY='ci-minio-password'
export TEST_S3_PREFIX='integration/linux-ci'

DATABASE_URL="$TEST_DATABASE_URL" pnpm exec prisma migrate deploy
pnpm exec prisma migrate diff --from-url "$TEST_DATABASE_URL" \
  --to-schema-datamodel prisma/schema.prisma --exit-code

run_check rate-limit pnpm --filter @multimodal-canvas/api exec vitest run \
  --config vitest.rate-limit-integration.config.ts --maxWorkers=1 --minWorkers=1 \
  --reporter=default --reporter=json --outputFile=../../test-results/ci/rate-limit.json

run_check integration env REQUIRE_INTEGRATION_SERVICES=true pnpm --filter @multimodal-canvas/api test:integration \
  --maxWorkers=1 --minWorkers=1 \
  --reporter=default --reporter=json --outputFile=../../test-results/ci/integration.json

run_check production-entry env REQUIRE_PRODUCTION_ENTRY=true pnpm --filter @multimodal-canvas/api exec vitest run \
  src/production-proxy.test.ts --maxWorkers=1 --minWorkers=1 \
  --reporter=default --reporter=json --outputFile=../../test-results/ci/production-entry.json

run_check media env MEDIA_REAL_TESTS=true MEDIA_OPS_INTEGRATION=true pnpm --filter @multimodal-canvas/api exec vitest run \
  src/media.real.test.ts src/media-ops.integration.test.ts --maxWorkers=1 --minWorkers=1 \
  --reporter=default --reporter=json --outputFile=../../test-results/ci/media.json

run_check observability pnpm --filter @multimodal-canvas/observability exec vitest run src/http-collector.test.ts \
  --maxWorkers=1 --minWorkers=1 \
  --reporter=default --reporter=json --outputFile=../../test-results/ci/observability.json

run_check report-gate node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
for (const name of ['rate-limit', 'integration', 'production-entry', 'media', 'observability']) {
  const report = JSON.parse(readFileSync(`test-results/ci/${name}.json`, 'utf8'));
  assert.equal(report.success, true, `${name}: 测试失败`);
  assert.ok(report.numTotalTests > 0, `${name}: 没有执行测试`);
  assert.equal(report.numPendingTests, 0, `${name}: 存在跳过项`);
  assert.equal(report.numTodoTests ?? 0, 0, `${name}: 存在待办项`);
  assert.equal(report.numPassedTests, report.numTotalTests, `${name}: 测试未全部通过`);
  console.log(`${name}: ${report.numPassedTests} 项通过，无跳过`);
}
NODE
fi

if [[ "$scope" == 'full' || ",${ACCEPTANCE_PACKAGES:-}," == *',web,'* ]]; then
run_check web-e2e env WEB_PORT=5187 pnpm --filter @multimodal-canvas/web exec playwright test \
  -c playwright.config.ts --workers=1 --reporter=line,json \
  --output=../../test-results/ci/playwright
fi
if [[ "${#failed_checks[@]}" -gt 0 ]]; then
  printf '隔离 Linux CI 未通过：%s\n' "${failed_checks[*]}" >&2
  exit 1
fi
printf '隔离 Linux CI %s 范围全部步骤通过\n' "$scope"
