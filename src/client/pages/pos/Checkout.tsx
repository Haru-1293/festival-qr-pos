import { ArrowLeft, CircleCheck, Minus, Plus, ScanLine, Ticket, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PayResult, PaySession, PayStatus, ProductDto, Quote, QuoteDiscount, QuoteLine, SetDto } from "@shared/api";
import { PinPad } from "@/components/PinPad";
import { QrScanner, scannerSupported } from "@/components/QrScanner";
import { ErrorText } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiRequestError, api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { viewCartLine } from "@/lib/cartView";
import { type Cart, toCartItems } from "@/lib/useCart";
import { useRequestId } from "@/lib/useRequestId";
import { cn, formatDateTime } from "@/lib/utils";

type Step = "cart" | "scan" | "pin" | "confirm" | "unknown" | "done";
/** PINを続けて間違えたら、お客様のQR(カード)を読み取り直す。画面側の制限(サーバーはカード単位でロックしない) */
const MAX_PIN_TRIES = 3;

interface Props {
  shopId: string;
  products: ProductDto[];
  sets: SetDto[];
  cart: Cart;
  onChange: (key: string, by: number) => void;
  onRemove: (id: string) => void;
  onFinished: () => void;
  onClose: () => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** カート確認 → お客様のQR読み取り → 支払い確定。価格はサーバーが確定の瞬間に再計算する */
export function Checkout({ shopId, products, sets, cart, onChange, onRemove, onFinished, onClose }: Props) {
  const { money } = useAuth();
  const [step, setStep] = useState<Step>("cart");
  const [session, setSession] = useState<PaySession | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [result, setResult] = useState<PayResult | null>(null);
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [pin, setPin] = useState("");
  const [pinTries, setPinTries] = useState(0);
  // クーポン: 入力欄の文字(codeInput)と、適用ボタンで確定したコード(coupon)。見積もりはサーバーが計算する
  const [codeInput, setCodeInput] = useState("");
  const [coupon, setCoupon] = useState("");
  const [preview, setPreview] = useState<Quote | null>(null);
  const reqId = useRequestId();
  const renewReq = reqId.renew;

  const rows = cart.map((l) => ({
    line: l,
    v: viewCartLine(l, products, sets),
  }));
  const unavailable = rows.some((r) => r.v.problem !== null);
  const localTotal = rows.reduce((s, r) => s + r.v.unit * r.line.quantity, 0);
  const items = toCartItems(cart);

  const displayTotal = preview && preview.problems.length === 0 ? preview.total : localTotal;

  // 読み取りの関数(カメラの再起動を避けるため固定)から、いつでも最新のカートを読めるようにする
  const latest = useRef({ items, localTotal: displayTotal, coupon });
  latest.current = { items, localTotal: displayTotal, coupon };

  // カートが変わったら、割引・クーポンを含めた見積もりをサーバーに計算してもらう
  const itemsKey = JSON.stringify(items);
  useEffect(() => {
    if (step !== "cart" && step !== "scan") return;
    if (items.length === 0) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      api<Quote>(`/pos/${shopId}/pay/quote`, {
        body: { items, couponCode: coupon || undefined },
      })
        .then((q) => alive && setPreview(q))
        .catch(() => alive && setPreview(null));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, coupon, shopId, step]);

  useEffect(() => {
    if (step !== "confirm" && step !== "pin") return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [step]);

  /** 買えない商品などで読み取りが断られたとき、理由を見せてカートへ戻す */
  const showCartProblem = (e: unknown) => {
    const q = (e instanceof ApiRequestError ? (e.details as { quote?: Quote } | undefined)?.quote : undefined) ?? null;
    setError(q?.problems?.length ? q.problems.map((p) => p.message).join(" / ") : errorMessage(e));
    setStep("cart");
  };

  const scan = useCallback(
    async (value: string) => {
      setScanning(false);
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const s = await api<PaySession>(`/pos/${shopId}/pay/scan`, {
          body: {
            token: value.trim(),
            items: latest.current.items,
            couponCode: latest.current.coupon || undefined,
          },
        });
        setSession(s);
        setQuote(s.quote);
        setToken("");
        renewReq();
        setNow(Date.now());
        if (s.quote.total !== latest.current.localTotal) setNotice("価格が更新されました。新しい合計を確認してください");
        setPin("");
        setPinTries(0);
        setStep(s.card ? "pin" : "confirm");
      } catch (e) {
        if (e instanceof ApiRequestError && e.code === "CART_UNAVAILABLE") showCartProblem(e);
        else if (e instanceof ApiRequestError && e.code === "COUPON_INVALID") {
          // QRは消費されていない。クーポンを外すか直してから、もう一度読み取れる
          setError(`${e.message}(クーポンを外すか、別のコードを入力してください。お客様のQRは使われていません)`);
          setStep("cart");
        } else setError(errorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shopId, renewReq],
  );

  /** 結果が分からないとき(通信断など)、同じ決済の状態をサーバーに問い合わせる */
  const checkResult = useCallback(
    async (sessionId: string): Promise<boolean> => {
      for (let i = 0; i < 8; i++) {
        try {
          const st = await api<PayStatus>(`/pos/${shopId}/pay/${sessionId}`);
          if (st.status === "COMMITTED" && st.result) {
            setResult(st.result);
            setStep("done");
            return true;
          }
          if (st.status !== "OPEN") {
            setError("この決済は成立していません。お客様のQRを読み取り直してください");
            setStep("scan");
            return true;
          }
          return false; // まだ決済されていない(確定を押し直せる)
        } catch {
          await sleep(2000);
        }
      }
      return false;
    },
    [shopId],
  );

  const commit = async () => {
    if (!session || !quote) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api<PayResult>(`/pos/${shopId}/pay/${session.sessionId}/commit`, {
        body: {
          requestId: reqId.get(),
          expectedTotal: quote.total,
          ...(session.card ? { pin } : {}),
        },
      });
      setPin("");
      setResult(r);
      setStep("done");
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 0) {
        // 送ったかどうか分からない。勝手にやり直さず、まず結果を照会する(二重決済を防ぐ)
        setStep("unknown");
        const known = await checkResult(session.sessionId);
        if (!known) setStep("confirm");
        if (!known) setError("通信が不安定です。まだ支払いは確定していません。もう一度「確定」を押してください(二重には引かれません)");
        return;
      }
      if (e instanceof ApiRequestError) {
        const d = e.details as { quote?: Quote } | undefined;
        if (e.code === "PRICE_CHANGED" && d?.quote) {
          setQuote(d.quote);
          reqId.renew();
          setNotice(`価格が変わりました。新しい合計は ${money(d.quote.total)} です。確認して、もう一度確定してください`);
          return;
        }
        if (e.code === "CART_UNAVAILABLE") {
          showCartProblem(e);
          setError(`${errorMessage(e)}(お客様のQRは読み取り済みです。カートを直して、もう一度QRを表示してもらってください)`);
          return;
        }
        if (e.code === "PIN_INVALID") {
          const tries = pinTries + 1;
          setPin("");
          setPinTries(tries);
          if (tries >= MAX_PIN_TRIES) {
            // 3回間違えたら、この読み取りは終わり。カードを読み取り直してもらう
            await api(`/pos/${shopId}/pay/${session.sessionId}/cancel`, {
              body: {},
            }).catch(() => undefined);
            setSession(null);
            setQuote(null);
            setError(`PINを${MAX_PIN_TRIES}回間違えました。もう一度カードを読み取ってください`);
            setStep("scan");
          } else {
            setError(`PINが違います(あと${MAX_PIN_TRIES - tries}回)`);
            setStep("pin");
          }
          return;
        }
        if (e.code === "CARD_INACTIVE") {
          setError(e.message);
          setSession(null);
          setStep("scan");
          return;
        }
        if (e.code === "SESSION_EXPIRED" || e.code === "SESSION_CANCELLED") {
          setError(e.message);
          setSession(null);
          setStep("scan");
          return;
        }
      }
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (session)
      await api(`/pos/${shopId}/pay/${session.sessionId}/cancel`, {
        body: {},
      }).catch(() => undefined);
    setSession(null);
    setQuote(null);
    setNotice("取り消しました。お客様は新しいQRを表示してください");
    setStep("cart");
  };

  // ---------- 完了 ----------
  if (step === "done" && result) {
    return (
      <div className="flex flex-col gap-3">
        <Card className="overflow-hidden">
          <div className="flex flex-col items-center gap-2 bg-secondary px-4 py-6 text-center">
            <CircleCheck className="size-12 text-primary" />
            <p className="text-lg font-extrabold">お支払いが完了しました</p>
            <p className="text-3xl font-extrabold tracking-tight">{money(result.total)}</p>
            <p className="text-sm text-secondary-foreground">残高 {money(result.balanceAfter)}</p>
          </div>
          <CardContent className="flex flex-col gap-1 pt-3 text-sm">
            {result.lines.map((l, i) => (
              <QuoteLineRow key={`${l.productId}-${i}`} l={l} />
            ))}
            <DiscountRows subtotal={result.subtotal} discounts={result.discounts} />
            <p className="mt-2 text-xs text-muted-foreground">
              取引番号 {result.orderNo} ・ {formatDateTime(result.paidAt)}
              {result.replayed && "(通信が切れたため、先ほどの結果を表示しています)"}
            </p>
          </CardContent>
        </Card>
        <Button size="lg" onClick={onFinished}>
          次のお客様へ
        </Button>
      </div>
    );
  }

  // ---------- 結果確認中 ----------
  if (step === "unknown") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
          <p className="text-lg font-bold">結果を確認しています…</p>
          <p className="text-sm text-muted-foreground">通信が切れました。支払いが完了したかを確認しています。このままお待ちください。</p>
        </CardContent>
      </Card>
    );
  }

