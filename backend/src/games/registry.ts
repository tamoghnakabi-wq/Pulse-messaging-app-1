import { connectFourEngine } from './engines/connectFour';
import { emojiGuessEngine } from './engines/emojiGuess';
import { ticTacToeEngine } from './engines/ticTacToe';
import { triviaDuelEngine } from './engines/triviaDuel';
import type { GameEngine, GameTypeId } from './types';
import { GameRuleError } from './types';

const ENGINES: Record<GameTypeId, GameEngine> = {
  tic_tac_toe: ticTacToeEngine,
  connect_four: connectFourEngine,
  trivia_duel: triviaDuelEngine,
  emoji_guess: emojiGuessEngine,
};

export function getEngine(type: string): GameEngine {
  const eng = ENGINES[type as GameTypeId];
  if (!eng) throw new GameRuleError(`Unknown game type: ${type}`, 'UNKNOWN_GAME', 400);
  return eng;
}

export function listGameCatalog() {
  return Object.values(ENGINES).map((e) => ({
    type: e.type,
    displayName: e.displayName,
    icon: e.icon,
    description: e.description,
    minPlayers: e.minPlayers,
    maxPlayers: e.maxPlayers,
  }));
}

export function isGameType(type: string): type is GameTypeId {
  return type in ENGINES;
}
