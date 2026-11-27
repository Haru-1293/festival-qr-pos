import { z } from "zod";

/** 印刷デザイン(ログインカード・QRカード)。位置は用紙(カード)に対する%、文字の大きさはmm */
export type PrintKind = "LOGIN" | "CARD";

export const ELEMENT_KEYS = {
  LOGIN: ["qr", "name", "loginId", "role", "festival", "shop"],
  CARD: ["qr", "displayNo", "expiry", "festival", "pin"],
} as const;
export type ElementKey = (typeof ELEMENT_KEYS)[PrintKind][number];

export const ELEMENT_LABEL: Record<string, string> = {
  qr: "QRコード",
  name: "表示名",
  loginId: "ログインID",
  role: "役割",
  festival: "祭の名前",
  shop: "店舗名",
  displayNo: "カード番号",
  expiry: "有効期限",
  pin: "PIN(印字・記入欄)",
};

export interface DesignElement {
  key: string;
  visible: boolean;
  /** 左上の位置(カードの幅・高さに対する%) */
  x: number;
  y: number;
  /** QR: 一辺の長さ(カード幅に対する%)。文字: 枠の幅(カード幅に対する%) */
  w: number;
  /** 文字の大きさ(mm)。QRでは使わない */
  fontMm: number;
  align: "left" | "center" | "right";
  color: string;
  bold: boolean;
}

export interface PrintLayout {
  widthMm: number;
  heightMm: number;
  /** 背景画像がないときの地色 */
  bg: string;
  /** 背景画像の表示: cover=はみ出しを切る / contain=全体を収める */
  fit: "cover" | "contain";
  /** 背景画像を置く枠(カードの幅・高さに対する%)。なければカード全面。ドラッグ・拡縮で動かせる */
  imageBox?: ImageBox;
  /** 余白なしで並べる枚数の間に入れる切り取り用の間隔(mm) */
  gapMm: number;
  /** 重なりの順番: 先頭が最背面、末尾が最前面(背景画像は常に全要素の下) */
  elements: DesignElement[];
}

export interface ImageBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const IMAGE_BOX_FULL: ImageBox = { x: 0, y: 0, w: 100, h: 100 };
/** レイヤー一覧・選択で、背景画像を指すキー */
export const IMAGE_LAYER = "__image";

const num = (min: number, max: number) => z.number().min(min).max(max);
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const elementSchema = z.object({
  key: z.string().min(1).max(20),
  visible: z.boolean(),
  x: num(-20, 120),
  y: num(-20, 120),
  w: num(2, 150),
  fontMm: num(0, 40),
  align: z.enum(["left", "center", "right"]),
  color: colorSchema,
  bold: z.boolean(),
});

export const imageBoxSchema = z.object({ x: num(-300, 400), y: num(-300, 400), w: num(1, 500), h: num(1, 500) });

export const layoutSchema = z.object({
  widthMm: num(30, 300),
  heightMm: num(30, 400),
  bg: colorSchema,
  fit: z.enum(["cover", "contain"]),
  imageBox: imageBoxSchema.optional(),
  gapMm: num(0, 30),
  elements: z.array(elementSchema).min(1).max(12),
});

/** 背景画像(data URL)の上限。D1の1行に収めるため、画面側で縮小・圧縮してから送る */
export const IMAGE_DATA_URL_MAX = 900_000;
export const imageSchema = z
  .string()
  .max(IMAGE_DATA_URL_MAX, "画像が大きすぎます")
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "PNG・JPEG・WebPの画像を選んでください");

/** R2に置く背景画像の上限(1枚あたり)。XMLに入れるとbase64で約1.34倍になる */
export const IMAGE_R2_MAX_BYTES = 10_000_000;
export const IMAGE_KEY_PATTERN = /^[0-9A-Za-z]{26}\.(png|jpg|webp)$/;
export const IMAGE_URL_PREFIX = "/api/print-templates/images/";

const oneImage = (b: { image: string | null; imageKey: string | null }) => !(b.image && b.imageKey);
const oneImageMsg = { message: "画像は1つだけ指定してください" };

