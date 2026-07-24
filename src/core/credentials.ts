import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

/**
 * Secret storage.
 *
 * MediaBot holds real secrets — bot tokens, webhook auth headers, and in future
 * platform credentials. Left in `config.json` they sit in plaintext in a file
 * that gets copied into backups, synced to cloud drives, and pasted into issue
 * reports. This keeps them out of that file: the OS keychain when available,
 * an encrypted file otherwise, with only an opaque reference in config.
 *
 * A reference looks like `secret:<name>`. Anything that is not a reference is
 * returned unchanged, so plain values keep working and migration is optional.
 */

const SERVICE = 'mediabot';
const REF_PREFIX = 'secret:';

export interface CredentialStoreOptions {
  /** Directory for the encrypted fallback. Defaults to ~/.mediabot. */
  home?: string;
  /** Force the file backend, e.g. for tests or Linux. */
  backend?: 'keychain' | 'file';
}

export function isSecretRef(value: string): boolean {
  return value.startsWith(REF_PREFIX);
}

export function secretRef(name: string): string {
  return `${REF_PREFIX}${name}`;
}

export function refName(ref: string): string {
  return isSecretRef(ref) ? ref.slice(REF_PREFIX.length) : ref;
}

export class CredentialStore {
  private readonly home: string;
  private readonly backend: 'keychain' | 'file';

  constructor(opts: CredentialStoreOptions = {}) {
    this.home = opts.home ?? path.join(os.homedir(), '.mediabot');
    this.backend = opts.backend ?? (process.platform === 'darwin' ? 'keychain' : 'file');
  }

  get backendName(): string {
    return this.backend;
  }

  async set(name: string, secret: string): Promise<string> {
    if (this.backend === 'keychain') {
      // -U updates in place; without it a second write fails as a duplicate.
      await exec('security', [
        'add-generic-password',
        '-s', SERVICE,
        '-a', name,
        '-w', secret,
        '-U',
      ]);
    } else {
      this.writeFileSecret(name, secret);
    }
    return secretRef(name);
  }

  async get(name: string): Promise<string | null> {
    if (this.backend === 'keychain') {
      try {
        const { stdout } = await exec('security', [
          'find-generic-password',
          '-s', SERVICE,
          '-a', name,
          '-w',
        ]);
        return stdout.replace(/\n$/, '');
      } catch {
        return null; // Not found, or the user denied keychain access.
      }
    }
    return this.readFileSecret(name);
  }

  async remove(name: string): Promise<void> {
    if (this.backend === 'keychain') {
      await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', name]).catch(() => {});
      return;
    }
    const all = this.readVault();
    delete all[name];
    this.writeVault(all);
  }

  /**
   * Resolve a config value that may be a reference.
   *
   * Returns the value unchanged when it is not a reference, so existing plain
   * config keeps working.
   */
  async resolve(value: string | undefined): Promise<string | undefined> {
    if (!value || !isSecretRef(value)) return value;
    const secret = await this.get(refName(value));
    return secret ?? undefined;
  }

  /** Resolve every reference in an object of possibly-secret values. */
  async resolveAll<T extends Record<string, string | undefined>>(obj: T): Promise<T> {
    const out: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = await this.resolve(v);
    return out as T;
  }

  // --- encrypted file backend ---------------------------------------------

  private vaultPath(): string {
    return path.join(this.home, 'secrets.enc');
  }

  private keyPath(): string {
    return path.join(this.home, 'secrets.key');
  }

  /**
   * Machine-local key, generated on first use.
   *
   * Mode 0600 and living beside the vault means this is obfuscation against
   * casual exposure (backups, screen shares, pasted config), not protection
   * from someone who already has your user account — the keychain backend is
   * the real answer where it exists.
   */
  private key(): Buffer {
    const p = this.keyPath();
    if (fs.existsSync(p)) return Buffer.from(fs.readFileSync(p, 'utf8'), 'hex');

    fs.mkdirSync(this.home, { recursive: true });
    const key = crypto.randomBytes(32);
    fs.writeFileSync(p, key.toString('hex'), { mode: 0o600 });
    return key;
  }

  private readVault(): Record<string, string> {
    const p = this.vaultPath();
    if (!fs.existsSync(p)) return {};

    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      iv: string;
      tag: string;
      data: string;
    };
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key(),
      Buffer.from(raw.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(raw.tag, 'hex'));
    const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, 'hex')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  }

  private writeVault(all: Record<string, string>): void {
    fs.mkdirSync(this.home, { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const data = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(all), 'utf8')),
      cipher.final(),
    ]);

    fs.writeFileSync(
      this.vaultPath(),
      JSON.stringify({
        iv: iv.toString('hex'),
        tag: cipher.getAuthTag().toString('hex'),
        data: data.toString('hex'),
      }),
      { mode: 0o600 },
    );
  }

  private writeFileSecret(name: string, secret: string): void {
    const all = this.readVault();
    all[name] = secret;
    this.writeVault(all);
  }

  private readFileSecret(name: string): string | null {
    return this.readVault()[name] ?? null;
  }
}
