import mongoose, { Document, Schema, Types } from 'mongoose';
import { randomBytes } from 'crypto';

export interface IPollOption {
  id: string;
  text: string;
  /** Denormalized count for fast UI */
  voteCount: number;
}

export interface IPollVote {
  user: Types.ObjectId;
  optionIds: string[];
  at: Date;
}

export interface IPoll extends Document {
  _id: Types.ObjectId;
  conversation: Types.ObjectId;
  creator: Types.ObjectId;
  message?: Types.ObjectId;
  question: string;
  options: IPollOption[];
  /** Allow selecting more than one option */
  allowMultiple: boolean;
  /** Hide who voted (counts only) */
  isAnonymous: boolean;
  isClosed: boolean;
  closedAt?: Date;
  /** Optional auto-close */
  closesAt?: Date;
  votes: IPollVote[];
  createdAt: Date;
  updatedAt: Date;
}

export function newOptionId(): string {
  return randomBytes(6).toString('hex');
}

const pollOptionSchema = new Schema<IPollOption>(
  {
    id: { type: String, required: true },
    text: { type: String, required: true, maxlength: 200 },
    voteCount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const pollVoteSchema = new Schema<IPollVote>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    optionIds: { type: [String], default: [] },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const pollSchema = new Schema<IPoll>(
  {
    conversation: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    creator: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    message: { type: Schema.Types.ObjectId, ref: 'Message', index: true },
    question: { type: String, required: true, maxlength: 500, trim: true },
    options: {
      type: [pollOptionSchema],
      validate: {
        validator: (v: IPollOption[]) => Array.isArray(v) && v.length >= 2 && v.length <= 12,
        message: 'Poll needs 2–12 options',
      },
    },
    allowMultiple: { type: Boolean, default: false },
    isAnonymous: { type: Boolean, default: false },
    isClosed: { type: Boolean, default: false },
    closedAt: { type: Date },
    closesAt: { type: Date },
    votes: { type: [pollVoteSchema], default: [] },
  },
  { timestamps: true }
);

pollSchema.index({ conversation: 1, createdAt: -1 });

export const Poll = mongoose.model<IPoll>('Poll', pollSchema);
export default Poll;
