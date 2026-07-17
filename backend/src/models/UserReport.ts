import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IUserReport extends Document {
  _id: Types.ObjectId;
  reporter: Types.ObjectId;
  reported: Types.ObjectId;
  reason: string;
  details?: string;
  status: 'open' | 'reviewed' | 'dismissed';
  createdAt: Date;
  updatedAt: Date;
}

const userReportSchema = new Schema<IUserReport>(
  {
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reported: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reason: {
      type: String,
      enum: ['spam', 'harassment', 'hate', 'scam', 'impersonation', 'other'],
      required: true,
    },
    details: { type: String, maxlength: 1000, default: '' },
    status: {
      type: String,
      enum: ['open', 'reviewed', 'dismissed'],
      default: 'open',
    },
  },
  { timestamps: true }
);

userReportSchema.index({ reporter: 1, reported: 1, createdAt: -1 });

export const UserReport = mongoose.model<IUserReport>('UserReport', userReportSchema);
export default UserReport;
