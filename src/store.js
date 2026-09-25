// Tiny JSON file store with atomic writes (data survives restarts and power cuts).
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

export function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + ".json"), "utf8")); } catch { return structuredClone(fallback); }
}
export function save(name, data, secret = false) {
  const file = path.join(DATA_DIR, name + ".json"), tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, file);
}