  // ---------- 物理カード: PIN入力 ----------
  if (step === "pin" && session && quote) {
    const left = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
    return (
      <div className="flex flex-col gap-3">
        <Card className="overflow-hidden">
          <div className="bg-secondary px-4 py-4">
            <p className="text-sm text-secondary-foreground">
              {session.customer.nickname ?? "お客様"} さんのカード
              {session.card ? `(${session.card.displayNo})` : ""}
            </p>
            <p className="mt-1 text-4xl font-extrabold tracking-tight">{money(quote.total)}</p>
          </div>
          <CardContent className="flex flex-col gap-3 pt-4">
            <p className="text-center text-sm font-semibold">お客様に、4桁のPINを入力してもらってください</p>
            <PinPad value={pin} onChange={setPin} disabled={busy} />
            <ErrorText message={error} />
            <p className="text-center text-xs text-muted-foreground">
              この確認の有効時間 あと {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </p>
          </CardContent>
        </Card>
        <Button
          size="lg"
          onClick={() => {
            setError(null);
            setStep("confirm");
          }}
          disabled={pin.length !== 4 || left === 0}
        >
          次へ(内容の確認)
        </Button>
        <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
          取り消す
        </Button>
      </div>
    );
  }

  // ---------- 支払いの確認 ----------
  if (step === "confirm" && session && quote) {
    const left = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
    const after = session.customer.balance - quote.total;
    const short = after < 0;
    return (
      <div className="flex flex-col gap-3">
        <Card className="overflow-hidden">
          <div className="bg-secondary px-4 py-4">
            <p className="text-sm text-secondary-foreground">{session.customer.nickname ?? "お客様"} さん</p>
            <p className="text-sm text-muted-foreground">
              {session.card ? `カード ${session.card.displayNo} ・ ` : ""}残高 {money(session.customer.balance)}
            </p>
            <p className="mt-1 text-4xl font-extrabold tracking-tight">{money(quote.total)}</p>
            {quote.cut && (
              <Badge variant="destructive" className="mt-1">
                {quote.cut.name} 適用中
              </Badge>
            )}
          </div>
          <CardContent className="flex flex-col gap-1 pt-3 text-sm">
            {quote.lines.map((l, i) => (
              <QuoteLineRow key={`${l.productId}-${i}`} l={l} />
            ))}
            <DiscountRows subtotal={quote.subtotal} discounts={quote.discounts} />
            <p className={cn("mt-2 text-sm font-semibold", short && "text-destructive")}>{short ? `残高が ${money(-after)} 足りません` : `支払い後の残高 ${money(after)}`}</p>
            <p className="text-xs text-muted-foreground">
              この確認の有効時間 あと {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
            </p>
          </CardContent>
        </Card>
        {notice && (
          <p role="status" className="rounded-xl bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900">
            {notice}
          </p>
        )}
        <ErrorText message={error} />
        <Button size="lg" onClick={() => void commit()} disabled={busy || short || left === 0}>
          {busy ? "確定中…" : `${money(quote.total)} の支払いを確定する`}
        </Button>
        <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
          取り消す
        </Button>
      </div>
    );
  }

  // ---------- QR 読み取り ----------
  if (step === "scan") {
    return (
      <div className="flex flex-col gap-3">
        <Button variant="ghost" className="self-start" onClick={() => setStep("cart")}>
          <ArrowLeft /> カートに戻る
        </Button>
        <Card>
          <CardContent className="flex flex-col gap-3 pt-4">
            <p className="text-center text-sm text-muted-foreground">合計</p>
            <p className="text-center text-4xl font-extrabold tracking-tight">{money(displayTotal)}</p>
            {coupon && preview && !preview.couponError && preview.discounts.some((d) => d.kind !== "AUTO") && (
              <p className="text-center text-xs font-semibold text-primary">クーポン {coupon} を使います</p>
            )}
            <p className="text-center text-sm font-semibold">お客様のQR(スマホ画面またはカード)を読み取ってください</p>
            {scanning ? (
              <QrScanner onScan={(v) => void scan(v)} onClose={() => setScanning(false)} />
            ) : (
              <Button size="lg" onClick={() => setScanning(true)} disabled={busy || !scannerSupported()}>
                <ScanLine /> カメラで読み取る
              </Button>
            )}
            <details open={!scannerSupported()}>
              <summary className="cursor-pointer text-xs text-muted-foreground">カメラが使えないとき(文字を入力)</summary>
              <form
                className="mt-2 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void scan(token);
                }}
              >
                <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="FES1:U:… / FES1:C:…" autoComplete="off" />
                <Button type="submit" variant="outline" disabled={busy || !token.trim()}>
                  確認
                </Button>
              </form>
            </details>
          </CardContent>
        </Card>
        {notice && (
          <p role="status" className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold text-secondary-foreground">
            {notice}
          </p>
        )}
        <ErrorText message={error} />
      </div>
    );
  }

