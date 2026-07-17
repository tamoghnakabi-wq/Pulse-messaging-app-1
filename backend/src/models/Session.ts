import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISession extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  refreshTokenHash: string;
  userAgent: string;
  ip: string;
  isValid: boolean;
  expiresAt: Date;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<ISession>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true },
    userAgent: { type: String, default: '' },
    ip: { type: String, default: '' },
    isValid: { type: Boolean, default: true },
    expiresAt: { type: Date, required: true },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Auth middleware: session lookup by id + user + valid
sessionSchema.index({ user: 1, isValid: 1, expiresAt: 1 });
sessionSchema.index({ refreshTokenHash: 1 }, { sparse: true });

export const Session = mongoose.model<ISession>('Session', sessionSchema);
export default Session;
