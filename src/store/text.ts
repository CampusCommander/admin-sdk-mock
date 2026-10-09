import type { DatabaseSync } from 'node:sqlite';

const WORD = /[\p{L}\p{N}]+/gu;

export const words = (text: string): string[] =>
  text.toLowerCase().match(WORD) ?? [];

/** True when the phrase appears in the text as consecutive whole words. */
export function containsWords(text: string | null, phrase: string): boolean {
  if (text === null) return false;
  const haystack = words(text);
  const needle = words(phrase);
  if (needle.length === 0) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** True when the text, or any word in it, starts with the prefix. */
export function hasWordPrefix(text: string | null, prefix: string): boolean {
  if (text === null) return false;
  const lower = prefix.toLowerCase();
  return (
    text.toLowerCase().startsWith(lower) ||
    words(text).some((word) => word.startsWith(lower))
  );
}

export function registerTextFunctions(db: DatabaseSync): void {
  db.function('cc_contains_words', { deterministic: true }, (text, phrase) =>
    containsWords(text as string | null, String(phrase)) ? 1 : 0,
  );
  db.function('cc_word_prefix', { deterministic: true }, (text, prefix) =>
    hasWordPrefix(text as string | null, String(prefix)) ? 1 : 0,
  );
}
