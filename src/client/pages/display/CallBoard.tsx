import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { CallBoardDto } from "@shared/api";
import { ApiRequestError, api } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * お客様の呼び出しボード(ログイン不要)。店頭のモニターに映す。
 * 白を基調に、右に「呼び出し中」(提供可能な番号)を大きく、左に「調理中・調理待ち」の番号を出す。2.5秒ごとに更新。
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
    <div className="flex min-h-dvh flex-col bg-white text-neutral-900">
      <header className="bg-primary px-6 py-4 text-primary-foreground">
        <h1 className="text-2xl font-extrabold sm:text-4xl">{data?.shopName ?? "呼び出しボード"}</h1>
      </header>
      {error && !data && <p className="p-10 text-center text-xl text-neutral-600">{error}</p>}
      {data && (
        <div className="grid flex-1 gap-4 bg-white p-4 md:grid-cols-5">
          {/* 左: 調理中・調理待ち(狭い画面では呼び出し中を先に出す) */}
          <section className="order-2 flex flex-col gap-3 rounded-3xl border-2 border-amber-200 bg-amber-50 p-5 md:order-1 md:col-span-2" aria-label="調理中・調理待ち">
            <h2 className="text-xl font-extrabold text-amber-700 sm:text-2xl">調理中・調理待ち</h2>
            <div className="flex flex-wrap content-start gap-2">
              {data.preparing.length === 0 && <p className="text-neutral-400">なし</p>}
              {data.preparing.map((n) => (
                <span key={n} className="flex min-w-16 items-center justify-center rounded-xl border border-amber-300 bg-white px-3 py-2 text-3xl font-bold text-neutral-800 sm:text-5xl">
                  {n}
                </span>
              ))}
            </div>
          </section>
          {/* 右: 呼び出し中 */}
          <section className="order-1 flex flex-col gap-3 rounded-3xl border-2 border-emerald-300 bg-emerald-50 p-5 md:order-2 md:col-span-3" aria-label="呼び出し中">
            <h2 className="text-2xl font-extrabold text-emerald-700 sm:text-3xl">呼び出し中</h2>
            <div className="flex flex-wrap content-start gap-3">
              {data.ready.length === 0 && <p className="text-lg text-neutral-400">いまお呼びしている番号はありません</p>}
              {data.ready.map((n) => (
                <span key={n} className={cn("flex min-w-28 items-center justify-center rounded-2xl bg-emerald-600 px-5 py-3 text-6xl font-black text-white shadow-sm sm:text-8xl", fresh.has(n) && "animate-pulse ring-8 ring-emerald-300")}>
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
