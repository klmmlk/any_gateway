# HTTPS 部署指南（内置 Caddy，单镜像）

网关镜像内已内置带 Cloudflare DNS 插件的 Caddy 反向代理。给容器的环境变量配上 `ACME_DOMAIN` 和 `CLOUDFLARE_API_TOKEN` 两个值，容器启动后即自动：

- 向 Let's Encrypt 申请 HTTPS 证书（**DNS-01 验证**：通过 Cloudflare API 加/删 TXT 记录，不依赖任何入站端口，80/443 被运营商封锁也不影响）；
- 在容器内 8443 端口提供 HTTPS，反代到本容器 8003 的应用（API、管理面板、`wss` 实时语音全都在一个域名下）；
- 到期前自动续期，证书存宿主机 `./data/caddy`，重建容器不重签。

不配这两个变量时，容器行为与纯 HTTP 模式完全一致（8003 明文），完全向后兼容。

## 架构

```
公网客户端 / 支付网关回调 ──https://<域名>:8443──▶ 路由器(8443转发) ──▶ gateway 容器
                                                              ├─ Caddy :8443（TLS 终端，DNS-01 自动证书）
                                                              └─ uvicorn :8003（API + 面板 + wss）
局域网设备 ──http://<内网IP>:8003──▶ 直连（不走域名，规避 NAT hairpin）
```

## 一次性准备

1. **Cloudflare API Token**：[ dash.cloudflare.com](https://dash.cloudflare.com) → 右上角头像 → My Profile → API Tokens → Create Token → **Edit zone DNS** 模板 → 权限确认为 `Zone / DNS / Edit` 和 `Zone / Zone / Read`，Zone Resources 选 `Include / Specific zone / <你的域名>` → 创建并复制（只显示一次）。
2. **DNS A 记录**：你的域名下加一条 A 记录指向服务器公网 IP，**代理状态设为「仅 DNS」（灰云）**——本方案是直连，流量不经 Cloudflare，只有签发证书那一刻会调 Cloudflare API。
3. **路由器**：把公网 8443/TCP 转发到服务器 8443。

## 服务器配置

`.env`（或直接写在 compose 的 environment 里）加两行：

```bash
ACME_DOMAIN=gw.example.com
CLOUDFLARE_API_TOKEN=粘贴你的Token
```

compose 的 gateway 服务确认有 8443 端口映射和这两个环境变量：

```yaml
  gateway:
    ports:
      - "8003:8003"
      - "8443:8443"
    environment:
      - ACME_DOMAIN=gw.example.com
      - CLOUDFLARE_API_TOKEN=粘贴你的Token
```

然后按平时的方式更新即可（镜像里已带 Caddy，无需任何额外构建/文件）：

```bash
docker compose pull gateway
docker compose up -d
docker compose logs gateway | grep -i caddy   # 看到 "certificate obtained successfully" 即成功
```

## 验证与接入

| 检查项 | 命令 / 操作 | 预期 |
|---|---|---|
| 证书 | 外网（手机流量）`curl -v https://gw.example.com:8443/health` | 证书有效，返回 `{"status":"healthy"}` |
| 面板 | 浏览器打开 `https://gw.example.com:8443` | 正常登录 |
| 支付回调链路 | 外网 `curl -X POST https://gw.example.com:8443/payment/notify -d '{}'` | 403（无签名被拒）＝TLS+路由+验签全通 |
| 实时语音 | `wss://gw.example.com:8443/v1/audio/asr/stream?model=...&api_key=...` | 正常识别 |

接入方地址：

- 支付面板「渠道配置」**public_base_url**：`https://gw.example.com:8443`
- 外部软件 API 基址：`https://gw.example.com:8443`（见 docs/payment.md）
- 局域网内部：继续 `http://<内网IP>:8003`，不受影响

## 常见问题

- **证书签发失败**：日志出现 401/权限错误 → Token 权限不足或没限定到该域名（需 Zone.DNS Edit + Zone Read）；出现 DNS 类错误 → A 记录不存在或误开橙云。改完 `docker compose up -d --force-recreate gateway`。
- **想让 URL 不带 :8443**：本方案 8443 是因为 80/443 入站被封。若哪天端口解封，路由器把 443 转发到 8443、并在 Caddyfile 的站点地址上放开即可；或临时用 Cloudflare 橙云代理（边缘 443 → 回源 8443）。
- **公网 IP 是动态的**：IP 变了 A 记录会失效，需配 DDNS（路由器自带 Cloudflare DDNS，或用 cloudflare-ddns 容器）。
- **Token 泄露/更换**：Cloudflare 后台撤销重建，更新环境变量后 `up -d --force-recreate gateway`。
- **镜像构建变慢了**：CI 里多了一个 xcaddy 编译阶段（Go 构建，带缓存约 2-3 分钟），一次性成本，服务器端无感知。

## 备选方案（为什么没选）

- **Cloudflare Tunnel（cloudflared 容器）**：连 8443 端口转发都不需要，但流量必须过 CF 边缘、配置一半在 CF 后台。可作 8443 也被封时的兜底。
- **Caddy + Cloudflare 源站证书**：免 Token，但要手动从后台搬两段 PEM 文件、开橙云。15 年有效等于免续期，适合不想创建 API Token 的人。

## 附注

- `deploy_cloudbase/` 目录含真实密钥，仅供 CloudBase 部署使用，请勿提交到版本库。
