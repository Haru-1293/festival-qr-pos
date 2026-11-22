import type { Role } from "@shared/roles";

/** 役割ごとのトップページ(URLは役割ごとに分かれている) */
export const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  SHOP_MANAGER: "/shop",
  CLERK: "/clerk",
  RECEPTION: "/reception",
  CUSTOMER: "/my",
};

/** 役割ごとのログイン画面 */
export const ROLE_LOGIN: Record<Role, string> = {
  ADMIN: "/admin/login",
  SHOP_MANAGER: "/shop/login",
  CLERK: "/clerk/login",
  RECEPTION: "/reception/login",
  CUSTOMER: "/login",
};
