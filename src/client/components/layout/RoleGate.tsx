import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { ROLE_LABELS, type Role } from "@shared/roles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/roleHome";
import { Link } from "react-router-dom";

/** 指定した役割でログインしているときだけ中身を出す。未ログインならその役割のログイン画面へ */
export function RoleGate({ roles, loginPath, children }: { roles: Role[]; loginPath: string; children: ReactNode }) {
  const { me, loading, logout } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">読み込み中…</div>;
  if (!me) return <Navigate to={loginPath} replace state={{ from: loc.pathname }} />;
  if (!roles.includes(me.user.role)) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle>このアカウントでは使えません</CardTitle>
            <CardDescription>
              {ROLE_LABELS[me.user.role]}としてログインしています。このページは {roles.map((r) => ROLE_LABELS[r]).join("・")} 用です。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button asChild>
              <Link to={ROLE_HOME[me.user.role]}>自分のページへ</Link>
            </Button>
            <Button variant="outline" onClick={() => void logout()}>
              ログアウトして別のアカウントで入る
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <>{children}</>;
}
