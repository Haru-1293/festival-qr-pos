export const ROLES = ["CUSTOMER", "CLERK", "SHOP_MANAGER", "RECEPTION", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "全体管理者",
  SHOP_MANAGER: "店舗責任者",
  CLERK: "店員",
  RECEPTION: "受付担当者",
  CUSTOMER: "顧客",
};

/** 店舗に所属する役割(users.shop_id が必須) */
export const SHOP_ROLES = ["CLERK", "SHOP_MANAGER"] as const satisfies readonly Role[];

export function isShopRole(role: Role): boolean {
  return role === "CLERK" || role === "SHOP_MANAGER";
}

export const USER_STATUSES = ["ACTIVE", "SUSPENDED", "DELETED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SHOP_STATUSES = ["ACTIVE", "SUSPENDED", "CLOSED"] as const;
export type ShopStatus = (typeof SHOP_STATUSES)[number];
