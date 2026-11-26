import QRCode from "qrcode";
import { useEffect, useState, type CSSProperties, type PointerEvent } from "react";
import type { DesignElement, PrintCardData, PrintLayout } from "@shared/printDesign";

/** QRコードの画像(data URL)。余白(クワイエットゾーン)つきで、背景が白になる */
function useQrSrc(value: string): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(value, { width: 560, margin: 2, errorCorrectionLevel: "M" })
      .then((u) => alive && setSrc(u))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [value]);
  return src;
}

function textOf(key: string, d: PrintCardData): string {
  switch (key) {
    case "name":
      return d.name ?? "";
    case "loginId":
      return d.loginId ? d.loginId : d.loginId === null ? "(QRのみ・IDなし)" : "";
    case "role":
      return d.role ?? "";
    case "festival":
      return d.festival ?? "";
    case "shop":
      return d.shop ?? "";
    case "displayNo":
      return d.displayNo ?? "";
    case "expiry":
      return d.expiry ? `有効期限 ${d.expiry}` : "";
    default:
      return "";
  }
}

/**
 * 1枚ぶんのカード。大きさは `width`(既定は親の幅いっぱい)で決まり、文字の大きさ・位置は幅に比例して拡縮する。
 * 印刷では width を mm で指定すると、そのままの大きさで出る。
 * `onElementPointerDown` を渡すと、要素をドラッグできる(デザインの編集画面用)。
 */
export function PrintCard({
  layout,
  image,
  data,
  width = "100%",
  selectedKey,
  onElementPointerDown,
  className,
}: {
  layout: PrintLayout;
  image: string | null;
  data: PrintCardData;
  width?: string;
  selectedKey?: string | null;
  onElementPointerDown?: (key: string, e: PointerEvent<HTMLElement>) => void;
  className?: string;
}) {
  const qr = useQrSrc(data.qr);
  const editing = !!onElementPointerDown;
  const style: CSSProperties = {
    width,
    aspectRatio: `${layout.widthMm} / ${layout.heightMm}`,
    containerType: "inline-size",
    position: "relative",
    overflow: "hidden",
    backgroundColor: layout.bg,
    backgroundImage: image ? `url(${image})` : undefined,
    backgroundSize: layout.fit,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    WebkitPrintColorAdjust: "exact",
    printColorAdjust: "exact",
    breakInside: "avoid",
    color: "#000",
    flexShrink: 0,
  };
  const wrap = (el: DesignElement): CSSProperties => ({
    position: "absolute",
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.w}%`,
    outline: editing && selectedKey === el.key ? "0.4cqw solid #06a850" : editing ? "0.2cqw dashed rgba(0,0,0,0.35)" : undefined,
    cursor: editing ? "move" : undefined,
    touchAction: editing ? "none" : undefined,
    userSelect: editing ? "none" : undefined,
  });
  return (
    <div style={style} className={className}>
      {layout.elements.map((el) => {
        if (!el.visible) return null;
        if (el.key === "qr") {
          return (
            <div key={el.key} style={{ ...wrap(el), aspectRatio: "1", background: "#fff" }} onPointerDown={onElementPointerDown ? (e) => onElementPointerDown(el.key, e) : undefined}>
              {qr && <img src={qr} alt="QRコード" draggable={false} style={{ width: "100%", height: "100%", display: "block" }} />}
            </div>
          );
        }
        const t = textOf(el.key, data);
        if (!t && !editing) return null;
        return (
          <div
            key={el.key}
            onPointerDown={onElementPointerDown ? (e) => onElementPointerDown(el.key, e) : undefined}
            style={{
              ...wrap(el),
              fontSize: `${(el.fontMm / layout.widthMm) * 100}cqw`,
              lineHeight: 1.25,
              textAlign: el.align,
              color: el.color,
              fontWeight: el.bold ? 800 : 500,
              fontFamily: el.key === "loginId" || el.key === "displayNo" ? 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace' : undefined,
              overflowWrap: "anywhere",
              minHeight: editing ? `${(el.fontMm / layout.widthMm) * 125}cqw` : undefined,
            }}
          >
            {t || (editing ? `(${el.key})` : "")}
          </div>
        );
      })}
    </div>
  );
}
