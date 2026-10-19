#!/usr/bin/env bash
# Docker 自身の ignore 解釈で、root と子ディレクトリの配布境界を検査する。
set -euo pipefail

if [[ $# -gt 1 ]]; then
  echo 'Usage: bash scripts/check-docker-context.sh [dockerignore-file]' >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ignore_file=${1:-"${script_dir}/../.dockerignore"}
if [[ ! -f "$ignore_file" ]]; then
  echo "Docker ignore file does not exist: $ignore_file" >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/tiktok-reader-docker-context.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT
context_dir="${work_dir}/context"
export_dir="${work_dir}/export"
mkdir -p "$context_dir"
cp "$ignore_file" "${context_dir}/.dockerignore"

forbidden_paths=()
retained_paths=()
for prefix in '' nested nested/deeper; do
  fixture_dir="${context_dir}${prefix:+/$prefix}"
  mkdir -p "${fixture_dir}/src"
  for name in .env .env.publication-audit secret.pem secret.key secret.p12 app.log .DS_Store sbom.cdx.json THIRD_PARTY_NOTICES.txt; do
    printf 'PUBLICATION_AUDIT_FAKE_ONLY=1\n' > "${fixture_dir}/${name}"
    forbidden_paths+=("${prefix:+$prefix/}${name}")
  done
  for name in node_modules dist coverage .git .github; do
    mkdir -p "${fixture_dir}/${name}"
    printf 'PUBLICATION_AUDIT_FAKE_ONLY=1\n' > "${fixture_dir}/${name}/audit-marker"
    forbidden_paths+=("${prefix:+$prefix/}${name}")
  done
  printf 'EXAMPLE_ONLY=1\n' > "${fixture_dir}/.env.example"
  printf 'export const auditFixture = true;\n' > "${fixture_dir}/src/retained.ts"
  retained_paths+=("${prefix:+$prefix/}.env.example" "${prefix:+$prefix/}src/retained.ts")
done

# scratch はイメージ取得不要。タグ・コンテナを作らず、実プロジェクトもcontextに渡さない。
if ! docker buildx build --progress=plain --file - \
  --output "type=local,dest=${export_dir}" "$context_dir" \
  > "${work_dir}/build.log" 2>&1 <<'DOCKERFILE'
FROM scratch
COPY . /
DOCKERFILE
then
  cat "${work_dir}/build.log" >&2
  exit 1
fi

failed=false
for fixture_path in "${forbidden_paths[@]}"; do
  if [[ -e "${export_dir}/${fixture_path}" ]]; then
    echo "Docker context includes forbidden path: $fixture_path" >&2
    failed=true
  fi
done
for fixture_path in "${retained_paths[@]}"; do
  if ! cmp -s "${context_dir}/${fixture_path}" "${export_dir}/${fixture_path}"; then
    echo "Docker context does not preserve expected file: $fixture_path" >&2
    failed=true
  fi
done
if [[ "$failed" == true ]]; then
  exit 1
fi

echo "Docker context verified: ${#forbidden_paths[@]} exclusions and ${#retained_paths[@]} retained files across 3 depths"
