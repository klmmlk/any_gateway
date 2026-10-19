-- usage_logs 加 characters 列：TTS 类请求按字符计费的用量记录（幂等：列已存在时本语句报错被上层吞掉）
ALTER TABLE usage_logs ADD COLUMN characters INTEGER DEFAULT 0;
