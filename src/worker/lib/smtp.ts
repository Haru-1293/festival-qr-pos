import { connect } from "cloudflare:sockets";

export interface SmtpOptions {
  host: string;
  port: number;
  security: "SSL" | "STARTTLS" | "NONE";
  /** PASSWORD=ユーザー名+パスワード、XOAUTH2=アクセストークン */
  auth: { kind: "PASSWORD"; username: string; password: string } | { kind: "XOAUTH2"; username: string; token: string } | { kind: "NONE" };
  from: string;
  to: string;
  /** DATA に入れるメール本文(CRLF区切り) */
  data: string;
  clientName?: string;
  timeoutMs?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (s: string) => btoa(String.fromCharCode(...enc.encode(s)));
const addr = (s: string) => s.replace(/[<>\r\n]/g, "");

class Conn {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = "";
  constructor(public socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
  async send(line: string) {
    await this.writer.write(enc.encode(`${line}\r\n`));
  }
  /** 1つの応答(複数行なら最後の行まで)を読む。コードと本文を返す */
  async reply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      let i: number;
      while ((i = this.buf.indexOf("\r\n")) < 0) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("メールサーバーとの接続が切れました");
        this.buf += dec.decode(value, { stream: true });
        if (this.buf.length > 65536) throw new Error("メールサーバーの応答が長すぎます");
      }
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
    }
  }
  async expect(ok: number[], what: string): Promise<string> {
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new Error(`${what}で拒否されました(${r.text.replace(/\s+/g, " ").slice(0, 200)})`);
    return r.text;
  }
  async cmd(line: string, ok: number[], what: string) {
    await this.send(line);
    return this.expect(ok, what);
  }
}

/** SMTPで1通送る(外向きのTCP接続。25番ポートはCloudflareが塞ぐので 465/587 を使う) */
export async function smtpSend(o: SmtpOptions): Promise<void> {
  const work = async () => {
    const socket = connect({ hostname: o.host, port: o.port }, { secureTransport: o.security === "SSL" ? "on" : o.security === "STARTTLS" ? "starttls" : "off", allowHalfOpen: false });
    let conn = new Conn(socket);
    const name = o.clientName ?? "festival-qr-pos";
    try {
      await conn.expect([220], "接続");
      let ext = await conn.cmd(`EHLO ${name}`, [250], "あいさつ(EHLO)");
      if (o.security === "STARTTLS") {
        if (!/STARTTLS/i.test(ext)) throw new Error("このサーバーはSTARTTLSに対応していません");
        await conn.cmd("STARTTLS", [220], "STARTTLS");
        conn.release();
        conn = new Conn(socket.startTls());
        ext = await conn.cmd(`EHLO ${name}`, [250], "あいさつ(EHLO)");
      }
      if (o.auth.kind === "PASSWORD") {
        if (/AUTH[^\n]*PLAIN/i.test(ext) || !/AUTH/i.test(ext)) {
          await conn.cmd(`AUTH PLAIN ${b64(`\0${o.auth.username}\0${o.auth.password}`)}`, [235], "ログイン");
        } else {
          await conn.cmd("AUTH LOGIN", [334], "ログイン");
          await conn.cmd(b64(o.auth.username), [334], "ログイン(ユーザー名)");
          await conn.cmd(b64(o.auth.password), [235], "ログイン(パスワード)");
        }
      } else if (o.auth.kind === "XOAUTH2") {
        await conn.send(`AUTH XOAUTH2 ${b64(`user=${o.auth.username}\x01auth=Bearer ${o.auth.token}\x01\x01`)}`);
        const r = await conn.reply();
        if (r.code === 334) {
          await conn.send("");
          await conn.reply();
        }
        if (r.code !== 235) throw new Error(`OAuth2のログインで拒否されました(${r.text.replace(/\s+/g, " ").slice(0, 200)})`);
      }
      await conn.cmd(`MAIL FROM:<${addr(o.from)}>`, [250], "差出人(MAIL FROM)");
      await conn.cmd(`RCPT TO:<${addr(o.to)}>`, [250, 251], "宛先(RCPT TO)");
      await conn.cmd("DATA", [354], "本文の送信開始(DATA)");
      // 行頭のドットを二重にして、改行で終わらせる
      const body = o.data.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
      await conn.send(`${body.endsWith("\r\n") ? body.slice(0, -2) : body}\r\n.`);
      await conn.expect([250], "本文の送信");
      await conn.send("QUIT").catch(() => undefined);
    } finally {
      try {
        conn.release();
      } catch {
        /* ignore */
      }
      await socket.close().catch(() => undefined);
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("メールサーバーの応答がありません(タイムアウト)")), o.timeoutMs ?? 20000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
