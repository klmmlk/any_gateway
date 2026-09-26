# HTTPS 部署指南

为网关配置公网 HTTPS，供支付回调（`notify_url`）、外部软件 API 调用、浏览器访问管理面板使用。两个方案任选其一：

| | 方案 A：Cloudflare Tunnel（推荐） | 方案 B：Caddy + DNS-01 |
|---|---|---|
| 服务器改动 | compose 加一个 cloudflared 服务 | 加一个 caddy 服务（需构建自定义镜像） |
| 证书 | 无需管理（TLS 在 Cloudflare 边缘终结） | ACME 自动申请续期（存 ./data/caddy） |
| 路由器 | **不需要任何端口转发** | 需转发 8443/TCP |
| 动态公网 IP | 无影响（出站隧道） | 需配 DDNS |
| 流量路径 | 经 Cloudflare 边缘 | 直连（不经 CF 代理） |

## 方案 A：Cloudflare Tunnel（约 5 分钟）

原理：服务器上的 `cloudflared` 容器主动连到 Cloudflare 边缘（出站连接），公网访问 `https://你的域名` 时由边缘经隧道转回 gateway。不需要开放任何入站端口，不需要证书文件，IP 变了也自动重连。

### 1. Cloudflare 后台创建隧道

1. 登录 [one.dash.cloudflare.com](https://one.dash.cloudflare.com)（Zero Trust）→ **Networks → Tunnels → Create a tunnel**，类型选 **Cloudflared**，随便起个名（如 `any-gateway`）。
2. 创建后**复制 Token**（那串很长的 eyJ...，只显示一次）。
3. 在隧道的 **Public Hostname** 标签页添加一条：
   - Subdomain：`gw`（自定），Domain：选你的域名；
   - Service：Type `HTTP`，URL `gateway:8003`（即 compose 里 gateway 服务的名字:容器端口）。
   - 保存后 Cloudflare 会自动创建对应的 DNS 记录，**不用手动加 A 记录**。

### 2. 服务器 compose 加一个服务

在 `docker compose.yaml` 里追加（和 gateway 同一个 compose 文件，保证能通过服务名互访）：

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: any-gateway-tunnel
    command: tunnel --no-autoupdate run --token 粘贴你的Token
    depends_on:
      - gateway
    restart: unless-stopped
```

然后：

```bash
docker compose up -d cloudflared
docker compose logs -f cloudflared   # 看到 "Registered tunnel connection" 即成功
```

### 3. 验证与接入

- 外网（手机流量）：`curl https://gw.你的域名/health` → `{"status":"healthy"}`；浏览器打开 `https://gw.你的域名` 应能看到登录页。
- 支付面板「渠道配置」：**public_base_url** 填 `https://gw.你的域名`（标准 443，无端口号，回调地址即 `https://gw.你的域名/payment/notify`）。
- 外部软件 API 基址：`https://gw.你的域名`。
- 实时语音：`wss://gw.你的域名/v1/audio/asr/stream?model=...&api_key=...`。
- 局域网内部继续用 `http://<内网IP>:8003`，不受影响。

## 方案 B：Caddy + ACME DNS-01（不经 Cloudflare 代理，直连）

适合不想让流量经过 Cloudflare 边缘的场景。证书走 Let's Encrypt，DNS-01 验证（Cloudflare API 加/删 TXT 记录），**不依赖任何入站端口**，80/443 被封也能签发续期。

### 1. Cloudflare API Token

My Profile → API Tokens → Create Token → **Edit zone DNS** 模板，权限 `Zone/DNS/Edit` + `Zone/Zone/Read`，Zone Resources 限定你的域名，创建后复制。

### 2. DNS 记录

该域名加 A 记录指向服务器公网 IP，**代理状态设为「仅 DNS」（灰云）**。

### 3. 文件与启动

仓库已含 `Dockerfile.caddy`（xcaddy 构建 cloudflare DNS 插件）和 `Caddyfile`（`https://{$ACME_DOMAIN}:8443` → `gateway:8003`，流式不缓冲）。把它们放到服务器 compose 同目录，compose 追加：

```yaml
  caddy:
    build:
      context: .
      dockerfile: Dockerfile.caddy
    container_name: any-gateway-caddy
    ports:
      - "8443:8443"
    environment:
      - ACME_DOMAIN=gw.你的域名
      - CLOUDFLARE_API_TOKEN=粘贴你的Token
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data/caddy:/data
    depends_on:
      - gateway
    restart: unless-stopped
```

```bash
docker compose build caddy && docker compose up -d caddy
docker compose logs -f caddy   # 看到 "certificate obtained successfully" 即成功
```

路由器需把公网 8443/TCP 转发到服务器 8443。证书持久化在 `./data/caddy`，到期前自动续期，重建容器不重签。

### 4. 接入

public_base_url / API 基址填 `https://gw.你的域名:8443`，实时语音 `wss://gw.你的域名:8443/v1/audio/asr/stream`。若支付网关拒收带 `:8443` 的回调地址，把 A 记录切橙云（Cloudflare 边缘 443 → 回源 8443，证书机制不变）。

## 常见问题

- **Cloudflare 免费版 100 秒限制**：指源站响应首字节的超时（524）。LLM 流式响应首字节通常秒回，不受影响；若某请求 100 秒还没任何输出才会断。
- **国内访问 Cloudflare 边缘慢/抖**：两个方案流量都过 CF 边缘。若不可接受，方案 B 直连（灰云）时实际流量不经 CF，只有证书签发那一刻用 CF API。
- **隧道日志报 "unable to reach gateway"**：检查 compose 里 gateway 的服务名与 Public Hostname 里填的 URL 是否一致。
- **Token 换了/泄露**：CF 后台撤销重建，改 compose 后 `docker compose up -d --force-recreate cloudflared`（或 caddy 容器同理）。

## 附注

- `deploy_cloudbase/` 目录含真实密钥，仅供 CloudBase 部署使用，请勿提交到版本库。
