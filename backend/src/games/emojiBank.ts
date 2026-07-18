/**
 * Server-curated emoji riddles for Emoji Guess.
 * Format: emoji clue → short answer (normalized lowercase).
 */
export interface EmojiRiddle {
  id: string;
  emoji: string;
  /** Accepted answers (lowercase, trimmed) */
  answers: string[];
  hint?: string;
}

export const EMOJI_BANK: EmojiRiddle[] = [
  { id: 'e1', emoji: '🦁👑', answers: ['lion king', 'the lion king'], hint: 'Disney film' },
  { id: 'e2', emoji: '🕷️👨', answers: ['spiderman', 'spider-man', 'spider man'], hint: 'Hero' },
  { id: 'e3', emoji: '❄️👸', answers: ['frozen'], hint: 'Disney film' },
  { id: 'e4', emoji: '⚡👦', answers: ['harry potter'], hint: 'Wizard' },
  { id: 'e5', emoji: '🦇👨', answers: ['batman', 'bat man'], hint: 'Gotham' },
  { id: 'e6', emoji: '🍎📱', answers: ['apple', 'iphone'], hint: 'Brand' },
  { id: 'e7', emoji: '🍕🇮🇹', answers: ['pizza', 'italy'], hint: 'Food / country' },
  { id: 'e8', emoji: '🌊🏄', answers: ['surfing', 'surf'], hint: 'Sport' },
  { id: 'e9', emoji: '🚀🌕', answers: ['moon landing', 'apollo', 'space'], hint: 'History' },
  { id: 'e10', emoji: '☕😴', answers: ['coffee', 'need coffee', 'tired'], hint: 'Drink' },
  { id: 'e11', emoji: '🏠🔥', answers: ['home alone'], hint: 'Holiday film' },
  { id: 'e12', emoji: '👻🚫', answers: ['ghostbusters', 'ghost busters'], hint: 'Film' },
  { id: 'e13', emoji: '🐢👀', answers: ['big brother', '1984'], hint: 'Watching' },
  { id: 'e14', emoji: '🎵🎤', answers: ['karaoke', 'singing', 'concert'], hint: 'Music' },
  { id: 'e15', emoji: '🐍✈️', answers: ['snakes on a plane'], hint: 'Film title' },
  { id: 'e16', emoji: '💍🌋', answers: ['lord of the rings', 'lotr'], hint: 'Fantasy' },
  { id: 'e17', emoji: '🦖🧬', answers: ['jurassic park', 'jurassic world'], hint: 'Dinosaurs' },
  { id: 'e18', emoji: '🏴‍☠️💎', answers: ['pirates', 'pirates of the caribbean'], hint: 'Adventure' },
  { id: 'e19', emoji: '🍫🏭', answers: ['charlie and the chocolate factory', 'willy wonka'], hint: 'Film' },
  { id: 'e20', emoji: '🚗💨', answers: ['fast and furious', 'fast furious'], hint: 'Film series' },
];

export function normalizeGuess(s: string): string {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ');
}

export function pickEmojiRiddles(count: number, seed: string): EmojiRiddle[] {
  const n = Math.min(Math.max(1, count), EMOJI_BANK.length);
  const arr = [...EMOJI_BANK];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}
