-- migrations/add_usage_log_audio_seconds.sql
-- 为 usage_logs 表添加 audio_seconds 字段（ASR 按音频时长计费）
-- 适用于 SQLite 和 PostgreSQL
-- 生产环境手动执行此脚本；开发环境 SQLite 内存库由 init_db() 自动加列

ALTER TABLE usage_logs ADD COLUMN audio_seconds REAL DEFAULT 0;
