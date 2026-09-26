"""支付发货：支付成功后按订单内的套餐快照铸造预付 API key。

铸 key 规则与匿名兑卡（redeem_voucher_anonymously）一致：
- 额度 = 套餐 credit_usd（用尽即 402）
- 有效期 = duration_days 天（未设置则不限时）
- 分组 = 套餐绑定分组，未绑定则 default 组
  （无分组且无用户名的 key 会被余额检查直接拒绝，必须绑组）
"""

from datetime import datetime, timedelta, timezone

from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from db.models import PaymentOrder, Token, UserGroup


def _utcnow_z() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def _resolve_group(session: AsyncSession, group_id: str | None) -> UserGroup | None:
    group: UserGroup | None = None
    if group_id:
        group = (
            await session.execute(select(UserGroup).where(UserGroup.id == group_id))
        ).scalar_one_or_none()
    if group is None:
        group = (
            await session.execute(
                select(UserGroup).where(UserGroup.name == "default")
            )
        ).scalar_one_or_none()
    return group


async def mark_order_paid_and_deliver(
    session: AsyncSession,
    order: PaymentOrder,
    *,
    pay_amount_cny_cents: int | None = None,
    paid_at: str | None = None,
) -> PaymentOrder:
    """将订单置为已支付并发货（铸 key）。幂等：credited_at 已置则只回填支付信息、不重复发 key。

    支付回调与人工补单共用；调用方负责 commit。
    """
    if pay_amount_cny_cents is not None and order.pay_amount_cny_cents is None:
        order.pay_amount_cny_cents = pay_amount_cny_cents
    if paid_at and not order.paid_at:
        order.paid_at = paid_at
    if order.status != "paid":
        order.status = "paid"
    session.add(order)

    if order.credited_at:
        return order  # 已发货，幂等返回

    now = datetime.now(timezone.utc)
    if order.duration_days:
        key_expires_at = (
            (now + timedelta(days=order.duration_days))
            .isoformat()
            .replace("+00:00", "Z")
        )
    else:
        key_expires_at = None

    group = await _resolve_group(session, order.group_id)

    token = Token(
        name=f"pay-{order.biz_order_id[3:11]}",  # biz_order_id 形如 po-xxxxxxxx
        quota_usd=order.credit_usd,
        expires_at=key_expires_at,
        group_id=group.id if group else None,
        username=order.username,
    )
    session.add(token)
    await session.flush()  # 取 token.id

    order.token_id = token.id
    order.credited_at = _utcnow_z()
    session.add(order)

    logger.info(
        f"支付发货 order={order.biz_order_id} -> token={token.id[:8]} "
        f"quota=${order.credit_usd} duration_days={order.duration_days} "
        f"group={group.name if group else None} username={order.username}"
    )
    return order


async def get_order_key(session: AsyncSession, order: PaymentOrder) -> str | None:
    """发货后取订单对应 key 的明文；未发货/Token 已删除返回 None。"""
    if not order.token_id:
        return None
    token = (
        await session.execute(select(Token).where(Token.id == order.token_id))
    ).scalar_one_or_none()
    return token.key if token else None
