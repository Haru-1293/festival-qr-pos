import { Ban, KeyRound, Play, Printer, QrCode, RefreshCw, ScanLine, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type { CardDto, CardStatus, IssuedCard } from "@shared/api";
import { QrCodeView } from "@/components/QrCodeView";
import { QrScanner, scannerSupported } from "@/components/QrScanner";
import { ErrorText, Field } from "@/components/Shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useAction } from "@/lib/useAction";
import { cn, formatDateTime } from "@/lib/utils";

const DAY = 24 * 60 * 60 * 1000;
const toDateInput = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** 入力した日の終わり(23:59:59)を期限にする */
const endOfDay = (s: string) => new Date(`${s}T23:59:59`).getTime();
const randomPin = () => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 10000).padStart(4, "0");
};
const digits4 = (s: string) => s.replace(/[^0-9]/g, "").slice(0, 4);

const STATUS_LABEL: Record<CardStatus, string> = { ISSUED: "未有効化", ACTIVE: "有効", SUSPENDED: "一時停止", EXPIRED: "期限切れ", DELETED: "削除済み" };
const STATUS_VARIANT: Record<CardStatus, "default" | "muted" | "warning" | "destructive"> = {
  ISSUED: "muted",
  ACTIVE: "default",
  SUSPENDED: "warning",
  EXPIRED: "destructive",
  DELETED: "muted",
};

type Sub = "list" | "issue" | "activate";

/** 物理QRカードの管理(全体管理者): 発行・印刷・有効化・一覧・停止・PIN再設定・削除・再発行 */
export function CardManager() {
  const [sub, setSub] = useState<Sub>("list");
  const SUBS: { id: Sub; label: string }[] = [
    { id: "list", label: "一覧" },
    { id: "issue", label: "発行・印刷" },
    { id: "activate", label: "有効化" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" className="flex gap-1 rounded-xl bg-muted p-1">
        {SUBS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={sub === t.id}
            onClick={() => setSub(t.id)}
            className={cn("h-9 flex-1 rounded-lg text-sm font-semibold", sub === t.id ? "bg-card shadow-sm" : "text-muted-foreground")}
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "list" && <CardList />}
      {sub === "issue" && <IssueCards />}
      {sub === "activate" && <ActivateCard onDone={() => setSub("list")} />}
    </div>
  );
}

// ---------------------------------------------------------------- 発行・印刷
function IssueCards() {
  const [count, setCount] = useState("10");
  const [batch, setBatch] = useState("");
  const [memo, setMemo] = useState("");
  const [expiry, setExpiry] = useState(toDateInput(Date.now() + 180 * DAY));
  const [issued, setIssued] = useState<IssuedCard[] | null>(null);
  const act = useAction();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const r = await api<{ cards: IssuedCard[] }>("/cards/issue", { body: { count: Number(count), batch: batch.trim() || undefined, memo: memo.trim() || undefined, expiresAt: endOfDay(expiry) } });
      setIssued(r.cards);
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>カードを発行</CardTitle>
          <CardDescription>
            発行したカードは「未有効化」の在庫になります(ニックネーム・PIN・残高なし)。QRはこの画面で印刷してください。QRの文字列はサーバーに残らないため、あとから同じQRは表示できません。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="枚数(1〜100)">
              <Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/[^0-9]/g, ""))} required />
            </Field>
            <Field label="発行バッチ・管理名(任意。例: 受付用A束)">
              <Input value={batch} onChange={(e) => setBatch(e.target.value)} maxLength={40} />
            </Field>
            <Field label="メモ(任意)">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} />
            </Field>
            <Field label="有効期限(発行から6か月以内)">
              <Input type="date" value={expiry} min={toDateInput(Date.now() + DAY)} max={toDateInput(Date.now() + 183 * DAY)} onChange={(e) => setExpiry(e.target.value)} required />
            </Field>
            <ErrorText message={act.error} />
            <Button type="submit" disabled={act.pending || !Number(count)}>
              {act.pending ? "発行中…" : `${Number(count) || 0}枚を発行する`}
            </Button>
          </form>
        </CardContent>
      </Card>
      {issued && <PrintSheet cards={issued} title="発行したカード" onClose={() => setIssued(null)} />}
    </>
  );
}