const templateBase = z
  .object({
    kind: z.enum(["LOGIN", "CARD"]),
    name: z.string().trim().min(1, "名前を入力してください").max(40),
    layout: layoutSchema,
    /** R2を使わない設定のとき: 画面側で縮小したdata URL(D1の1行に収める) */
    image: imageSchema.nullable().default(null),
    /** R2を使うとき: アップロード済み画像のキー */
    imageKey: z.string().regex(IMAGE_KEY_PATTERN).nullable().default(null),
  });
export const templateBodySchema = templateBase.refine(oneImage, oneImageMsg);
export const templateUpdateSchema = templateBase.omit({ kind: true }).refine(oneImage, oneImageMsg);

/** 背景画像の保存先の設定(R2が使えるか) */
export interface ImageStorageInfo {
  mode: "r2" | "inline";
  /** 1枚あたりの上限(バイト)。inline は縮小後のdata URLの長さ */
  maxBytes: number;
}

export interface PrintTemplateSummary {
  id: string;
  kind: PrintKind;
  name: string;
  layout: PrintLayout;
  hasImage: boolean;
  updatedAt: number;
}
export interface PrintTemplateFull extends PrintTemplateSummary {
  image: string | null;
}

const el = (key: string, x: number, y: number, w: number, fontMm: number, extra: Partial<DesignElement> = {}): DesignElement => ({
  key,
  visible: true,
  x,
  y,
  w,
  fontMm,
  align: "center",
  color: "#000000",
  bold: false,
  ...extra,
});

/** 組み込みの標準デザイン(画像なし)。テンプレートがないときや、新しく作るときの出発点 */
export function defaultLayout(kind: PrintKind): PrintLayout {
  if (kind === "LOGIN") {
    return {
      widthMm: 90,
      heightMm: 120,
      bg: "#ffffff",
      fit: "cover",
      gapMm: 6,
      elements: [
        el("festival", 5, 4, 90, 4, { color: "#06a850", bold: true }),
        el("role", 5, 10, 90, 3.2, { color: "#555555" }),
        el("name", 5, 17, 90, 7, { bold: true }),
        el("loginId", 5, 28, 90, 4, { bold: true }),
        el("shop", 5, 35, 90, 3, { color: "#555555", visible: false }),
        el("qr", 20, 42, 60, 0),
      ],
    };
  }
  return {
    widthMm: 55,
    heightMm: 85,
    bg: "#ffffff",
    fit: "cover",
    gapMm: 4,
    elements: [
      el("festival", 5, 4, 90, 3.2, { color: "#06a850", bold: true }),
      el("qr", 15, 14, 70, 0),
      el("displayNo", 5, 74, 90, 5, { bold: true }),
      el("pin", 5, 82, 90, 3.6, { bold: true }),
      el("expiry", 5, 91, 90, 2.6, { color: "#555555" }),
    ],
  };
}

/** 印刷する内容(1枚ぶん)。ない項目は空欄になる */
export interface PrintCardData {
  qr: string;
  name?: string;
  loginId?: string | null;
  role?: string;
  festival?: string;
  shop?: string | null;
  displayNo?: string;
  expiry?: string;
  /** 発行時に決めたPIN(4桁)。カードに印字する */
  pin?: string;
  /** PINをお客様が決めるカード: PINの記入欄(□□□□)を印刷する */
  pinBlank?: boolean;
}

/**
 * 保存済みのデザインに、あとから増えた要素(例: PIN)が無いとき、標準の位置で足す。
 * 並び順(重なり)は保存されたものを崩さず、足す要素は最前面に置く。
 */
export function normalizeLayout(kind: PrintKind, layout: PrintLayout): PrintLayout {
  const have = new Set(layout.elements.map((e) => e.key));
  const missing = defaultLayout(kind).elements.filter((e) => !have.has(e.key));
  const keys = new Set<string>(ELEMENT_KEYS[kind]);
  const kept = layout.elements.filter((e) => keys.has(e.key));
  if (missing.length === 0 && kept.length === layout.elements.length) return layout;
  return { ...layout, elements: [...kept, ...missing] };
}
