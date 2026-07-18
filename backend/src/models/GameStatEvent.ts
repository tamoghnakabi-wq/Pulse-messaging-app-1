import mongoose, { Document, Schema, Types } from 'mongoose';

/**
 * Audit ledger for game → stats effects.
 * Unique (game, user, scope). Written *after* the atomic GameStats claim
 * (`appliedGameIds` + $inc). Used for observability and legacy recovery:
 * if a row exists from older code (ledger-first), counters must not $inc again.
 * scope: 'global' or conversation ObjectId hex string.
 */
export interface IGameStatEvent extends Document {
  game: Types.ObjectId;
  user: Types.ObjectId;
  scope: string;
  result: 'win' | 'loss' | 'draw';
  gameType: string;
  createdAt: Date;
}

const gameStatEventSchema = new Schema<IGameStatEvent>(
  {
    game: { type: Schema.Types.ObjectId, ref: 'Game', required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    scope: { type: String, required: true },
    result: { type: String, enum: ['win', 'loss', 'draw'], required: true },
    gameType: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

gameStatEventSchema.index({ game: 1, user: 1, scope: 1 }, { unique: true });

export const GameStatEvent = mongoose.model<IGameStatEvent>('GameStatEvent', gameStatEventSchema);
export default GameStatEvent;
