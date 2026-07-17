import mongoose, { Document, Schema, Types } from 'mongoose';

export type CallLogType = 'audio' | 'video' | 'screen';
export type CallLogStatus = 'ringing' | 'active' | 'completed' | 'rejected' | 'missed';

export interface ICallLog extends Document {
  callId: string;
  conversation?: Types.ObjectId;
  initiator: Types.ObjectId;
  peer: Types.ObjectId;
  participants: Types.ObjectId[];
  callType: CallLogType;
  status: CallLogStatus;
  startedAt: Date;
  answeredAt?: Date;
  endedAt?: Date;
  durationSec?: number;
  createdAt: Date;
  updatedAt: Date;
}

const callLogSchema = new Schema<ICallLog>(
  {
    callId: { type: String, required: true, unique: true, index: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', index: true },
    initiator: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    peer: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }],
    callType: {
      type: String,
      enum: ['audio', 'video', 'screen'],
      default: 'audio',
    },
    status: {
      type: String,
      enum: ['ringing', 'active', 'completed', 'rejected', 'missed'],
      default: 'ringing',
      index: true,
    },
    startedAt: { type: Date, default: Date.now, index: true },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSec: { type: Number },
  },
  { timestamps: true }
);

callLogSchema.index({ participants: 1, startedAt: -1 });

export const CallLog = mongoose.model<ICallLog>('CallLog', callLogSchema);
