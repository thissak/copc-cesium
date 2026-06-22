#!/usr/bin/env bash
set -euo pipefail
command -v pdal >/dev/null || { echo "PDAL 필요: brew install pdal (또는 conda install -c conda-forge pdal)"; exit 1; }
mkdir -p data
pdal pipeline scripts/bench/gen-norm-copc.json
echo "=== 생성 결과 ==="
pdal info data/norm-autzen-2M.copc.laz --summary | grep -E '"count"|"bounds"' || true
