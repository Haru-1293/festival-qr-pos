const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 時刻順に並ぶ26文字のID(ULID形式)。48bit時刻 + 80bit乱数 */
export function newId(now = Date.now()): string {
  let t = now;
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] % 32];
  return time + rand;
}
