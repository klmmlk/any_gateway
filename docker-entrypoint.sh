#!/bin/sh
# 网关容器入口：配置了 ACME_DOMAIN 与 CLOUDFLARE_API_TOKEN 时，先在后台启动
# 内置 Caddy 反代（DNS-01 自动申请/续期 HTTPS 证书，监听 8443，反代到本容器
# 8003 的 uvicorn）；未配置则与纯 HTTP 模式行为完全一致。
if [ -n "$ACME_DOMAIN" ] && [ -n "$CLOUDFLARE_API_TOKEN" ]; then
    caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
fi
exec "$@"
