import { createHash } from "node:crypto";
import { constants as FsConstants } from "node:fs";
import { access, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function atomicWriteText(
  path: string,
  text: string,
): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, FsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

export function isWithin(root: string, candidate: string): boolean {
  const r = resolve(root).toLowerCase();
  const c = resolve(candidate).toLowerCase();
  return c === r || c.startsWith(r + sep);
}

export function safeSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

export { dirname, relative, resolve };