/** 印刷用のカード一覧。印刷時はこのシートだけが出る(index.css) */
function PrintSheet({ cards, title, onClose }: { cards: IssuedCard[]; title: string; onClose: () => void }) {
  useEffect(() => {
    document.body.classList.add("print-sheet-open");
    return () => document.body.classList.remove("print-sheet-open");
  }, []);
  return createPortal(
    <div className="sheet-host fixed inset-0 z-50 overflow-auto bg-background p-4" role="dialog" aria-label={title}>
      <div className="mx-auto max-w-3xl">
        <div className="mb-3 flex flex-col gap-2 print:hidden">
          <p className="text-lg font-bold">{title}({cards.length}枚)</p>
          <p className="rounded-lg bg-amber-100 px-3 py-2 text-sm font-semibold text-amber-900">
            このQRは今だけ表示できます。印刷または保存してから閉じてください(閉じたあとは同じQRを表示できません。未有効化のカードなら、QRを作り直せます)。
          </p>
          <div className="flex gap-2">
            <Button onClick={() => window.print()}>
              <Printer /> 印刷する
            </Button>
            <Button variant="outline" onClick={onClose}>
              閉じる
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 print:grid-cols-3">
          {cards.map((c) => (
            <div key={c.id} className="flex break-inside-avoid flex-col items-center gap-1 rounded-xl border border-border bg-white p-3 text-black">
              <QrCodeView value={c.token} size={150} />
              <p className="text-lg font-extrabold tracking-wider">{c.displayNo}</p>
              {c.expiresAt > 0 && <p className="text-[10px]">有効期限 {toDateInput(c.expiresAt)}</p>}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- 有効化
function ActivateCard({ onDone }: { onDone: () => void }) {
  const [card, setCard] = useState<CardDto | null>(null);
  const [token, setToken] = useState("");
  const [scanning, setScanning] = useState(false);
  const [nickname, setNickname] = useState("");
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [memo, setMemo] = useState("");
  const [expiry, setExpiry] = useState("");
  const [done, setDone] = useState<{ card: CardDto; pin: string } | null>(null);
  const look = useAction();
  const act = useAction();

  const scan = (value: string) => {
    setScanning(false);
    void look.run(async () => {
      const r = await api<{ card: CardDto }>("/cards/scan", { body: { token: value.trim() } });
      setCard(r.card);
      setExpiry(toDateInput(r.card.expiresAt ?? Date.now() + 180 * DAY));
      setToken("");
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!card) return;
    if (pin !== pin2) return void act.run(async () => Promise.reject(new Error("PINと確認入力が一致しません")));
    void act.run(async () => {
      const r = await api<{ card: CardDto }>(`/cards/${card.id}/activate`, { body: { nickname: nickname.trim(), pin, memo: memo.trim() || undefined, expiresAt: endOfDay(expiry) } });
      setDone({ card: r.card, pin });
    });
  };

  const reset = () => {
    setCard(null);
    setDone(null);
    setNickname("");
    setPin("");
    setPin2("");
    setMemo("");
  };

  if (done) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>有効化しました</CardTitle>
          <CardDescription>カード {done.card.displayNo}(実物のカード番号と一致していることを確認してください)</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="rounded-xl bg-secondary p-4 text-center">
            <p className="text-sm">{done.card.nickname} さん</p>
            <p className="mt-1 text-xs text-muted-foreground">PIN(この画面を閉じると表示できません)</p>
            <p className="font-mono text-4xl font-extrabold tracking-[0.4em]">{done.pin}</p>
          </div>
          <p className="text-sm text-muted-foreground">PINは本人にだけ伝えてください。残高は0です。チャージは受付でこのカードのQRを読み取って行います。有効期限 {formatDateTime(done.card.expiresAt ?? 0)}</p>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={reset}>
              <QrCode /> 次のカードを有効化
            </Button>
            <Button variant="outline" onClick={onDone}>
              一覧へ
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!card) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>カードを有効化</CardTitle>
          <CardDescription>実物のカードのQRを読み取って、利用者への割り当て・PINの設定を行います。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {scanning ? (
            <QrScanner onScan={scan} onClose={() => setScanning(false)} />
          ) : (
            <Button size="lg" onClick={() => setScanning(true)} disabled={look.pending || !scannerSupported()}>
              <ScanLine /> カメラでカードを読み取る
            </Button>
          )}
          <details open={!scannerSupported()}>
            <summary className="cursor-pointer text-xs text-muted-foreground">カメラが使えないとき(文字を入力)</summary>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                scan(token);
              }}
            >
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="FES1:C:…" autoComplete="off" />
              <Button type="submit" variant="outline" disabled={look.pending || !token.trim()}>
                確認
              </Button>
            </form>
          </details>
          <ErrorText message={look.error} />
        </CardContent>
      </Card>
    );
  }

  const blocked = card.status !== "ISSUED";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          カード {card.displayNo} <Badge variant={STATUS_VARIANT[card.status]}>{STATUS_LABEL[card.status]}</Badge>
        </CardTitle>
        <CardDescription>実物のカードに印字された番号と一致しているか確認してください。</CardDescription>
      </CardHeader>
      <CardContent>
        {blocked ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-amber-800">このカードは「{STATUS_LABEL[card.status]}」のため、有効化できません。</p>
            <Button variant="outline" onClick={reset}>
              別のカードを読み取る
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="ニックネーム(利用者の呼び名)">
              <Input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} required />
            </Field>
            <Field label="4桁のPIN">
              <div className="flex gap-2">
                <Input inputMode="numeric" value={pin} onChange={(e) => setPin(digits4(e.target.value))} maxLength={4} autoComplete="off" required />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const p = randomPin();
                    setPin(p);
                    setPin2(p);
                  }}
                >
                  <KeyRound /> 自動で決める
                </Button>
              </div>
            </Field>
            <Field label="PINの確認入力">
              <Input inputMode="numeric" value={pin2} onChange={(e) => setPin2(digits4(e.target.value))} maxLength={4} autoComplete="off" required />
            </Field>
            <Field label="有効期限(6か月以内)">
              <Input type="date" value={expiry} min={toDateInput(Date.now() + DAY)} max={toDateInput(Date.now() + 183 * DAY)} onChange={(e) => setExpiry(e.target.value)} required />
            </Field>
            <Field label="メモ(任意)">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} />
            </Field>
            <ErrorText message={act.error} />
            <div className="flex gap-2">
              <Button type="submit" className="flex-1" disabled={act.pending || pin.length !== 4 || !nickname.trim()}>
                {act.pending ? "有効化中…" : `カード ${card.displayNo} を有効化する`}
              </Button>
              <Button type="button" variant="outline" onClick={reset}>
                やめる
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- 一覧・操作
const FILTERS: { id: CardStatus | ""; label: string }[] = [
  { id: "", label: "削除済み以外" },
  { id: "ISSUED", label: "未有効化" },
  { id: "ACTIVE", label: "有効" },
  { id: "SUSPENDED", label: "停止中" },
  { id: "EXPIRED", label: "期限切れ" },
  { id: "DELETED", label: "削除済み" },
];

