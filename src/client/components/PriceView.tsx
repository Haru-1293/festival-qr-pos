import type { ProductDto } from "@shared/api";
import { useAuth } from "@/lib/auth";

/** 値下げ中は、値下げ後の価格を大きく、定価を取り消し線で表示する */
export function PriceView({ p, className = "" }: { p: Pick<ProductDto, "price" | "salePrice" | "cutAmount">; className?: string }) {
  const { money } = useAuth();
  if (p.price === null || p.salePrice === null) return <span className={`text-muted-foreground ${className}`}>非売品</span>;
  if (p.cutAmount === 0) return <span className={`font-bold ${className}`}>{money(p.price)}</span>;
  return (
    <span className={`inline-flex items-baseline gap-1.5 ${className}`}>
      <span className="font-extrabold text-red-600">{money(p.salePrice)}</span>
      <span className="text-xs text-muted-foreground line-through">{money(p.price)}</span>
    </span>
  );
}
