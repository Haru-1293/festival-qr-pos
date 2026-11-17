import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .email("メールアドレスの形式が正しくありません")
  .transform((s) => s.toLowerCase());

export const passwordSchema = z
  .string()
  .min(8, "パスワードは8文字以上にしてください")
  .max(128, "パスワードは128文字以内にしてください");

export const nicknameSchema = z.string().trim().min(1, "ニックネームを入力してください").max(20, "ニックネームは20文字以内にしてください");

/** スタッフ(店員・店舗責任者・全体管理者)のログインID。メール形式でなくてもよい */
export const staffLoginIdSchema = z
  .string()
  .trim()
  .min(3, "ログインIDは3文字以上にしてください")
  .max(100)
  .regex(/^[A-Za-z0-9._@+-]+$/, "ログインIDは英数字と . _ @ + - だけが使えます")
  .transform((s) => s.toLowerCase());
