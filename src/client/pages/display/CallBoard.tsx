import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { CallBoardDto } from "@shared/api";
import { ApiRequestError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * お客様の呼び出しボード(ログイン不要)。店頭のモニターに映す。
 * 「お呼びしています」(提供可能な番号)を大きく、「調理中」の番号を小さく出す。2.5秒ごとに更新。
 */
export function CallBoardPage() {
  const { shopId } = useParams();
  const [data, setData] = useState<CallBoardDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!shopId) return;
    let alive = true;
    let prevReady = new Set<number>();
    const load = async () => {
      try {
        const r = await api<CallBoardDto>(`/public/shops/${shopId}/board`);
        if (!alive) return;
        const nowReady = new Set(r.ready);
        setFresh(new Set([...nowReady].filter((n) => !prevReady.has(n))));
        prevReady = nowReady;
        setData(r);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof ApiRequestError && e.status === 404 ? "この店舗では呼び出しボードを使っていません" : "通信できません。つながるまでお待ちください");
      }
    };
    void load();
    const t = window.setInterval(() => void load(), 2500);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [shopId]);

  return (
    <div className="flex min-h-dvh flex-col bg-neutral-900 text-white">
      <header className="bg-primary px-6 py-4 text-primary-foreground">
        <h1 className="text-2xl font-extrabold sm:text-4xl">{data?.shopName ?? "呼び出しボード"}</h1>
      </header>
      {error && !data && <p className="p-10 text-center text-xl">{error}</p>}
      {data && (
        <div className="grid flex-1 gap-4 p-4 md:grid-cols-5">
          <section className="flex flex-col gap-3 rounded-3xl bg-emerald-600/20 p-5 md:col-span-3" aria-label="お呼びしています">
            <h2 className="text-2xl font-extrabold text-emerald-300 sm:text-3xl">できあがりました</h2>
            <div className="flex flex-wrap content-start gap-3">
              {data.ready.length === 0 && <p className="text-lg text-white/50">いまお呼びしている番号はありません</p>}
              {data.ready.map((n) => (
                <span key={n} className={cn("flex min-w-28 items-center justify-center rounded-2xl bg-emerald-500 px-5 py-3 text-6xl font-black text-white sm:text-8xl", fresh.has(n) && "animate-pulse ring-8 ring-white/70")}>
                  {n}
                </span>
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-3 rounded-3xl bg-white/5 p-5 md:col-span-2" aria-label="調理中">
            <h2 className="text-xl font-bold text-amber-300 sm:text-2xl">ただいま調理中</h2>
            <div className="flex flex-wrap content-start gap-2">
              {data.preparing.length === 0 && <p className="text-white/50">なし</p>}
              {data.preparing.map((n) => (
                <span key={n} className="flex min-w-16 items-center justify-center rounded-xl bg-white/10 px-3 py-2 text-3xl font-bold sm:text-5xl">
                  {n}
                </span>
              ))}
            </div>
          </section>
        </div>
      )}
      {error && data && <p className="bg-amber-500 px-4 py-2 text-center text-sm font-bold text-black">{error}</p>}
    </div>
  );
}
