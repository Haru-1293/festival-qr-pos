export type LegalKind = "TERMS" | "PRIVACY";
export const LEGAL_KINDS: LegalKind[] = ["TERMS", "PRIVACY"];
export const LEGAL_MAX_CHARS = 100_000;

/** 現行版の番号。まだ登録されていない書類は null */
export async function currentLegalVersions(db: D1Database): Promise<Record<LegalKind, number | null>> {
  const { results } = await db.prepare("SELECT kind, MAX(version) AS v FROM legal_documents GROUP BY kind").all<{ kind: LegalKind; v: number }>();
  const out: Record<LegalKind, number | null> = { TERMS: null, PRIVACY: null };
  for (const r of results) out[r.kind] = r.v;
  return out;
}

export interface LegalDoc {
  kind: LegalKind;
  version: number;
  bodyMd: string;
  createdAt: number;
}

export async function loadLegal(db: D1Database, kind: LegalKind, version?: number): Promise<LegalDoc | null> {
  const r = version
    ? await db.prepare("SELECT kind, version, body_md, created_at FROM legal_documents WHERE kind = ? AND version = ?").bind(kind, version).first<{ kind: LegalKind; version: number; body_md: string; created_at: number }>()
    : await db.prepare("SELECT kind, version, body_md, created_at FROM legal_documents WHERE kind = ? ORDER BY version DESC LIMIT 1").bind(kind).first<{ kind: LegalKind; version: number; body_md: string; created_at: number }>();
  return r ? { kind: r.kind, version: r.version, bodyMd: r.body_md, createdAt: r.created_at } : null;
}
