import crypto from "node:crypto";

/*
  Small AES-256-GCM helper for encrypting per-user vendor credentials at rest.

  The key comes from CREDENTIAL_KEY (any string — we SHA-256 it to 32 bytes).
  Ciphertext is stored as "v1:<iv>:<tag>:<data>" (all base64). Only the server
  ever holds the key or sees plaintext; the browser never receives a stored
  secret back.
*/

const rawKey = process.env.CREDENTIAL_KEY || "";
export const cryptoReady = Boolean(rawKey);

function key() {
  if (!rawKey) throw new Error("CREDENTIAL_KEY is not set — cannot encrypt/decrypt stored credentials.");
  return crypto.createHash("sha256").update(rawKey).digest(); // 32 bytes
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${data.toString("base64")}`;
}

export function decrypt(blob) {
  const [v, ivB64, tagB64, dataB64] = String(blob).split(":");
  if (v !== "v1") throw new Error("unrecognized ciphertext format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
