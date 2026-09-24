import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ValidationError } from './errors.js';

/**
 * Path helpers that keep every job-owned file inside its own directory. All
 * media and artifact paths flow through `resolveWithin` so a crafted filename
 * cannot read or write outside the job sandbox.
 */

/** Resolves `relative` under `root`, rejecting traversal and absolute escapes. */
export function resolveWithin(root, ...relative) {
  const base = path.resolve(root);
  const candidate = path.resolve(base, ...relative);
  if (candidate !== base && !candidate.startsWith(base + path.sep)) {
    throw new ValidationError('Resolved path escapes its root directory', {
      details: { root: base, requested: relative.join('/') },
    });
  }
  return candidate;
}

/** True when `candidate` stays inside `root` after resolution. */
export function isWithin(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

/**
 * Sanitizes an uploaded filename to a safe basename. Strips directory
 * components, control characters, and leading dots.
 */
export function safeFilename(name, fallback = 'upload.bin') {
  const base = path.basename(String(name ?? ''));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 160);
  return cleaned || fallback;
}

export function extensionOf(name) {
  return path.extname(String(name ?? '')).toLowerCase();
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

export async function statSafe(target) {
  try {
    return await fsp.stat(target);
  } catch {
    return null;
  }
}

/**
 * Writes JSON via a temp file plus rename so a crash mid-write cannot leave a
 * truncated job record behind. Readers either see the old file or the new one.
 *
 * The temp name includes a random suffix because concurrent writers (several
 * segment workers saving the same job) must not share a temp path: if they did,
 * the first rename would remove the file the second is about to rename.
 */
export async function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

export function writeJsonAtomicSync(file, value) {
  const dir = path.dirname(file);
  ensureDirSync(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

export async function removeQuietly(target) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leftover temp file is not worth failing a job.
  }
}

export function removeQuietlySync(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // See removeQuietly.
  }
}
