# 支付集成指南（套餐售卖 → 自动发放 API key）

> 面向需要在自己的应用里集成「用户付款买套餐 → 拿 API key」的外部应用。
> 网关侧已完成对接 pay.jokerin.icu 聚合支付；你的应用只需要调本网关的几个 HTTP 接口。

## 1. 整体流程

```
你的应用                本网关(any_gateway)           支付网关(pay.jokerin.icu)
   │  1. 查套餐列表           │                              │
   │ ────────────────────────>│                              │
   │  2. 下单(package,channel) │   创建订单(X-API-Key)         │
   │ ────────────────────────>│ ────────────────────────────>│
   │  <── order_id + pay_amount + data(网关原样返回)          │
   │                          │                              │
   │  3. 给用户展示付款         │      用户扫码/跳转支付         │
   │  4. 轮询订单状态           │        支付成功 ──回调──────> │
   │ ────────────────────────>│ <──────POST /payment/notify──│
   │  <── status=paid + key(sk-xxx)                          │
   │  5. 把 key 交付给用户      │（发货：按套餐铸 key，幂等）     │
```

- **发货物**：一个全新 API key（`sk-` 开头），额度=套餐 `credit_usd`，有效期=套餐 `duration_days` 天（未设则不限时），分组=套餐绑定的用户组（决定渠道路由/限流/计价倍率）。
- key 直接用本网关的 `/v1/*` 接口调模型。

## 2. 前置配置（在管理面板「支付」页，一次性）

| 配置项 | 说明 |
|---|---|
| 启用支付 | 总开关 |
| 网关地址 | 默认 `https://pay.jokerin.icu` |
| API Key | 支付网关的 `X-API-Key`（`biz_` 开头） |
| 回调验签密钥 | 网关侧的 `CALLBACK_SECRET`，**必须与支付网关控制台一致**，否则回调全部 403 |
| 站点公网地址 | 本网关的 **公网 https** 地址。回调地址自动拼为 `{地址}/payment/notify`，支付网关必须能访问到它（内网地址收不到回调） |
| 启用的支付方式 | wechat / alipay 勾选 |

然后「套餐管理」Tab 里建套餐（名称 / 支付金额¥ / key 额度$ / 有效天数 / 绑定分组）。

## 3. API

所有 `/admin/payment/*` 接口鉴权二选一（与面板一致）：

- Header `x-admin-key: <ADMIN_KEY>`（推荐，服务端对服务端）
- Header `Authorization: Bearer <admin JWT>`

### 3.1 查套餐列表

```
GET /admin/payment/packages?enabled_only=true
```

```json
{"data": [{"id": "a6314d98...", "label": "周卡", "amount_cny_cents": 990,
           "credit_usd": 1, "duration_days": 7, "group_id": null,
           "enabled": true, "sort_order": 1}], "total": 1}
```

### 3.2 下单

```
POST /admin/payment/orders
{"package_id": "<套餐id>", "channel": "wechat", "username": "可选-购买者标记"}
```

成功返回（`data` 为支付网关返回**原样透传**）：

```json
{"order_id": "po-32d806a80d3d4e78",
 "amount_cny_cents": 990,
 "pay_amount": 991,
 "data": {"order_id": "ord_2920...", "pay_amount": 991, "expire_at": 1790424423517}}
```

- **给用户展示的金额必须用 `pay_amount`**（单位分，可能带 ±0.10 元内的防比价浮动）。
- `expire_at` 为网关订单过期时间（epoch 毫秒，**实测下单后约 5 分钟**），过期未付订单自动失效。
- 常见错误：`400` 支付未启用/渠道未启用/未配置公网地址、`404` 套餐不存在、`502` 支付网关异常。

### 3.3 轮询订单（拿 key）

```
GET /admin/payment/orders/{order_id}
```

- 未支付：`{"status": "pending", "key": null, ...}`
- 已支付：`{"status": "paid", "key": "sk-249eb...", "pay_amount_cny_cents": 991, ...}`
- 超时未付：`status: "expired"`；金额异常：`status: "failed"`

**建议**：每 3 秒轮询一次，`expire_at` 到点或 `expired` 即停止。`key` 只在 paid 后返回，务必此时交付给用户并提醒保存。

### 3.4 对账/排障（可选）

```
GET /admin/payment/orders/{order_id}/gateway-status
```

透传支付网关的订单查询结果（网关侧 `status/paid_at/notified_at/expire_at`），用于比对回调是否送达。

## 4. 回调（无需你的应用参与）

支付网关回调本网关 `POST /payment/notify`（HMAC-SHA256 验签，公开端点）。要点：

- **幂等**：同一订单多次回调只发一把 key，重复轮询/补单不会重复发货。
- **金额容差** ±10 分；超差订单标记 `failed` 并拒绝（可通过人工补单修正）。
- 回调丢失时，管理员在面板「支付订单」Tab 对该单点 **手动补单**，同样发 key。

## 5. 调用示例（Node.js）

```js
const GW = "https://你的网关地址";
const KEY = process.env.ADMIN_KEY; // 网关 ADMIN_KEY

async function buyPackage(packageId, channel = "wechat") {
  // 下单
  const r = await fetch(`${GW}/admin/payment/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": KEY },
    body: JSON.stringify({ package_id: packageId, channel }),
  });
  if (!r.ok) throw new Error(`下单失败: ${await r.text()}`);
  const { order_id, pay_amount, data } = await r.json();

  // TODO: 给用户展示 pay_amount（分→元 /100）与支付入口
  // 注意：实测网关返回的 data 中只有 order_id/pay_amount/expire_at，
  // 未包含支付链接/二维码字段——支付入口的获取方式以网关文档为准，
  // data 为原样透传，字段一旦出现即可直接使用。

  // 轮询（3s 一次，最多 5 分钟）
  for (let i = 0; i < 100; i++) {
    await new Promise((s) => setTimeout(s, 3000));
    const q = await fetch(`${GW}/admin/payment/orders/${order_id}`, {
      headers: { "x-admin-key": KEY },
    });
    const order = await q.json();
    if (order.status === "paid") return order.key;        // sk-xxx，交付给用户
    if (order.status === "expired" || order.status === "failed") throw new Error(order.status);
  }
  throw new Error("支付超时");
}
```

## 6. 实测行为备忘（2026-09-26 对真实网关验证）

- 创建订单返回 `data` 仅含 `order_id / pay_amount / expire_at`，**无支付链接/二维码字段**；支付入口获取方式需向网关方确认。
- 网关订单有效期约 5 分钟；本网关按 `expire_at` 精确判过期（缺失时兜底 2 小时），过期后回调到达仍会正常发货。
- `pay_amount` 实测出现 989/991（下单 990）浮动；发 key 额度按套餐固定值，不受浮动影响。
- 金额单位分/元自动判别（容差内），兼容网关以元下发的响应。
