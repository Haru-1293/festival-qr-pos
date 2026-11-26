import { CircleCheck, CreditCard } from "lucide-react";
import { useState } from "react";
import type { CashOpResult, LookupResponse } from "@shared/api";
import { cashToUnits } from "@shared/currency";
import { PinPad } from "@/components/PinPad";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { useRequestId } from "@/lib/useRequestId";
import { yen } from "@/lib/utils";

interface ActivateResponse {
  lookup: LookupResponse;
  charge: CashOpResult | null;
  chargeError: string | null;
  replayed: boolean;
}

const QUICK_AMOUNTS = [500, 1000, 2000, 3000, 5000];

/** 未有効のカードを、受付でその場で有効化する(ニックネームとPINを決め、希望すればそのままチャージ) */
export function ActivateCardForm({ token, onCancel, onChanged, onContinue }: { token: string; onCancel: () => void; onChanged: () => void; onContinue: (lookup: LookupResponse) => void }) {
  const { money, settings } = useAuth();
  const short = settings.currency.shortName;
  const [nickname, setNickname] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [cash, setCash] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [res, setRes] = useState<ActivateResponse | null>(null);
  const op = useAction();
  const reqId = useRequestId();
  const yenPerUnit = settings.currency.yenPerUnit;

  const cashNum = cash === "" ? 0 : Number(cash);
  const units = cashNum > 0 ? cashToUnits(cashNum, yenPerUnit) : 0;

  const goConfirm = () => {
    setLocalError(null);
    if (!nickname.trim()) return setLocalError("ニックネームを入力してください");
    if (!/^\d{4}$/.test(pin)) return setLocalError("PINは数字4桁で入力してください");
    if (pin !== pin2) return setLocalError("PINが一致しません。もう一度入力してください");
    if (cashNum > 0 && units === null) return setLocalError(`${yen(cashNum)}は${short}に換算できません(1${short}=${yenPerUnit}円)`);
    setConfirming(true);
  };

  const submit = () =>
    void op.run(async () => {
      const r = await api<ActivateResponse>("/reception/activate-card", {
        body: { token, nickname: nickname.trim(), pin, cashAmount: cashNum, requestId: reqId.get() },
      });
      setPin("");
      setPin2("");
      setConfirming(false);
      setRes(r);
      reqId.renew();
      onChanged();
    });

  if (res) {
    return (
      <Card className="overflow-hidden">
        <div className="flex flex-col items-center gap-2 bg-secondary px-4 py-6 text-center">
          <CircleCheck className="size-14 text-primary" />
          <p className="text-xl font-extrabold">カードを有効化しました</p>
          <p className="text-sm text-muted-foreground">
            {res.lookup.wallet.nickname ?? "お客様"} さん ・ カード {res.lookup.card?.displayNo}
          </p>
          {res.replayed && <Badge variant="warning">再送のため、前回の結果を表示しています</Badge>}
        </div>
        <CardContent className="flex flex-col gap-3 pt-4">
          {res.charge && (
            <>
              <Row label="受け取った現金" value={yen(res.charge.cashAmount)} big />
              <Row label="チャージ額" value={money(res.charge.units)} />
              <Row label="取引番号" value={res.charge.txNo} />
            </>
          )}
          <Row label="現在の残高" value={money(res.lookup.wallet.balance)} />
          {res.chargeError && (
            <div className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900">
              カードは有効化できましたが、チャージはできませんでした({res.chargeError})。現金はお返しして、下の「チャージに進む」からやり直してください。
            </div>
          )}
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">PINはお客様ご本人が覚えておいてください。現金の払い戻しのときに必要です。</p>
          {res.chargeError && (
            <Button size="lg" variant="outline" onClick={() => onContinue(res.lookup)}>
              チャージに進む
            </Button>
          )}
          <Button size="lg" onClick={onCancel}>
            次のお客様へ
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CreditCard className="size-5" /> カードを有効化する
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">このカードはまだ有効化されていません。お客様にニックネームとPIN(数字4桁)を決めてもらい、有効化します。チャージも同時にできます。</p>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">ニックネーム(30文字まで)</span>
          <Input value={nickname} maxLength={30} onChange={(e) => setNickname(e.target.value)} placeholder="例: たろう" disabled={op.pending} />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">PIN(数字4桁・お客様に入力してもらう)</span>
          <PinPad value={pin} onChange={setPin} disabled={op.pending} />
          <span className="text-sm font-medium">もう一度PINを入力</span>
          <PinPad value={pin2} onChange={setPin2} disabled={op.pending} />
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">同時にチャージする現金(円・なしでもOK)</span>
          <Input inputMode="numeric" pattern="[0-9]*" value={cash} disabled={op.pending} onChange={(e) => setCash(e.target.value.replace(/[^0-9]/g, ""))} placeholder="例: 1000" className="h-12 text-xl font-bold" />
        </label>
        <div className="flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((a) => (
            <button key={a} type="button" disabled={op.pending} onClick={() => setCash(String(a))} className="h-11 min-w-[4.5rem] rounded-lg border border-input bg-card px-3 text-sm font-semibold hover:bg-accent">
              {a.toLocaleString()}
            </button>
          ))}
          {cash !== "" && (
            <button type="button" onClick={() => setCash("")} className="h-11 rounded-lg border border-input px-3 text-sm text-muted-foreground">
              クリア
            </button>
          )}
        </div>
        {cashNum > 0 && units !== null && <p className="rounded-lg bg-muted px-3 py-2 text-sm">チャージ額 <b>{money(units)}</b></p>}
        <ErrorText message={localError ?? (confirming ? null : op.error)} />
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel} disabled={op.pending}>
            やめる
          </Button>
          <Button className="flex-1" size="lg" onClick={goConfirm} disabled={op.pending}>
            内容を確認する
          </Button>
        </div>
      </CardContent>

      <Dialog
        open={confirming}
        onOpenChange={(o) => {
          if (!o && !op.pending) setConfirming(false);
        }}
      >
        <DialogContent hideClose={op.pending} onInteractOutside={(e) => e.preventDefault()}>
          <DialogTitle>このカードを有効化しますか?</DialogTitle>
          <DialogDescription>{cashNum > 0 ? `現金 ${yen(cashNum)} を受け取り、${money(units ?? 0)} をチャージします。` : "チャージはせずに有効化だけ行います。"}</DialogDescription>
          <div className="rounded-lg bg-muted px-3 py-2 text-sm">
            <p>
              ニックネーム: <b>{nickname.trim()}</b>
            </p>
            <p className="text-muted-foreground">PIN: ●●●●(お客様がご確認済み)</p>
          </div>
          <ErrorText message={op.error} />
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={op.pending}>
              戻る
            </Button>
            <Button className="flex-1" size="lg" onClick={submit} disabled={op.pending}>
              {op.pending ? "処理中…" : "有効化する"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
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
