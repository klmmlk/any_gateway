# HTTPS 部署指南（Caddy + ACME 自动证书）

为网关配置公网 HTTPS，证书由 [Caddy](https://caddyserver.com/) 通过 ACME 协议（Let's Encrypt / ZeroSSL）**自动申请、自动续期**，无需 cron、无需手工操作。

适用于的场景：支付回调（`notify_url` 必须是公网 https 地址）、外部软件公网调用 API、浏览器直接访问管理面板。

## 架构

```
公网客户端 / 支付网关回调
        │  https://<你的域名>:8443
        ▼
   Caddy 容器（TLS 终端，ACME DNS-01 自动申请续期证书）
        │  reverse_proxy
        ▼
   gateway 容器 :8003（API + 管理面板 + wss，无需任何改动）

局域网设备：继续直连 http://<内网IP>:8003（不走域名，规避 NAT hairpin）
```

为什么用 **DNS-01** 验证：运营商/路由器封锁了入站 80/443 时，标准 HTTP 验证无法完成；DNS-01 通过 Cloudflare API 自动添加/清除一条 `_acme-challenge` TXT 记录来完成验证，**完全不依赖任何入站端口**，续期永远不会因端口问题失败。

## 前置条件

1. 服务器有公网 IP（入站 80/443 被封没关系，但 **8443 必须可达**：路由器把公网 8443/TCP 转发到服务器 8443）。
2. 一个托管在 Cloudflare 的域名。
3. 在 Cloudflare 该域名的 DNS 里添加一条 **A 记录**指向服务器公网 IP：
   - 类型 `A`，名称自定（如 `gw`），内容为公网 IP；
   - **代理状态设为「仅 DNS」（灰云）**——橙云会隐藏源站并劫持端口语义，先用灰云直连验证。

## 第一步：创建 Cloudflare API Token

1. 登录 Cloudflare → 右上角头像 → **My Profile → API Tokens → Create Token**。
2. 选择 **Edit zone DNS** 模板，然后：
   - **Permissions**：`Zone / DNS / Edit`（模板自带）＋ `Zone / Zone / Read`；
   - **Zone Resources**：`Include / Specific zone / <你的域名>`（只授权这一个域名）；
   - 其他保持默认，创建后**立刻复制 Token**（只显示一次）。

## 第二步：配置并启动

在服务器上编辑 `.env`，追加：

```bash
ACME_DOMAIN=gw.example.com            # 你的域名
CLOUDFLARE_API_TOKEN=xxxxxxxx         # 第一步创建的 Token
```

然后：

```bash
docker compose build caddy     # 首次构建带 Cloudflare 插件的 Caddy 镜像，约 1-2 分钟
docker compose up -d caddy
docker compose logs -f caddy   # 观察证书签发
```

看到类似日志即为成功：

```
certificate obtained successfully for "gw.example.com"
```

证书与密钥持久化在宿主机 `./data/caddy/`（即 `/data` 卷），重建容器不会重新签发；证书有效期剩 2/3 时 Caddy 自动续期。

## 第三步：验证

| 检查项 | 命令 / 操作 | 预期 |
|---|---|---|
| 证书 | 外网（手机流量）`curl -v https://gw.example.com:8443/health` | 证书有效，返回 `{"status":"healthy"}` |
| 面板 | 浏览器打开 `https://gw.example.com:8443` | 正常登录 |
| 支付回调链路 | 外网 `curl -X POST https://gw.example.com:8443/payment/notify -d '{}'` | 返回 403（无签名被拒）＝TLS+路由+验签全通 |
| 实时 ASR | 语音应用改用 `wss://gw.example.com:8443/v1/audio/asr/stream?model=...&api_key=...` | 正常识别 |

## 第四步：接入方地址变更

- **支付面板**：「支付 → 渠道配置」中 **public_base_url** 填 `https://gw.example.com:8443`，回调地址即变为 `https://gw.example.com:8443/payment/notify`。
- **外部软件集成**：`https://gw.example.com:8443`（见 docs/payment.md）。
- **实时语音**：`wss://gw.example.com:8443/v1/audio/asr/stream`。
- 局域网内部调用继续用 `http://<内网IP>:8003`，不受影响。

## 常见问题

### 支付网关拒收带 `:8443` 的回调地址

如果 `pay.jokerin.icu` 对 notify_url 有标准端口校验（目前实测只要求 https，未发现端口限制），把 Cloudflare 该 A 记录的代理状态切为**已代理（橙云）**即可：访客走标准 `https://域名`（Cloudflare 边缘 443），Cloudflare 自动回源到源站 8443（8443 是其兼容回源端口），**Caddy 证书机制完全不用改**。代价是流量经过 Cloudflare 边缘，国内访问质量可能有波动。

### 公网 IP 是动态的（家庭宽带拨号）

IP 变化后 A 记录会失效。两个办法：

1. 路由器自带 DDNS 功能的，直接在路由器上配 Cloudflare DDNS；
2. 或给 Caddy 镜像再加一个 DDNS 插件：把 `Dockerfile.caddy` 中的构建命令改为
   `xcaddy build --with github.com/caddy-dns/cloudflare --with github.com/mholt/caddy-ddns`，
   并在 Caddyfile 顶部全局块加：
   ```
   {
       ddns_zone <你的域名> {
           provider cloudflare {env.CLOUDFLARE_API_TOKEN}
       }
   }
   ```
   Caddy 会自动把 A 记录更新为当前出口 IP。

### 证书签发失败排查

- 日志出现 `no token provided`／401：`CLOUDFLARE_API_TOKEN` 未注入或 Token 权限不足（需 Zone.DNS Edit + Zone Read，且限定该域名）。
- 日志出现 DNS 解析类错误：确认 A 记录存在且是灰云。
- 调整后重启：`docker compose restart caddy`（Token 只在启动时读取）。

### 想 URL 不带端口 / 8443 被封

若运营商连 8443 也封，可换 Cloudflare 兼容端口列表中的其他端口（2053、2083、2087、2096），改 `docker-compose.yml` 和 Caddyfile 中的端口并保持路由器转发一致；或者直接走橙云代理（源站端口同样从列表中选）。

## 附注

- `docker-compose.yml` 中 `mock-ad`、`redis` 等服务与本方案无关，无需改动。
- Caddy 反代对 WebSocket 自动支持（`Connection: upgrade` 直通），对 LLM 流式响应配置了 `flush_interval -1`（逐块透传不缓冲），响应无超时限制，长生成不会被掐断。
- `deploy_cloudbase/` 目录含真实密钥，仅供 CloudBase 部署使用，请勿提交到版本库。
