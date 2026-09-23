-- migrations/add_channel_ws_fields.sql
-- 为 channels 表添加 WebSocket 上游相关字段（protocol / ws_path / ws_subprotocols）
-- 适用于 SQLite 和 PostgreSQL
-- 生产环境手动执行此脚本；开发环境 SQLite 内存库由 init_db() 自动加列

ALTER TABLE channels ADD COLUMN protocol VARCHAR(16) DEFAULT 'http';
ALTER TABLE channels ADD COLUMN ws_path VARCHAR(512);
ALTER TABLE channels ADD COLUMN ws_subprotocols TEXT;
