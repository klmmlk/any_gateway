#!/usr/bin/env bash
# 构建 SCF HTTP 云函数 zip 部署包（Windows Git Bash 可运行，依赖 uv 与 python）。
# 产物：cloudfunctions/any_gateway_http/（暂存目录）与 cloudfunctions/any_gateway_http.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/cloudfunctions/any_gateway_http"
ZIP="$ROOT/cloudfunctions/any_gateway_http.zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

# 1) 应用代码（剔除缓存与本地数据目录）
cp -r "$ROOT/any_gateway" "$STAGE/any_gateway"
find "$STAGE" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
rm -rf "$STAGE/any_gateway/data"

# 1b) 管理前端产物：gateway 按 <包上级>/apps/react/dist 探测挂载（gateway.py _STATIC_DIR）
if [ -d "$ROOT/apps/react/dist" ]; then
    mkdir -p "$STAGE/apps/react"
    cp -r "$ROOT/apps/react/dist" "$STAGE/apps/react/dist"
else
    echo "WARN: apps/react/dist 不存在，函数将只有 API 没有管理面板（先 cd apps/react && npm run build）"
fi

# 2) 交叉安装 Linux x86_64 + Python3.10 依赖（不编译本机字节码）
uv pip install \
  --python-platform x86_64-unknown-linux-gnu \
  --python-version 3.10 \
  --no-compile \
  --target "$STAGE" \
  -r "$ROOT/requirements-scf.txt"

# 3) 启动文件（LF 行尾；可执行位在打包时显式写入 zip 条目，Windows 的 chmod 是空操作）
tr -d '\r' < "$ROOT/cloudfunctions/scf_bootstrap" > "$STAGE/scf_bootstrap"

# 4) 打包（zip 根 = 函数根，解压到 /var/user 即可用）
python - "$STAGE" "$ZIP" <<'PYEOF'
import os, sys, zipfile

stage, out = sys.argv[1], sys.argv[2]
count = 0
with zipfile.ZipFile(out, "w") as z:
    for base, _dirs, files in os.walk(stage):
        for f in files:
            p = os.path.join(base, f)
            rel = os.path.relpath(p, stage).replace(os.sep, "/")
            zi = zipfile.ZipInfo.from_file(p, rel)
            # Windows 文件系统无执行位：SCF 要求 scf_bootstrap 可执行，
            # 在 zip 条目的 external_attr 里显式写入 rwxr-xr-x。
            mode = 0o100755 if rel == "scf_bootstrap" else 0o100644
            zi.external_attr = mode << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(p, "rb") as fh:
                z.writestr(zi, fh.read())
            count += 1
size_kb = os.path.getsize(out) // 1024
print(f"zip ok: {out}  files={count}  compressed={size_kb} KB")
if size_kb > 50 * 1024:
    print("ERROR: 超过 SCF 直传 50MB 上限，需改用 COS/层方式部署")
    sys.exit(1)
PYEOF

du -sm "$STAGE" | awk '{print "uncompressed:", $1, "MB (limit 250MB)"}'
