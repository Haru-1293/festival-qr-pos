#!/usr/bin/env python3
"""メール送信のテスト用の偽サーバー: SMTP(2525) と OAuth2 トークンサーバー(2526)。
受け取ったメールは MAILDIR に 1通1ファイルで保存する。FAILFILE があるとき、その中身(PASSWORD / XOAUTH2)の方式のログインを拒否する。"""
import asyncio, base64, json, os, sys, itertools
MAILDIR = sys.argv[1]; FAILFILE = os.path.join(MAILDIR, "fail")
os.makedirs(MAILDIR, exist_ok=True)
counter = itertools.count(1)

def failing(kind):
    try: return open(FAILFILE).read().strip() == kind
    except OSError: return False

async def smtp(reader, writer):
    async def say(s): writer.write((s + "\r\n").encode()); await writer.drain()
    await say("220 fake ESMTP")
    kind = None; user = None; mail_from = None; rcpt = None
    while True:
        line = await reader.readline()
        if not line: break
        cmd = line.decode().rstrip("\r\n"); up = cmd.upper()
        if up.startswith("EHLO"): await say("250-fake\r\n250 AUTH PLAIN LOGIN XOAUTH2")
        elif up.startswith("AUTH PLAIN"):
            _, u, p = base64.b64decode(cmd.split(" ", 2)[2]).decode().split("\0")
            if u == "mailuser" and p == "mailpass" and not failing("PASSWORD"): kind, user = "PASSWORD", u; await say("235 ok")
            else: await say("535 bad credentials")
        elif up.startswith("AUTH XOAUTH2"):
            raw = base64.b64decode(cmd.split(" ", 2)[2]).decode()
            tok = raw.split("auth=Bearer ")[1].split("\x01")[0]
            if tok.startswith("AT-") and not failing("XOAUTH2"): kind, user = "XOAUTH2", raw.split("\x01")[0][5:]; await say("235 ok")
            else: await say("535 bad token")
        elif up.startswith("MAIL FROM"):
            if kind is None: await say("530 auth required"); continue
            mail_from = cmd[10:].strip("<>"); await say("250 ok")
        elif up.startswith("RCPT TO"): rcpt = cmd[8:].strip("<>"); await say("250 ok")
        elif up == "DATA":
            await say("354 go")
            data = []
            while True:
                l = (await reader.readline()).decode()
                if l == ".\r\n": break
                data.append(l[1:] if l.startswith("..") else l)
            n = next(counter)
            open(os.path.join(MAILDIR, f"{n:04d}.json"), "w").write(json.dumps({"auth": kind, "user": user, "from": mail_from, "to": rcpt, "data": "".join(data)}))
            await say("250 queued")
        elif up == "QUIT": await say("221 bye"); break
        else: await say("500 ?")
    writer.close()

async def http(reader, writer):
    head = b""
    while b"\r\n\r\n" not in head: head += await reader.read(4096)
    h, _, rest = head.partition(b"\r\n\r\n")
    n = int([l.split(b":")[1] for l in h.split(b"\r\n") if l.lower().startswith(b"content-length")][0])
    while len(rest) < n: rest += await reader.read(4096)
    from urllib.parse import parse_qs
    q = {k: v[0] for k, v in parse_qs(rest.decode()).items()}
    if q.get("client_id") != "cid" or q.get("client_secret") != "csecret": out, code = {"error": "invalid_client", "error_description": "bad client"}, 401
    elif q.get("grant_type") == "authorization_code" and q.get("code") == "goodcode": out, code = {"access_token": "AT-1", "refresh_token": "RT-1", "expires_in": 3600}, 200
    elif q.get("grant_type") == "refresh_token" and q.get("refresh_token") == "RT-1": out, code = {"access_token": "AT-2", "expires_in": 3600}, 200
    else: out, code = {"error": "invalid_grant"}, 400
    b = json.dumps(out).encode()
    writer.write(f"HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {len(b)}\r\nconnection: close\r\n\r\n".encode() + b); await writer.drain(); writer.close()

async def main():
    a = await asyncio.start_server(smtp, "127.0.0.1", 2525); b = await asyncio.start_server(http, "127.0.0.1", 2526)
    print("ready", flush=True)
    await asyncio.gather(a.serve_forever(), b.serve_forever())
asyncio.run(main())
