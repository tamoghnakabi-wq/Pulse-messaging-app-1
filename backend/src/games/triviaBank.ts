/**
 * Server-curated trivia — Phase 1 only.
 * Never accept user-supplied questions.
 */
export interface TriviaQuestion {
  id: string;
  category: string;
  prompt: string;
  choices: [string, string, string, string];
  /** 0–3 — never sent to clients until round resolves */
  correctIndex: number;
}

export const TRIVIA_BANK: TriviaQuestion[] = [
  {
    id: 't1',
    category: 'Science',
    prompt: 'What planet is known as the Red Planet?',
    choices: ['Venus', 'Mars', 'Jupiter', 'Mercury'],
    correctIndex: 1,
  },
  {
    id: 't2',
    category: 'Geography',
    prompt: 'Which ocean is the largest?',
    choices: ['Atlantic', 'Indian', 'Arctic', 'Pacific'],
    correctIndex: 3,
  },
  {
    id: 't3',
    category: 'History',
    prompt: 'In which year did the first humans land on the Moon?',
    choices: ['1965', '1969', '1972', '1959'],
    correctIndex: 1,
  },
  {
    id: 't4',
    category: 'Sports',
    prompt: 'How many players are on a soccer team on the field?',
    choices: ['9', '10', '11', '12'],
    correctIndex: 2,
  },
  {
    id: 't5',
    category: 'Tech',
    prompt: 'What does CPU stand for?',
    choices: [
      'Central Processing Unit',
      'Computer Personal Utility',
      'Core Power Unit',
      'Central Program Utility',
    ],
    correctIndex: 0,
  },
  {
    id: 't6',
    category: 'Animals',
    prompt: 'Which animal is known as the King of the Jungle?',
    choices: ['Tiger', 'Elephant', 'Lion', 'Gorilla'],
    correctIndex: 2,
  },
  {
    id: 't7',
    category: 'Food',
    prompt: 'Which fruit is typically yellow when ripe?',
    choices: ['Apple', 'Banana', 'Grape', 'Plum'],
    correctIndex: 1,
  },
  {
    id: 't8',
    category: 'Music',
    prompt: 'How many strings does a standard guitar have?',
    choices: ['4', '5', '6', '7'],
    correctIndex: 2,
  },
  {
    id: 't9',
    category: 'Math',
    prompt: 'What is 12 × 12?',
    choices: ['124', '144', '132', '156'],
    correctIndex: 1,
  },
  {
    id: 't10',
    category: 'Movies',
    prompt: 'Which of these is a classic film studio?',
    choices: ['Pixar Park', 'Hollywood Hills Tea', 'Walt Disney Studios', 'Netflix Ranch'],
    correctIndex: 2,
  },
  {
    id: 't11',
    category: 'Space',
    prompt: 'What is the closest star to Earth?',
    choices: ['Polaris', 'Alpha Centauri', 'The Sun', 'Sirius'],
    correctIndex: 2,
  },
  {
    id: 't12',
    category: 'Language',
    prompt: 'How many letters are in the English alphabet?',
    choices: ['24', '25', '26', '27'],
    correctIndex: 2,
  },
  {
    id: 't13',
    category: 'Nature',
    prompt: 'What do bees collect to make honey?',
    choices: ['Pollen only', 'Nectar', 'Sap', 'Dew'],
    correctIndex: 1,
  },
  {
    id: 't14',
    category: 'General',
    prompt: 'How many days are in a leap year?',
    choices: ['364', '365', '366', '367'],
    correctIndex: 2,
  },
  {
    id: 't15',
    category: 'Geography',
    prompt: 'What is the capital of Japan?',
    choices: ['Osaka', 'Kyoto', 'Tokyo', 'Nagoya'],
    correctIndex: 2,
  },
  {
    id: 't16',
    category: 'Science',
    prompt: 'Water freezes at what temperature Celsius?',
    choices: ['-10', '0', '32', '100'],
    correctIndex: 1,
  },
  {
    id: 't17',
    category: 'Sports',
    prompt: 'In tennis, what is a score of zero called?',
    choices: ['Nil', 'Love', 'Blank', 'Duck'],
    correctIndex: 1,
  },
  {
    id: 't18',
    category: 'Tech',
    prompt: 'HTML is primarily used to:',
    choices: ['Style pages', 'Structure web content', 'Query databases', 'Compile apps'],
    correctIndex: 1,
  },
  {
    id: 't19',
    category: 'History',
    prompt: 'The ancient pyramids of Giza are in which country?',
    choices: ['Mexico', 'Peru', 'Egypt', 'Sudan'],
    correctIndex: 2,
  },
  {
    id: 't20',
    category: 'Animals',
    prompt: 'A group of wolves is called a:',
    choices: ['Herd', 'Pack', 'Flock', 'School'],
    correctIndex: 1,
  },
];

/** Deterministic shuffle from seed string */
export function pickTriviaQuestions(count: number, seed: string): TriviaQuestion[] {
  const n = Math.min(Math.max(1, count), TRIVIA_BANK.length);
  const arr = [...TRIVIA_BANK];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}
