import secrets
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Text
from sqlmodel import SQLModel, Field


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# MySQL（TDSQL-C）要求 VARCHAR 必须显式声明长度（SQLite 忽略、PostgreSQL
# 按 VARCHAR(n) 约束），因此所有 str 字段都给出 max_length；取值留足余量。
# 模型列表 JSON / 运行时配置等可能很长的字段用 sa_type=Text。
_ID_LEN = 64        # uuid4().hex（32 字符）+ 余量
_TS_LEN = 64        # ISO 8601 时间戳（~27 字符）+ 余量
_KEY_LEN = 64       # sk- 前缀 + 32 位 hex
_NAME_LEN = 255     # 名称 / 用户名 / 模型名
_URL_LEN = 512      # base_url / api_key / proxy_url


# =======================
# UserGroup（用户分组）
# =======================


class UserGroupBase(SQLModel):
    name: str = Field(unique=True, max_length=_NAME_LEN)
    priority: int = Field(default=1)
    multiplier: float = Field(default=1.0)
    all_visible: bool = Field(default=False)


class UserGroup(UserGroupBase, table=True):
    __tablename__ = "user_groups"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


class UserGroupCreate(UserGroupBase):
    pass


class UserGroupUpdate(SQLModel):
    priority: int | None = None
    multiplier: float | None = None
    all_visible: bool | None = None


# =======================
# Token（内部 API Key）
# =======================


class TokenBase(SQLModel):
    name: str = Field(max_length=_NAME_LEN)
    group_id: str | None = Field(default=None, foreign_key="user_groups.id", max_length=_ID_LEN)
    username: str | None = Field(default=None, foreign_key="users.username", max_length=_NAME_LEN)
    quota_usd: float = Field(default=0)
    expires_at: str | None = Field(default=None, max_length=_TS_LEN)


class Token(TokenBase, table=True):
    __tablename__ = "tokens"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    key: str = Field(
        default_factory=lambda: f"sk-{secrets.token_hex(16)}",
        unique=True,
        max_length=_KEY_LEN,
    )
    used_usd: float = Field(default=0)
    frozen: bool = Field(default=False)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)
    last_used: str | None = Field(default=None, max_length=_TS_LEN)


class TokenCreate(TokenBase):
    pass


class TokenUpdate(SQLModel):
    name: str | None = None
    group_id: str | None = None
    quota_usd: float | None = None
    expires_at: str | None = None
    frozen: bool | None = None


# =======================
# Channel（后端渠道）
# =======================


class ChannelBase(SQLModel):
    name: str = Field(max_length=_NAME_LEN)
    provider: str = Field(max_length=64)
    base_url: str = Field(max_length=_URL_LEN)
    # 当前明文存储（设计决策：YAGNI，待后期添加 Fernet 加密）
    api_key: str = Field(max_length=_URL_LEN)
    weight: int = Field(default=1)
    enabled: bool = Field(default=True)
    models: str | None = Field(default=None, sa_type=Text)  # JSON string, e.g. '["gpt-4o", ...]'
    model_mapping: str | None = Field(
        default=None, sa_type=Text
    )  # JSON string, e.g. '{"gpt-4o": "claude-opus-4-5"}'
    # 渠道级网络/兼容性选项（均有默认值，向后兼容）
    proxy_url: str | None = Field(default=None, max_length=_URL_LEN)  # 该渠道单独走 HTTP 代理，如 http://127.0.0.1:7890
    disable_ssl: bool = Field(default=False)  # 跳过该渠道上游 SSL 证书校验
    disable_compression: bool = Field(
        default=False
    )  # 强制 accept-encoding=identity，兼容「压缩却不回传 Content-Encoding」的非标准上游


class Channel(ChannelBase, table=True):
    __tablename__ = "channels"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


class ChannelCreate(ChannelBase):
    pass


