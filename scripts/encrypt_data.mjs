// Шифрует data.js → data.enc.js (AES-256-GCM, ключ из пароля через PBKDF2).
// Использование: node scripts/encrypt_data.mjs data.js data.enc.js "пароль"
import { readFileSync, writeFileSync } from "node:fs";
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";

const [src, out, password] = process.argv.slice(2);
if (!src || !out || !password) {
  console.error('Использование: node scripts/encrypt_data.mjs data.js data.enc.js "пароль"');
  process.exit(1);
}

const js = readFileSync(src, "utf8");
const grab = (name) => {
  const m = js.match(new RegExp(`const ${name} = (.*?);\\n`, "s"));
  if (!m) throw new Error(`не нашёл ${name} в ${src}`);
  return JSON.parse(m[1]);
};
const payload = JSON.stringify({
  categories: grab("BASE_CATEGORIES"),
  transactions: grab("TRANSACTIONS"),
});

const ITER = 600000;
const salt = randomBytes(16);
const iv = randomBytes(12);
const key = pbkdf2Sync(password, salt, ITER, 32, "sha256");
const cipher = createCipheriv("aes-256-gcm", key, iv);
const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final(), cipher.getAuthTag()]);

writeFileSync(out,
  "// Зашифрованные данные — scripts/encrypt_data.mjs\n" +
  "const ENC_DATA = " + JSON.stringify({
    v: 1, iter: ITER,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
  }) + ";\n");
console.error(`ok: ${out} (${ct.length} bytes ciphertext, PBKDF2 ${ITER} итераций)`);
