import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { VaultError } from "./scope.js";

export const masterKeyBytes = 32;

const insideDir = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Refuses a key file that others can read, as the design requires: the key is the one thing a backup must not contain. */
function readKeyFile(path: string): Buffer {
  const mode = statSync(path).mode;
  if ((mode & 0o077) !== 0) {
    throw new VaultError(
      `The master key file ${path} can be read by other users (mode ${(mode & 0o777).toString(8)}). Run: chmod 600 ${path}`,
    );
  }
  const key = readFileSync(path);
  if (key.length !== masterKeyBytes) {
    throw new VaultError(`The master key file ${path} must hold exactly ${masterKeyBytes} bytes, not ${key.length}.`);
  }
  return key;
}

export function writeKeyFile(path: string, key: Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  // writeFileSync keeps the mode of a file that already existed.
  chmodSync(path, 0o600);
}

/**
 * Loads the master key from the key file. The vault never makes a key beside the data: the file lives on a separate
 * volume, so a backup of the data directory alone is useless. A missing file is created only when the vault holds no
 * secrets; with secrets and no file it refuses, rather than silently starting over with a key that opens nothing.
 */
export function loadMasterKey(options: { path: string; dataDir: string; hasSecrets: boolean }): Buffer {
  const path = resolve(options.path);
  if (insideDir(path, options.dataDir)) {
    throw new VaultError(
      "The master key file must be outside the data directory, so a backup of the data does not contain it.",
    );
  }
  if (!existsSync(path)) {
    if (options.hasSecrets) {
      throw new VaultError(
        `The master key file ${path} is missing, and the vault holds secrets that only it can open. Restore it from where you saved it.`,
      );
    }
    const key = randomBytes(masterKeyBytes);
    writeKeyFile(path, key);
    return key;
  }
  return readKeyFile(path);
}

export { readKeyFile };