  // ---------- カート ----------
  return (
    <div className="flex flex-col gap-3">
      <Button variant="ghost" className="self-start" onClick={onClose}>
        <ArrowLeft /> 商品に戻る
      </Button>
      {rows.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">カートは空です</p>}
      <div className="flex flex-col gap-2">
        {rows.map(({ line, v }) => (
          <Card key={line.key} className={cn("p-3", v.problem && "border-destructive")}>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate font-semibold">{v.name}</p>
                {v.details.length > 0 && (
                  <ul className="text-xs text-muted-foreground">
                    {v.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                )}
                <p className="text-sm">
                  {v.listUnit > v.unit && <span className="mr-1.5 text-xs text-muted-foreground line-through">{money(v.listUnit)}</span>}
                  <span className="font-bold">{money(v.unit)}</span>
                </p>
                {v.problem && <p className="text-xs font-semibold text-destructive">{v.problem}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="icon" variant="outline" aria-label="減らす" onClick={() => onChange(line.key, -1)}>
                  <Minus />
                </Button>
                <span className="w-8 text-center text-lg font-bold">{line.quantity}</span>
                <Button size="icon" variant="outline" aria-label="増やす" onClick={() => onChange(line.key, 1)}>
                  <Plus />
                </Button>
                <Button size="icon" variant="ghost" aria-label="削除" onClick={() => onRemove(line.key)}>
                  <Trash2 />
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
      {notice && (
        <p role="status" className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold text-secondary-foreground">
          {notice}
        </p>
      )}
      <ErrorText message={error} />
      {rows.length > 0 && (
        <Card className="p-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setCoupon(codeInput.trim());
            }}
          >
            <div className="relative flex-1">
              <Ticket className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
                placeholder="クーポンコード"
                autoComplete="off"
                autoCapitalize="characters"
                className="pl-9 font-mono"
                maxLength={40}
              />
            </div>
            <Button type="submit" variant="outline" disabled={codeInput.trim() === coupon}>
              {codeInput.trim() === "" && coupon ? "外す" : "適用"}
            </Button>
          </form>
          {coupon && preview?.couponError && <p className="mt-2 text-sm font-semibold text-destructive">{preview.couponError}</p>}
          {coupon && preview && !preview.couponError && preview.discounts.some((d) => d.kind !== "AUTO") && <p className="mt-2 text-sm font-semibold text-primary">クーポンを適用しました</p>}
        </Card>
      )}
      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-border bg-background px-4 py-3">
        {preview && preview.problems.length === 0 && preview.discounts.length > 0 && <DiscountRows subtotal={preview.subtotal} discounts={preview.discounts} />}
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted-foreground">合計</span>
          <span className="text-3xl font-extrabold tracking-tight">{money(displayTotal)}</span>
        </div>
        <Button
          size="lg"
          disabled={rows.length === 0 || unavailable}
          onClick={() => {
            setError(null);
            setNotice(null);
            setStep("scan");
          }}
        >
          <ScanLine /> お客様のQRを読み取る
        </Button>
      </div>
    </div>
  );
}

/** 小計と、適用された割引(計算順)。割引がなければ何も出さない */
function DiscountRows({ subtotal, discounts }: { subtotal: number; discounts: QuoteDiscount[] }) {
  const { money } = useAuth();
  if (discounts.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-0.5 border-t border-dashed border-border pt-1.5 text-sm">
      <div className="flex justify-between text-muted-foreground">
        <span>小計</span>
        <span>{money(subtotal)}</span>
      </div>
      {discounts.map((d, i) => (
        <div key={i} className="flex justify-between font-semibold text-primary">
          <span className="min-w-0 truncate">{d.kind === "AUTO" ? d.name : `クーポン ${d.name}`}</span>
          <span className="shrink-0">-{money(d.amount)}</span>
        </div>
      ))}
    </div>
  );
}

/** 確認・完了画面の1行。セットは内訳と追加料金も見せる */
function QuoteLineRow({ l }: { l: QuoteLine }) {
  const { money } = useAuth();
  return (
    <div className="flex flex-col">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          {l.name} × {l.quantity}
        </span>
        <span className="shrink-0">
          {l.unitPrice < l.listUnitPrice && <span className="mr-1.5 text-xs text-muted-foreground line-through">{money(l.listUnitPrice * l.quantity)}</span>}
          {money(l.lineTotal)}
        </span>
      </div>
      {l.components && l.components.length > 0 && <p className="text-xs text-muted-foreground">{l.components.map((c) => `${c.name}${c.surcharge > 0 ? `(+${c.surcharge})` : ""}`).join("、")}</p>}
    </div>
  );
}
