/* 学祭ペイ Service Worker(画面の部品だけをキャッシュする)
 *
 * - /api/* は一切キャッシュしない(残高・取引・個人情報を端末に残さない。回線断のときは通信エラーを返す)
 * - ページ移動: ネットワーク優先。つながらないときは、前に開いた画面(index.html)を返す
 * - /assets/*(ファイル名にハッシュが付く): キャッシュ優先。デプロイ後は新しい名前で取り直される
 * - アイコン・マニフェストなど: 表示は即座にキャッシュから、裏で更新
 * 画面の仕組みを変えたら CACHE_VERSION を上げる。
 */
const CACHE_VERSION = "v1";
const SHELL = `festival-shell-${CACHE_VERSION}`;
const ASSETS = `festival-assets-${CACHE_VERSION}`;
const PRECACHE = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((r) => r ?? new Response("オフラインです。電波の届く場所でもう一度開いてください。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } }))),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) void cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req)
        .then((res) => {
          if (res.ok) void cache.put(req, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit ?? fresh;
    }),
  );
});
