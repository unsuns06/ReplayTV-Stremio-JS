/** Where the shared data files live.
 *
 * The JS port sits in `js/` inside the Python repo, so `programs.json` and
 * `credentials.json` are looked for here first and in the parent repo second.
 * That way the folder works standalone *and* shares one catalogue with the
 * Python addon when it is checked out next to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PARENT_ROOT = path.resolve(PACKAGE_ROOT, '..');

/** Absolute path to *name*, preferring the copy inside this package. */
export function dataFile(name) {
  const local = path.join(PACKAGE_ROOT, name);
  if (fs.existsSync(local)) return local;
  const parent = path.join(PARENT_ROOT, name);
  if (fs.existsSync(parent)) return parent;
  return local; // report the local path when neither exists
}

export const STATIC_DIR = path.join(PACKAGE_ROOT, 'static');
