/** AES-CMAC (RFC 4493) — the one primitive Node's crypto does not ship.
 *
 * Widevine derives its session keys with it, so ~30 lines here replace a
 * dependency.
 */
import crypto from 'node:crypto';

const BLOCK = 16;
const RB = 0x87;

function aesEcbBlock(key, block) {
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** Left-shift a 16-byte buffer by one bit, XOR-ing in Rb on overflow. */
function shiftLeft(buf) {
  const out = Buffer.alloc(BLOCK);
  let carry = 0;
  for (let i = BLOCK - 1; i >= 0; i -= 1) {
    out[i] = ((buf[i] << 1) & 0xff) | carry;
    carry = (buf[i] & 0x80) ? 1 : 0;
  }
  if (buf[0] & 0x80) out[BLOCK - 1] ^= RB;
  return out;
}

function xor(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

/** AES-CMAC of *message* under *key*. Returns a 16-byte Buffer. */
export function aesCmac(key, message) {
  const L = aesEcbBlock(key, Buffer.alloc(BLOCK));
  const K1 = shiftLeft(L);
  const K2 = shiftLeft(K1);

  const msg = Buffer.isBuffer(message) ? message : Buffer.from(message);
  const complete = msg.length > 0 && msg.length % BLOCK === 0;
  const blockCount = complete ? msg.length / BLOCK : Math.floor(msg.length / BLOCK) + 1;

  let lastBlock;
  if (complete) {
    lastBlock = xor(msg.subarray((blockCount - 1) * BLOCK, blockCount * BLOCK), K1);
  } else {
    const tail = msg.subarray((blockCount - 1) * BLOCK);
    const padded = Buffer.alloc(BLOCK);
    tail.copy(padded);
    padded[tail.length] = 0x80;
    lastBlock = xor(padded, K2);
  }

  let x = Buffer.alloc(BLOCK);
  for (let i = 0; i < blockCount - 1; i += 1) {
    x = aesEcbBlock(key, xor(x, msg.subarray(i * BLOCK, (i + 1) * BLOCK)));
  }
  return aesEcbBlock(key, xor(x, lastBlock));
}