class ChannelUpdate(SQLModel):
    name: str | None = None
    provider: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    weight: int | None = None
    enabled: bool | None = None
    models: str | None = None
    model_mapping: str | None = None
    proxy_url: str | None = None
    disable_ssl: bool | None = None
    disable_compression: bool | None = None


# =======================
# UsageLog（用量记录，只写不改）
# =======================


class UsageLog(SQLModel, table=True):
    __tablename__ = "usage_logs"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    token_id: str | None = Field(default=None, foreign_key="tokens.id", max_length=_ID_LEN)
    username: str | None = Field(default=None, max_length=_NAME_LEN)  # 冗余存储，Token 删除后仍可追溯
    channel_id: str | None = Field(default=None, foreign_key="channels.id", max_length=_ID_LEN)
    model: str | None = Field(default=None, max_length=_NAME_LEN)
    input_tokens: int = Field(default=0)
    output_tokens: int = Field(default=0)
    cache_read_tokens: int = Field(default=0)
    cache_creation_tokens: int = Field(default=0)
    cost_usd: float = Field(default=0)
    covered_by_package: bool = Field(default=False)
    duration_ms: float = Field(default=0)
    status: int | None = Field(default=None)
    is_stream: bool = Field(default=False)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


# =======================
# Voucher（兑换码）
# =======================


class VoucherBase(SQLModel):
    amount_usd: float
    expires_at: str | None = Field(default=None, max_length=_TS_LEN)
    # 兑换后生成 API key 的有效天数；None = 兑换走旧逻辑（登录充值余额）
    duration_days: int | None = None
    # 兑卡型券生成的 key 绑定的分组（决定渠道路由/限流/计价）；None = 兑换时绑 default 组
    group_id: str | None = Field(default=None, foreign_key="user_groups.id", max_length=_ID_LEN)


