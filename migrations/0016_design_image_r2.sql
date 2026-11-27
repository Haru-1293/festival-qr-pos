-- 背景画像をR2に置いたとき、その参照キー(image と同時には使わない)
ALTER TABLE print_templates ADD COLUMN image_key TEXT;
