import mongoose, { Document, Schema, Types } from 'mongoose';

export type NotificationType =
  | 'message'
  | 'mention'
  | 'reaction'
  | 'group_invite'
  | 'group_added'
  | 'call'
  | 'system';

export interface INotification extends Document {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  isRead: boolean;
  readAt?: Date;
  actor?: Types.ObjectId;
  conversation?: Types.ObjectId;
  message?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['message', 'mention', 'reaction', 'group_invite', 'group_added', 'call', 'system'],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed, default: {} },
    isRead: { type: Boolean, default: false },
    readAt: { type: Date },
    actor: { type: Schema.Types.ObjectId, ref: 'User' },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    message: { type: Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, createdAt: -1 });
notificationSchema.index({ user: 1, isRead: 1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
export default Notification;
