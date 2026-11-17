import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { badRequest } from "./errors";

/** zValidator の薄いラッパー。検証エラーを統一したエラー形式(400 / VALIDATION)で返す */
export function zv<T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      throw badRequest(`${field}${issue?.message ?? "入力が正しくありません"}`, "VALIDATION");
    }
  });
}
