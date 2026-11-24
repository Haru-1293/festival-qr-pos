/** 呼び出し札(番号札)。半角の英数字・記号(スペース除く)1〜8文字。英字は大文字にそろえる */
export const CALL_TAG_MAX = 8;
export const CALL_TAG_RE = /^[\x21-\x7E]{1,8}$/;

/** 入力を正規化して返す。使えない文字・長さのときは null */
export function normalizeCallTag(input: string): string | null {
  const s = input.trim().toUpperCase();
  return CALL_TAG_RE.test(s) ? s : null;
}

/** 札の文字列から保存形を決める。1〜999の数字(先頭0なし)は従来どおり call_no に、それ以外は call_label に持つ */
export function splitCallTag(tag: string): { callNo: number | null; label: string | null } {
  if (/^[1-9][0-9]{0,2}$/.test(tag)) return { callNo: Number(tag), label: null };
  return { callNo: null, label: tag };
}

/** 呼び出しボード用の並び順: 数字は数の大小、英字・記号は文字順。数字が先 */
export function compareCallLabels(a: string, b: string): number {
  const an = /^[0-9]+$/.test(a);
  const bn = /^[0-9]+$/.test(b);
  if (an && bn && a.length <= 3 && b.length <= 3) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
