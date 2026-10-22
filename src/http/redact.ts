/**
 * The key never leaves the process: every line the CLI prints goes through {@link Redactor}, which
 * blanks the key (whole, or only its secret part after `|`) and anything with the shape of one.
 */

/** Anything that looks like the secret part of a Funnelchat key (`fc_live_…`). */
const KEY_SHAPE = /fc_[a-z]+_[A-Za-z0-9]{4,}/g;
export const REDACTED = '[key hidden]';

export class Redactor {
  readonly #secrets: string[] = [];

  /** Adds a value to blank everywhere: the whole key and its secret part. */
  add(key: string | undefined): void {
    if (!key) return;
    const parts = [key, key.includes('|') ? key.slice(key.indexOf('|') + 1) : ''];
    for (const part of parts) if (part.length >= 6 && !this.#secrets.includes(part)) this.#secrets.push(part);
    this.#secrets.sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join(REDACTED);
    return out.replace(KEY_SHAPE, REDACTED);
  }
}
