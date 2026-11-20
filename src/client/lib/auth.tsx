import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { EmergencyState, MeResponse } from "@shared/api";
import { DEFAULT_CURRENCY, formatMoney, type CurrencySettings } from "@shared/currency";
import { ApiRequestError, api } from "./api";

interface PublicSettings {
  currency: CurrencySettings;
  festivalName: string;
  /** 緊急停止中か(お金が動く操作が止まる) */
  emergency: EmergencyState;
}

interface AuthState {
  me: MeResponse | null;
  loading: boolean;
  settings: PublicSettings;
  money: (amount: number) => string;
  setMe: (me: MeResponse | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const FALLBACK: PublicSettings = { currency: DEFAULT_CURRENCY, festivalName: "学園祭", emergency: { on: false, message: "" } };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<PublicSettings>(FALLBACK);

  const refresh = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([
        api<MeResponse>("/auth/me").catch((e: unknown) => {
          if (e instanceof ApiRequestError && e.status === 401) return null;
          throw e;
        }),
        api<PublicSettings>("/settings/public").catch(() => FALLBACK),
      ]);
      setMe(m);
      setSettings(s);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 緊急停止の開始・解除を、開いたままの画面にも約15秒以内に反映する(失敗したときは今の表示を変えない)
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api<PublicSettings>("/settings/public")
        .then((s) => setSettings((cur) => (cur.emergency.on === s.emergency.on && cur.emergency.message === s.emergency.message ? cur : { ...cur, emergency: s.emergency })))
        .catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(t);
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setMe(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      settings,
      money: (n: number) => formatMoney(n, settings.currency),
      setMe,
      refresh,
      logout,
    }),
    [me, loading, settings, refresh, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider が必要です");
  return ctx;
}
