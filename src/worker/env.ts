import type { Role } from "@shared/roles";

export interface Bindings {
  DB: D1Database;
  /** 初回の全体管理者作成にだけ使うトークン(未設定なら /api/setup は無効) */
  SETUP_TOKEN?: string;
  /** 物理カードPINのハッシュに混ぜる秘密値 */
  PIN_PEPPER?: string;
}

export interface AuthContext {
  sessionHash: string;
  userId: string;
  role: Role;
  nickname: string;
  loginId: string | null;
  shopId: string | null;
}

export interface Variables {
  auth: AuthContext | null;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
