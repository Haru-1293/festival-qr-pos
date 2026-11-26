import { ELEMENT_KEYS, IMAGE_DATA_URL_MAX, imageSchema, layoutSchema, normalizeLayout, type DesignElement, type ImageBox, type PrintKind, type PrintLayout } from "@shared/printDesign";

/**
 * カードデザインの XML 書き出し・読み込み。仕様は docs/spec/card-design-xml.md。
 * 読み込みはブラウザの DOMParser で行う(外部実体は読まない)。値は保存時と同じスキーマで検証する。
 */
export const DESIGN_XML_VERSION = "1";
export const DESIGN_XML_MAX_BYTES = 2_000_000;

export interface DesignDoc {
  kind: PrintKind;
  name: string;
  layout: PrintLayout;
  image: string | null;
}

const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v: number) => String(Math.round(v * 100) / 100);

export function designToXml(d: DesignDoc): string {
  const l = d.layout;
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<cardDesign version="${DESIGN_XML_VERSION}" kind="${d.kind}" name="${esc(d.name)}">`);
  out.push(`  <page widthMm="${n(l.widthMm)}" heightMm="${n(l.heightMm)}" background="${l.bg}" gapMm="${n(l.gapMm)}"/>`);
  if (d.image) {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(d.image);
    if (m) {
      const b = l.imageBox;
      const box = b ? ` x="${n(b.x)}" y="${n(b.y)}" w="${n(b.w)}" h="${n(b.h)}"` : "";
      out.push(`  <image mime="${m[1]}" fit="${l.fit}"${box}>${m[2]}</image>`);
    }
  }
  out.push("  <!-- layers: 上から順に「背面 → 最前面」 -->");
  out.push("  <layers>");
  for (const e of l.elements) {
    out.push(`    <element key="${esc(e.key)}" visible="${e.visible}" x="${n(e.x)}" y="${n(e.y)}" w="${n(e.w)}" fontMm="${n(e.fontMm)}" align="${e.align}" color="${e.color}" bold="${e.bold}"/>`);
  }
  out.push("  </layers>");
  out.push("</cardDesign>");
  return `${out.join("\n")}\n`;
}

const bool = (v: string | null, what: string): boolean => {
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`${what} は true か false で指定してください`);
};
const num = (v: string | null, what: string): number => {
  if (v === null || v.trim() === "") throw new Error(`${what} がありません`);
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`${what} は数値で指定してください(${v})`);
  return x;
};

export function xmlToDesign(text: string): DesignDoc {
  if (text.length > DESIGN_XML_MAX_BYTES) throw new Error("XMLファイルが大きすぎます(2MBまで)");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length > 0) throw new Error("XMLとして読み込めませんでした。ファイルが壊れていないか確認してください");
  const root = doc.documentElement;
  if (root.tagName !== "cardDesign") throw new Error("カードデザインのXMLではありません(ルート要素が cardDesign ではありません)");
  const version = root.getAttribute("version");
  if (version !== DESIGN_XML_VERSION) throw new Error(`このXMLのバージョン(${version ?? "なし"})には対応していません。対応: ${DESIGN_XML_VERSION}`);
  const kind = root.getAttribute("kind");
  if (kind !== "LOGIN" && kind !== "CARD") throw new Error("kind は LOGIN か CARD で指定してください");
  const name = (root.getAttribute("name") ?? "").trim() || "読み込んだデザイン";

  const only = (tag: string, required: boolean): Element | null => {
    const found = Array.from(root.children).filter((c) => c.tagName === tag);
    if (found.length > 1) throw new Error(`${tag} が複数あります`);
    if (found.length === 0 && required) throw new Error(`${tag} 要素がありません`);
    return found[0] ?? null;
  };

  const page = only("page", true)!;
  const imageEl = only("image", false);
  const layers = only("layers", true)!;

  let image: string | null = null;
  let fit: PrintLayout["fit"] = "cover";
  let imageBox: ImageBox | undefined;
  if (imageEl) {
    const mime = imageEl.getAttribute("mime");
    if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") throw new Error("image の mime は image/png・image/jpeg・image/webp のどれかにしてください");
    const b64 = (imageEl.textContent ?? "").replace(/\s+/g, "");
    image = `data:${mime};base64,${b64}`;
    const parsed = imageSchema.safeParse(image);
    if (!parsed.success) throw new Error(image.length > IMAGE_DATA_URL_MAX ? "背景画像が大きすぎます(約650KBまで)" : "背景画像のデータ(base64)が正しくありません");
    const f = imageEl.getAttribute("fit");
    if (f !== null) {
      if (f !== "cover" && f !== "contain") throw new Error("image の fit は cover か contain にしてください");
      fit = f;
    }
    if (imageEl.hasAttribute("x") || imageEl.hasAttribute("y") || imageEl.hasAttribute("w") || imageEl.hasAttribute("h")) {
      imageBox = { x: num(imageEl.getAttribute("x"), "image の x"), y: num(imageEl.getAttribute("y"), "image の y"), w: num(imageEl.getAttribute("w"), "image の w"), h: num(imageEl.getAttribute("h"), "image の h") };
    }
  }

  const known = new Set<string>(ELEMENT_KEYS[kind]);
  const seen = new Set<string>();
  const elements: DesignElement[] = [];
  for (const el of Array.from(layers.children)) {
    if (el.tagName !== "element") throw new Error(`layers の中に想定外の要素 ${el.tagName} があります`);
    const key = el.getAttribute("key") ?? "";
    if (!known.has(key)) throw new Error(`このデザインの種類(${kind})では使えない要素です: ${key || "(keyなし)"}`);
    if (seen.has(key)) throw new Error(`要素 ${key} が重複しています`);
    seen.add(key);
    const align = el.getAttribute("align") ?? "center";
    if (align !== "left" && align !== "center" && align !== "right") throw new Error(`${key} の align は left・center・right のどれかにしてください`);
    elements.push({
      key,
      visible: bool(el.getAttribute("visible") ?? "true", `${key} の visible`),
      x: num(el.getAttribute("x"), `${key} の x`),
      y: num(el.getAttribute("y"), `${key} の y`),
      w: num(el.getAttribute("w"), `${key} の w`),
      fontMm: num(el.getAttribute("fontMm") ?? "0", `${key} の fontMm`),
      align,
      color: el.getAttribute("color") ?? "#000000",
      bold: bool(el.getAttribute("bold") ?? "false", `${key} の bold`),
    });
  }
  if (elements.length === 0) throw new Error("layers に element が1つもありません");

  const layout: PrintLayout = {
    widthMm: num(page.getAttribute("widthMm"), "page の widthMm"),
    heightMm: num(page.getAttribute("heightMm"), "page の heightMm"),
    bg: page.getAttribute("background") ?? "#ffffff",
    gapMm: num(page.getAttribute("gapMm") ?? "0", "page の gapMm"),
    fit,
    imageBox,
    elements,
  };
  const ok = layoutSchema.safeParse(layout);
  if (!ok.success) {
    const i = ok.error.issues[0]!;
    const [a, b, c] = i.path;
    const where =
      a === "elements" && typeof b === "number" ? `${layout.elements[b]?.key ?? "element"} の ${String(c)}` : a === "imageBox" ? `image の ${String(b)}` : a === "bg" ? "page の background" : a === "fit" ? "image の fit" : a ? `page の ${String(a)}` : "デザイン全体";
    throw new Error(`${where} が範囲外、または形式が正しくありません(仕様書の範囲を確認してください)`);
  }
  return { kind, name: name.slice(0, 40), layout: normalizeLayout(kind, ok.data as PrintLayout), image };
}

/** ブラウザでファイルとして保存する */
export function downloadText(filename: string, text: string, mime = "application/xml") {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (s: string) => s.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "design";
