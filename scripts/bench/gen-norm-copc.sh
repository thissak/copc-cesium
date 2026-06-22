#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."   # repo 루트로 — 어디서 실행하든 scripts/bench/*.json·data/ 경로 일관
command -v pdal >/dev/null || { echo "PDAL 필요: brew install pdal (또는 conda install -c conda-forge pdal)"; exit 1; }
mkdir -p data
pdal pipeline scripts/bench/gen-norm-copc.json
echo "=== 생성 결과 ==="
pdal info data/norm-autzen-2M.copc.laz --summary | grep -E '"count"|"bounds"' || true
