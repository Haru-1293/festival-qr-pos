/** メール本文(RFC 5322)を作る。件名・差出人名はUTF-8のBase64、本文もBase64。ヘッダーへの改行混入は除く */
const clean = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const enc = new TextEncoder();
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(enc.encode(s))}?=`);
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");

export interface MailMessage {
  fromAddress: string;
  fromName?: string | null;
  to: string;
  subject: string;
  text: string;
}

export function buildMime(m: MailMessage, host: string): string {
  const from = m.fromName ? `${word(clean(m.fromName))} <${clean(m.fromAddress)}>` : clean(m.fromAddress);
  const id = `<${crypto.randomUUID()}@${clean(host) || "localhost"}>`;
  const headers = [
    `From: ${from}`,
    `To: ${clean(m.to)}`,
    `Subject: ${word(clean(m.subject))}`,
    `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${wrap76(b64(enc.encode(m.text)))}\r\n`;
}

export function base64UrlOf(s: string): string {
  return b64(enc.encode(s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
