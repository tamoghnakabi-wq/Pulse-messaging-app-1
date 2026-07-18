import mongoose, { Document, Schema, Types } from 'mongoose';
import type { GameStatus, GameTypeId, PlayerJoinStatus } from '../games/types';

export interface IGamePlayer {
  user: Types.ObjectId;
  status: PlayerJoinStatus;
  score: number;
  order: number;
  symbol?: string;
}

export interface IGame extends Document {
  conversation: Types.ObjectId;
  gameType: GameTypeId;
  status: GameStatus;
  creator: Types.ObjectId;
  players: IGamePlayer[];
  state: Record<string, unknown>;
  options: Record<string, unknown>;
  currentTurnUser?: Types.ObjectId;
  winnerIds: Types.ObjectId[];
  isDraw: boolean;
  version: number;
  /** Client action ids already applied (idempotency) */
  processedActionIds: string[];
  /** Set true after stats written once for this completed game */
  statsRecorded?: boolean;
  /** Lease timestamp while a worker is recording stats (recoverable if process dies) */
  statsRecordingAt?: Date | null;
  /** When false, only listed players may join; when true open group invite */
  openInvite?: boolean;
  rematchOf?: Types.ObjectId;
  startedAt?: Date;
  completedAt?: Date;
  expiresAt: Date;
  inviteMessage?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const gamePlayerSchema = new Schema<IGamePlayer>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: ['invited', 'joined', 'declined', 'left'],
      default: 'invited',
    },
    score: { type: Number, default: 0 },
    order: { type: Number, default: 0 },
    symbol: { type: String, maxlength: 8 },
  },
  { _id: false }
);

const gameSchema = new Schema<IGame>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    gameType: {
      type: String,
      enum: ['tic_tac_toe', 'connect_four', 'trivia_duel', 'emoji_guess'],
      required: true,
    },
    status: {
      type: String,
      enum: ['invited', 'active', 'completed', 'declined', 'cancelled', 'expired'],
      default: 'invited',
      index: true,
    },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    players: { type: [gamePlayerSchema], default: [] },
    state: { type: Schema.Types.Mixed, default: {} },
    options: { type: Schema.Types.Mixed, default: {} },
    currentTurnUser: { type: Schema.Types.ObjectId, ref: 'User' },
    winnerIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isDraw: { type: Boolean, default: false },
    version: { type: Number, default: 1 },
    processedActionIds: { type: [String], default: [] },
    statsRecorded: { type: Boolean, default: false },
    statsRecordingAt: { type: Date, default: null },
    openInvite: { type: Boolean, default: false },
    rematchOf: { type: Schema.Types.ObjectId, ref: 'Game' },
    startedAt: { type: Date },
    completedAt: { type: Date },
    expiresAt: { type: Date, required: true, index: true },
    inviteMessage: { type: Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);

gameSchema.index({ conversation: 1, createdAt: -1 });
gameSchema.index({ conversation: 1, status: 1, createdAt: -1 });
gameSchema.index({ 'players.user': 1, createdAt: -1 });

export const Game = mongoose.model<IGame>('Game', gameSchema);
export default Game;
