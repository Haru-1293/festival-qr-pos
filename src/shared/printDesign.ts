import { z } from "zod";

/** 印刷デザイン(ログインカード・QRカード)。位置は用紙(カード)に対する%、文字の大きさはmm */
export type PrintKind = "LOGIN" | "CARD";

export const ELEMENT_KEYS = {
  LOGIN: ["qr", "name", "loginId", "role", "festival", "shop"],
  CARD: ["qr", "displayNo", "expiry", "festival"],
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
  /** 余白なしで並べる枚数の間に入れる切り取り用の間隔(mm) */
  gapMm: number;
  elements: DesignElement[];
}

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

export const layoutSchema = z.object({
  widthMm: num(30, 300),
  heightMm: num(30, 400),
  bg: colorSchema,
  fit: z.enum(["cover", "contain"]),
  gapMm: num(0, 30),
  elements: z.array(elementSchema).min(1).max(12),
});

/** 背景画像(data URL)の上限。D1の1行に収めるため、画面側で縮小・圧縮してから送る */
export const IMAGE_DATA_URL_MAX = 900_000;
export const imageSchema = z
  .string()
  .max(IMAGE_DATA_URL_MAX, "画像が大きすぎます")
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, "PNG・JPEG・WebPの画像を選んでください");

export const templateBodySchema = z.object({
  kind: z.enum(["LOGIN", "CARD"]),
  name: z.string().trim().min(1, "名前を入力してください").max(40),
  layout: layoutSchema,
  image: imageSchema.nullable(),
});

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
      el("displayNo", 5, 78, 90, 5, { bold: true }),
      el("expiry", 5, 90, 90, 2.6, { color: "#555555" }),
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
}
