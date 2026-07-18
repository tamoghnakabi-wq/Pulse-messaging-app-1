import mongoose, { Document, Schema, Types } from 'mongoose';

/** Per-user aggregate stats (global + optional per-conversation rollup) */
export interface IGameStats extends Document {
  user: Types.ObjectId;
  conversation?: Types.ObjectId;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  currentStreak: number;
  bestStreak: number;
  byType: Record<
    string,
    { played: number; wins: number; losses: number; draws: number }
  >;
  /**
   * Games already applied into this rollup (atomic with $inc).
   * Prevents the ledger-then-counter crash window from double-counting
   * or permanently under-counting on retry.
   */
  appliedGameIds: Types.ObjectId[];
  /** Achievement-ready counters (no XP system yet) */
  achievements: string[];
  achievementEvents: { code: string; at: Date; meta?: Record<string, unknown> }[];
  updatedAt: Date;
  createdAt: Date;
}

const gameStatsSchema = new Schema<IGameStats>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // null = global stats (not per-conversation)
    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      default: null,
      index: true,
    },
    gamesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
    losses: { type: Number, default: 0 },
    draws: { type: Number, default: 0 },
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    byType: { type: Schema.Types.Mixed, default: {} },
    appliedGameIds: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Game' }],
      default: [],
    },
    achievements: { type: [String], default: [] },
    achievementEvents: {
      type: [
        {
          code: String,
          at: { type: Date, default: Date.now },
          meta: Schema.Types.Mixed,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// Compound uniqueness: conversation may be null for global stats
gameStatsSchema.index({ user: 1, conversation: 1 }, { unique: true });

export const GameStats = mongoose.model<IGameStats>('GameStats', gameStatsSchema);
export default GameStats;
