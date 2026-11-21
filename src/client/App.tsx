import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "@/lib/auth";
import { ConfirmProvider } from "@/lib/confirm";
import { LoginPage, ReceptionLoginPage, RegisterPage, SetupPage } from "@/pages/AuthPages";
import { HomePage } from "@/pages/Home";
import { useOnline } from "@/lib/useOnline";

/** 端末が回線に届いていないときの表示(ログイン画面を含むすべての画面の上に出る) */
function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div role="status" className="sticky top-0 z-30 bg-amber-400 px-4 py-2 text-center text-sm font-bold text-black">
      通信できません。画面とカートはそのまま使えますが、決済・チャージは電波が戻るまでできません
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ConfirmProvider>
      <BrowserRouter>
        <OfflineBanner />
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/qr-login" element={<ReceptionLoginPage />} />
          <Route path="/reception-login" element={<Navigate to="/qr-login" replace />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      </ConfirmProvider>
    </AuthProvider>
  );
}
