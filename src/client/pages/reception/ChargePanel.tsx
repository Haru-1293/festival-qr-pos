import { Banknote, CircleCheck, HandCoins, ScanLine } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CashOpResult, LookupResponse } from "@shared/api";
import { cashToUnits, unitsToCash } from "@shared/currency";
import { QrScanner, scannerSupported } from "@/components/QrScanner";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiRequestError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useRequestId } from "@/lib/useRequestId";
import { cn, yen } from "@/lib/utils";

type Mode = "charge" | "payout";
type Done = { kind: Mode; data: CashOpResult; nickname: string | null };

const QUICK_AMOUNTS = [500, 1000, 2000, 3000, 5000];
/** この場合は、読み取りをやり直す必要がある */
const RESCAN_CODES = new Set(["LOOKUP_EXPIRED", "LOOKUP_NOT_FOUND", "BALANCE_CHANGED", "WALLET_INACTIVE"]);

/** お客様のQRを読み取り、現金チャージまたは払い戻しを行う */
export function ChargePanel({ onChanged }: { onChanged: () => void }) {
  const { money, settings } = useAuth();
  const [lookup, setLookup] = useState<LookupResponse | null>(null);
  const [mode, setMode] = useState<Mode>("charge");
  const [cash, setCash] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [scanning, setScanning] = useState(false);
  const [token, setToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const look = useAction();
  const op = useAction();
  const reqId = useRequestId();
  const short = settings.currency.shortName;

  useEffect(() => {
    if (!lookup) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [lookup]);

  const reset = useCallback(() => {
    setLookup(null);
    setCash("");
    setConfirming(false);
    setDone(null);
    setToken("");
    setLocalError(null);
    look.setError(null);
    op.setError(null);
    reqId.renew();
  }, [look, op, reqId]);

  const doLookup = useCallback(
    (value: string) => {
      void look.run(async () => {
        const res = await api<LookupResponse>("/reception/lookup", { body: { token: value.trim() } });
        setLookup(res);
        setMode("charge");
        setCash("");
        setConfirming(false);
        setDone(null);
        setToken("");
        setLocalError(null);
        op.setError(null);
        reqId.renew();
      });
    },
    [look, op, reqId],
  );

  const onScan = useCallback(
    (value: string) => {
      setScanning(false);
      doLookup(value);
    },
    [doLookup],
  );

  const cashNum = Number(cash);
  const cashValid = cash !== "" && Number.isInteger(cashNum) && cashNum > 0;
  const units = lookup && cashValid ? cashToUnits(cashNum, lookup.yenPerUnit) : null;
  const payoutCash = lookup ? unitsToCash(lookup.wallet.balance, lookup.yenPerUnit) : null;
  const active = lookup?.wallet.status === "ACTIVE";
  const remainingSec = lookup ? Math.max(0, Math.floor((lookup.expiresAt - now) / 1000)) : 0;

  const goConfirm = () => {
    setLocalError(null);
    if (mode === "charge") {
      if (!cashValid) return setLocalError("受け取った現金を入力してください");
      if (units === null) return setLocalError(`${yen(cashNum)}は${short}に換算できません(1${short}=${lookup?.yenPerUnit}円)`);
    } else if (!lookup || lookup.wallet.balance <= 0) {
      return setLocalError("払い戻せる残高がありません");
    } else if (payoutCash === null) {
      return setLocalError("現金に換算できないため払い戻せません。運営にご相談ください");
    }
    setConfirming(true);
  };

  const submit = () => {
    if (!lookup) return;
    void op.run(async () => {
      try {
        const data =
          mode === "charge"
            ? await api<CashOpResult>("/reception/charge", { body: { lookupId: lookup.lookupId, requestId: reqId.get(), cashAmount: cashNum } })
            : await api<CashOpResult>("/reception/payout", {
                body: { lookupId: lookup.lookupId, requestId: reqId.get(), expectedBalance: lookup.wallet.balance },
              });
        setDone({ kind: mode, data, nickname: lookup.wallet.nickname });
        setLookup(null);
        setConfirming(false);
        reqId.renew();
        onChanged();
      } catch (e) {
        // 読み取りの期限切れ・残高の変化などは、QRの読み取りからやり直す
        if (e instanceof ApiRequestError && RESCAN_CODES.has(e.code)) {
          setLookup(null);
          setConfirming(false);
          reqId.renew();
        }
        throw e;
      }
    });
  };

  // ---------- 完了 ----------
  if (done) {
    const isCharge = done.kind === "charge";
    return (
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center gap-2 bg-secondary px-4 py-6 text-center">
          <CircleCheck className="size-14 text-primary" />
          <p className="text-xl font-extrabold">{isCharge ? "チャージしました" : "払い戻しました"}</p>
          {done.data.replayed && <Badge variant="warning">再送のため、前回の結果を表示しています</Badge>}
          <p className="text-sm text-muted-foreground">{done.nickname ?? "お客様"} さん</p>
        </div>
        <CardContent className="flex flex-col gap-3 pt-4">
          <Row label={isCharge ? "受け取った現金" : "お渡しする現金"} value={yen(done.data.cashAmount)} big />
          <Row label={isCharge ? "チャージ額" : "払い戻した額"} value={money(done.data.units)} />
          <Row label="現在の残高" value={money(done.data.balanceAfter)} />
          <Row label="取引番号" value={done.data.txNo} />
          {!isCharge && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">現金をお渡しください: {yen(done.data.cashAmount)}</p>}
          <Button size="lg" onClick={reset}>
            次のお客様へ
          </Button>
        </CardContent>
      </Card>
    );
  }

  // ---------- QR読み取り前 ----------
  if (!lookup) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>お客様のQRを読み取る</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {scanning && <QrScanner onScan={onScan} onClose={() => setScanning(false)} />}
          <p className="text-sm text-muted-foreground">お客様のスマホに「提示用QR」を表示してもらい、読み取ってください。読み取ったQRはその場で使えなくなります。</p>
          <Button size="lg" className="h-16 text-lg" onClick={() => setScanning(true)} disabled={look.pending || !scannerSupported()}>
            <ScanLine className="!size-6" /> QRを読み取る
          </Button>
          <ErrorText message={look.error ?? op.error} />
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">{scannerSupported() ? "読み取れないとき(文字列を入力)" : "カメラが使えない端末です(文字列を入力)"}</summary>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                doLookup(token);
              }}
            >
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="FES1:U:…" autoCapitalize="none" autoCorrect="off" />
              <Button type="submit" variant="outline" disabled={look.pending || !token.trim()}>
                確認
              </Button>
            </form>
          </details>
        </CardContent>
      </Card>
    );
  }

  // ---------- QR読み取り後 ----------
  const w = lookup.wallet;
  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        <div className="bg-secondary px-4 py-4">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-base font-bold">{w.nickname ?? "お客様"} さん</p>
            {!active && <Badge variant="warning">利用停止中</Badge>}
          </div>
          <p className="mt-1 text-sm text-secondary-foreground">現在の残高</p>
          <p className="text-4xl font-extrabold tracking-tight">{money(w.balance)}</p>
          <p className={cn("mt-1 text-xs", remainingSec <= 60 ? "font-semibold text-destructive" : "text-muted-foreground")}>
            {remainingSec > 0 ? `この読み取りの有効時間: あと ${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}` : "有効時間が切れました。QRを読み取り直してください"}
          </p>
        </div>
      </Card>

      {!active ? (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <p className="text-sm font-medium text-amber-800">このお客様は利用が停止されているため、チャージ・払い戻しはできません。運営にご連絡ください。</p>
            <Button variant="outline" onClick={reset}>
              やめる
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-4 pt-4">
            <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-accent p-1">
              {(["charge", "payout"] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  disabled={confirming || op.pending}
                  onClick={() => {
                    setMode(m);
                    setLocalError(null);
                  }}
                  className={cn("h-11 rounded-lg text-sm font-semibold", mode === m ? "bg-card shadow-sm" : "text-muted-foreground")}
                >
                  {m === "charge" ? "チャージ" : "払い戻し"}
                </button>
              ))}
            </div>

            {mode === "charge" ? (
              <>
                <label className="flex flex-col gap-1.5">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Banknote className="size-4" /> 受け取った現金(円)
                  </span>
                  <Input
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={cash}
                    disabled={confirming || op.pending}
                    onChange={(e) => setCash(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="例: 1000"
                    className="h-14 text-2xl font-bold"
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  {QUICK_AMOUNTS.map((a) => (
                    <button
                      key={a}
                      disabled={confirming || op.pending}
                      onClick={() => setCash(String(a))}
                      className="h-11 min-w-[4.5rem] rounded-lg border border-input bg-card px-3 text-sm font-semibold hover:bg-accent"
                    >
                      {a.toLocaleString()}
                    </button>
                  ))}
                </div>
                {units !== null && (
                  <div className="rounded-lg bg-muted px-3 py-2 text-sm">
                    <p>
                      チャージ額 <b>{money(units)}</b>
                    </p>
                    <p className="text-muted-foreground">チャージ後の残高 {money(w.balance + units)}</p>
                  </div>
                )}
              </>
            ) : (
              <div className="rounded-lg bg-muted px-3 py-3 text-sm">
                <p>
                  払い戻す額 <b>{money(w.balance)}</b>(残高の全額)
                </p>
                <p className="mt-1 text-lg font-extrabold">お渡しする現金 {payoutCash === null ? "—" : yen(payoutCash)}</p>
                <p className="mt-1 text-xs text-muted-foreground">払い戻しは学園祭期間内の受付で、残高の全額を現金でお返しします。</p>
              </div>
            )}

            <ErrorText message={localError ?? op.error} />

            {!confirming ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}>
                  やめる
                </Button>
                <Button className="flex-1" size="lg" onClick={goConfirm} disabled={mode === "payout" && w.balance <= 0}>
                  {mode === "charge" ? "内容を確認する" : <><HandCoins /> 内容を確認する</>}
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-xl border-2 border-primary p-3">
                <p className="text-base font-bold">
                  {mode === "charge" ? `${yen(cashNum)} を受け取りましたか?` : `${payoutCash === null ? "" : yen(payoutCash)} をお渡しします`}
                </p>
                <p className="text-sm text-muted-foreground">
                  {mode === "charge" ? `${money(units ?? 0)} をチャージします。` : "確定すると残高が0になります。確定後に現金をお渡しください。"}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setConfirming(false)} disabled={op.pending}>
                    戻る
                  </Button>
                  <Button className="flex-1" size="lg" onClick={submit} disabled={op.pending}>
                    {op.pending ? "処理中…" : mode === "charge" ? "チャージを確定" : "払い戻しを確定"}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={big ? "text-2xl font-extrabold" : "font-semibold"}>{value}</span>
    </div>
  );
}