class Voucher(VoucherBase, table=True):
    __tablename__ = "vouchers"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    code: str = Field(default_factory=lambda: secrets.token_urlsafe(12), unique=True, max_length=_KEY_LEN)
    used: bool = Field(default=False)
    used_by: str | None = Field(default=None, max_length=_NAME_LEN)  # username
    used_at: str | None = Field(default=None, max_length=_TS_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


class VoucherCreate(VoucherBase):
    count: int = 1  # 批量创建数量


class VoucherUpdate(SQLModel):
    amount_usd: float | None = None
    expires_at: str | None = None


# =======================
# AdminUser（管理员账户）
# =======================


class AdminUser(SQLModel, table=True):
    __tablename__ = "admin_users"
    username: str = Field(primary_key=True, max_length=_NAME_LEN)  # LDAP 用户名
    role: str = Field(default="admin", max_length=32)  # "admin" | "superadmin"
    created_by: str | None = Field(default=None, max_length=_NAME_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


# =======================
# User（AD 用户，懒加载）
# =======================


class User(SQLModel, table=True):
    __tablename__ = "users"
    username: str = Field(primary_key=True, max_length=_NAME_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)
    quota_usd: float | None = Field(default=0)   # None=无限，0=无余额，>0=有余额
    used_usd: float = Field(default=0)            # 累计消费


# =======================
# UserGroupMembership（用户-分组 多对多）
# =======================


class UserGroupMembership(SQLModel, table=True):
    __tablename__ = "user_group_memberships"
    username: str = Field(foreign_key="users.username", primary_key=True, max_length=_NAME_LEN)
    group_id: str = Field(foreign_key="user_groups.id", primary_key=True, max_length=_ID_LEN)


# =======================
# GroupChannel（分组-渠道 多对多）
# =======================


class GroupChannel(SQLModel, table=True):
    __tablename__ = "group_channels"
    group_id: str = Field(foreign_key="user_groups.id", primary_key=True, max_length=_ID_LEN)
    channel_id: str = Field(foreign_key="channels.id", primary_key=True, max_length=_ID_LEN)


# =======================
# RateLimit（分组限速规则）
# =======================


class RateLimitBase(SQLModel):
    group_id: str = Field(foreign_key="user_groups.id", max_length=_ID_LEN)
    window_sec: int        # 滚动窗口秒数
    limit_type: str = Field(max_length=32)        # "request_limit" | "token_limit" | "quota_limit"
    value: float           # 限制值，0 = 禁用


class RateLimit(RateLimitBase, table=True):
    __tablename__ = "rate_limits"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)


class RateLimitCreate(RateLimitBase):
    pass


class RateLimitUpdate(SQLModel):
    window_sec: int | None = None
    limit_type: str | None = None
    value: float | None = None


# =======================
# ModelPrice（全局价格表）
# unit: "input_token" | "output_token" | "cache_read_token" |
#       "cache_write_token" | "extra_context_token" | "request"
# price_per_unit: token 类为每 1M token USD；request 类为每次请求 USD
# =======================


class ModelPriceBase(SQLModel):
    model_name: str = Field(max_length=_NAME_LEN)
    unit: str = Field(max_length=64)
    price_per_unit: float
    context_length: int | None = None
    vendor: str | None = Field(default=None, max_length=_NAME_LEN)
    stability: str | None = Field(default=None, max_length=32)


class ModelPrice(ModelPriceBase, table=True):
    __tablename__ = "model_prices"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


class ModelPriceCreate(ModelPriceBase):
    pass


class ModelPriceUpdate(SQLModel):
    model_name: str | None = None
    unit: str | None = None
    price_per_unit: float | None = None
    context_length: int | None = None
    vendor: str | None = None
    stability: str | None = None


# =======================
# GroupModelPrice（Group 自定义价格，覆盖全局）
# =======================


class GroupModelPriceBase(SQLModel):
    group_id: str = Field(foreign_key="user_groups.id", max_length=_ID_LEN)
    model_name: str = Field(max_length=_NAME_LEN)
    unit: str = Field(max_length=64)
    price_per_unit: float


class GroupModelPrice(GroupModelPriceBase, table=True):
    __tablename__ = "group_model_prices"
    id: str = Field(default_factory=lambda: uuid4().hex, primary_key=True, max_length=_ID_LEN)
    created_at: str = Field(default_factory=utcnow, max_length=_TS_LEN)


class GroupModelPriceCreate(GroupModelPriceBase):
    pass


class GroupModelPriceUpdate(SQLModel):
    model_name: str | None = None
    unit: str | None = None
    price_per_unit: float | None = None


# =======================
# RateLimitCounter（限流计数器，DB 实现状态表）
# =======================


class RateLimitCounter(SQLModel, table=True):
    """固定窗口限流计数器，替代 Redis ZSET 滑动窗口（去 Redis 化改造）。

    - subject_key：限流主体（group 级或 per-user 级），格式与原 Redis key 一致，
      由 services.rate_limit_db.build_key 生成
    - window_start：固定窗口起点（epoch 秒，int(now // window_sec) * window_sec）
    - count：计数型（request_limit）窗口内成功转发的请求数
    - amount：求和型（token_limit / quota_limit）窗口内累计值

    检查（读）与记录（原子 UPSERT 递增）分离，语义与原 Redis 实现对齐：
    被拒绝/失败的请求不计入。过期行由写入路径机会式清理，无需定时任务。
    """
    __tablename__ = "rate_limit_counters"
    subject_key: str = Field(primary_key=True, max_length=512)
    limit_type: str = Field(primary_key=True, max_length=32)
    window_start: int = Field(primary_key=True)
    count: int = Field(default=0)
    amount: float = Field(default=0)


# =======================
# AppConfig（运行时配置，原 data/config.yaml 入库）
# =======================


class AppConfig(SQLModel, table=True):
    """单行配置表（id=1）。多实例部署下 refresh_models 写库即时一致，
    替代"写本地 YAML + 进程内存缓存"的旧方案。"""
    __tablename__ = "app_config"
    id: int = Field(primary_key=True, default=1)
    data: str = Field(default="{}", sa_type=Text)  # JSON string（含模型列表，可能很大）