function CardList() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<CardStatus | "">("");
  const [cards, setCards] = useState<CardDto[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      const r = await api<{ cards: CardDto[] }>(`/cards?${params}`);
      setCards(r.cards);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込めませんでした");
    }
  }, [q, status]);
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(t);
  }, [load]);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ニックネーム・カード番号・発行バッチで検索" aria-label="カード検索" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setStatus(f.id)}
            aria-pressed={status === f.id}
            className={cn("rounded-full border px-3 py-1 text-xs font-semibold", status === f.id ? "border-primary bg-secondary" : "border-border text-muted-foreground")}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ErrorText message={error} />
      {cards.length === 0 && !error && <p className="p-6 text-center text-sm text-muted-foreground">該当するカードがありません</p>}
      {cards.map((c) => (
        <CardRow key={c.id} card={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onChanged={() => void load()} />
      ))}
    </div>
  );
}

type Mode = null | "suspend" | "resume" | "pin" | "delete" | "regen";

function CardRow({ card: c, open, onToggle, onChanged }: { card: CardDto; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const { money } = useAuth();
  const [mode, setMode] = useState<Mode>(null);
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [walletAction, setWalletAction] = useState<"SUSPEND" | "KEEP" | "TRANSFER">("SUSPEND");
  const [stock, setStock] = useState<CardDto[]>([]);
  const [newCardId, setNewCardId] = useState("");
  const [regen, setRegen] = useState<IssuedCard | null>(null);
  const act = useAction();

  useEffect(() => {
    if (mode === "delete") void api<{ cards: CardDto[] }>("/cards?status=ISSUED").then((r) => setStock(r.cards.filter((x) => x.id !== c.id))).catch(() => undefined);
  }, [mode, c.id]);

  const close = () => {
    setMode(null);
    setReason("");
    setPin("");
    setNewCardId("");
    setWalletAction("SUSPEND");
  };
  const run = (fn: () => Promise<unknown>) =>
    void act.run(async () => {
      await fn();
      close();
      onChanged();
    });

  const live = c.status === "ACTIVE" || c.status === "SUSPENDED" || c.status === "EXPIRED";
  return (
    <Card className={cn("p-3", c.status === "DELETED" && "opacity-70")}>
      <button className="flex w-full items-start justify-between gap-2 text-left" onClick={onToggle} aria-expanded={open}>
        <div className="min-w-0">
          <p className="truncate font-bold">
            {c.nickname ?? "(未割り当て)"} <span className="text-xs font-medium text-muted-foreground">{c.displayNo}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {c.balance !== null ? `残高 ${money(c.balance)} ・ ` : ""}
            {c.expiresAt ? `期限 ${toDateInput(c.expiresAt)}` : ""}
            {c.issueBatch ? ` ・ ${c.issueBatch}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={STATUS_VARIANT[c.status]}>{STATUS_LABEL[c.status]}</Badge>
          {c.walletStatus === "SUSPENDED" && <Badge variant="warning">ウォレット停止</Badge>}
        </div>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3 text-sm">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">発行</dt>
            <dd>{formatDateTime(c.issuedAt)}</dd>
            {c.activatedAt && (
              <>
                <dt className="text-muted-foreground">有効化</dt>
                <dd>{formatDateTime(c.activatedAt)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">直近の利用</dt>
            <dd>{c.lastUsedAt ? formatDateTime(c.lastUsedAt) : "—"}</dd>
            {c.suspendedAt && (
              <>
                <dt className="text-muted-foreground">停止</dt>
                <dd>
                  {formatDateTime(c.suspendedAt)}({c.suspendReason})
                </dd>
              </>
            )}
            {c.deletedAt && (
              <>
                <dt className="text-muted-foreground">削除</dt>
                <dd>
                  {formatDateTime(c.deletedAt)}({c.deleteReason})
                </dd>
              </>
            )}
            {c.memo && (
              <>
                <dt className="text-muted-foreground">メモ</dt>
                <dd>{c.memo}</dd>
              </>
            )}
          </dl>

          {mode === null && c.status !== "DELETED" && (
            <div className="flex flex-wrap gap-2">
              {c.status === "ACTIVE" && (
                <Button size="sm" variant="outline" onClick={() => setMode("suspend")}>
                  <Ban className="!size-4" /> 一時停止
                </Button>
              )}
              {c.status === "SUSPENDED" && (
                <Button size="sm" variant="outline" onClick={() => setMode("resume")}>
                  <Play className="!size-4" /> 停止を解除
                </Button>
              )}
              {(c.status === "ACTIVE" || c.status === "SUSPENDED") && (
                <Button size="sm" variant="outline" onClick={() => setMode("pin")}>
                  <KeyRound className="!size-4" /> PINを再設定
                </Button>
              )}
              {c.status === "ISSUED" && (
                <Button size="sm" variant="outline" onClick={() => setMode("regen")}>
                  <RefreshCw className="!size-4" /> QRを作り直して印刷
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setMode("delete")}>
                <Trash2 className="!size-4" /> {live ? "削除・再発行" : "削除"}
              </Button>
            </div>
          )}

          {mode === "suspend" && (
            <Panel title="一時停止(紛失の報告など)" onCancel={close}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由(必須)" maxLength={200} aria-label="停止の理由" />
              <Button disabled={act.pending || !reason.trim()} onClick={() => run(() => api(`/cards/${c.id}/suspend`, { body: { reason: reason.trim() } }))}>
                一時停止する
              </Button>
            </Panel>
          )}
          {mode === "resume" && (
            <Panel title="停止を解除" onCancel={close}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由(必須。例: 見つかった)" maxLength={200} aria-label="解除の理由" />
              <Button disabled={act.pending || !reason.trim()} onClick={() => run(() => api(`/cards/${c.id}/resume`, { body: { reason: reason.trim() } }))}>
                解除する
              </Button>
            </Panel>
          )}
          {mode === "pin" && (
            <Panel title="PINを再設定(本人確認のうえ行ってください)" onCancel={close}>
              <div className="flex gap-2">
                <Input inputMode="numeric" value={pin} onChange={(e) => setPin(digits4(e.target.value))} placeholder="新しい4桁PIN" maxLength={4} autoComplete="off" aria-label="新しいPIN" />
                <Button type="button" variant="outline" onClick={() => setPin(randomPin())}>
                  自動で決める
                </Button>
              </div>
              {pin.length === 4 && <p className="text-xs text-muted-foreground">新しいPIN: <b className="font-mono text-base">{pin}</b>(本人に伝えてください)</p>}
              <Button disabled={act.pending || pin.length !== 4} onClick={() => run(() => api(`/cards/${c.id}/reset-pin`, { body: { pin } }))}>
                再設定する
              </Button>
            </Panel>
          )}
          {mode === "regen" && (
            <Panel title="QRを作り直す(古いQRは二度と使えなくなります)" onCancel={close}>
              <Button
                disabled={act.pending}
                onClick={() =>
                  void act.run(async () => {
                    const r = await api<{ card: IssuedCard }>(`/cards/${c.id}/regenerate`, { body: {} });
                    setRegen(r.card);
                    close();
                    onChanged();
                  })
                }
              >
                作り直す
              </Button>
            </Panel>
          )}
          {mode === "delete" && (
            <Panel title="カードを削除(QR・PINは失効。取引の履歴は残ります)" onCancel={close}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="理由(必須)" maxLength={200} aria-label="削除の理由" />
              {c.walletStatus !== null && (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-xs font-semibold text-muted-foreground">残高 {money(c.balance ?? 0)} のウォレットは</legend>
                  {(
                    [
                      ["SUSPEND", "停止する(既定。残高は残る)"],
                      ["KEEP", "そのまま残す"],
                      ["TRANSFER", "新しいカードへ引き継ぐ(再発行)"],
                    ] as const
                  ).map(([v, label]) => (
                    <label key={v} className="flex items-center gap-2">
                      <input type="radio" name={`wa-${c.id}`} checked={walletAction === v} onChange={() => setWalletAction(v)} /> {label}
                    </label>
                  ))}
                </fieldset>
              )}
              {walletAction === "TRANSFER" && (
                <div className="flex flex-col gap-2">
                  <select className="h-11 rounded-lg border border-input bg-card px-3 text-sm" value={newCardId} onChange={(e) => setNewCardId(e.target.value)} aria-label="引き継ぎ先のカード">
                    <option value="">引き継ぎ先の未有効化カードを選ぶ…</option>
                    {stock.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.displayNo}
                        {s.issueBatch ? `(${s.issueBatch})` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="flex gap-2">
                    <Input inputMode="numeric" value={pin} onChange={(e) => setPin(digits4(e.target.value))} placeholder="新カードの4桁PIN" maxLength={4} autoComplete="off" aria-label="新カードのPIN" />
                    <Button type="button" variant="outline" onClick={() => setPin(randomPin())}>
                      自動で決める
                    </Button>
                  </div>
                  {pin.length === 4 && <p className="text-xs text-muted-foreground">新カードのPIN: <b className="font-mono text-base">{pin}</b>(本人に伝えてください)</p>}
                </div>
              )}
              <Button
                variant="destructive"
                disabled={act.pending || !reason.trim() || (walletAction === "TRANSFER" && (!newCardId || pin.length !== 4))}
                onClick={() =>
                  run(() =>
                    api(`/cards/${c.id}/delete`, {
                      body: { reason: reason.trim(), walletAction: c.walletStatus === null ? "KEEP" : walletAction, ...(walletAction === "TRANSFER" ? { newCardId, newPin: pin } : {}) },
                    }),
                  )
                }
              >
                {walletAction === "TRANSFER" ? "削除して再発行する" : "削除する"}
              </Button>
            </Panel>
          )}
          <ErrorText message={act.error} />
        </div>
      )}
      {regen && <PrintSheet cards={[regen]} title="作り直したカードのQR" onClose={() => setRegen(null)} />}
    </Card>
  );
}

function Panel({ title, onCancel, children }: { title: string; onCancel: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border-2 border-primary p-3">
      <p className="text-sm font-bold">{title}</p>
      {children}
      <Button variant="outline" size="sm" onClick={onCancel}>
        やめる
      </Button>
    </div>
  );
}
