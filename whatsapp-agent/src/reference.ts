/**
 * Short codes Lukas types back on WhatsApp — for an application to approve, or
 * a possible-duplicate pair to rule on.
 *
 * The first character is always a letter and the alphabet drops I/O/0/1, so a
 * code can never be mistaken for an amount that follows it, and can't be
 * misread off a phone screen.
 */

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ALPHABET = `${LETTERS}23456789`;

export function referenceFor(id: string): string {
  let value = Number.parseInt(id.replace(/-/g, '').slice(0, 8), 16);
  const characters = [LETTERS[value % LETTERS.length]!];
  value = Math.floor(value / LETTERS.length);

  for (let index = 1; index < 4; index += 1) {
    characters.push(ALPHABET[value % ALPHABET.length]!);
    value = Math.floor(value / ALPHABET.length);
  }
  return characters.join('');
}
