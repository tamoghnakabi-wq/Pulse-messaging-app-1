import mongoose, { Document, Schema, Types } from 'mongoose';

export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'voice' | 'system';

export interface IReaction {
  emoji: string;
  users: Types.ObjectId[];
}

export interface IAttachment {
  _id?: Types.ObjectId;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface IMessage extends Document {
  _id: Types.ObjectId;
  conversation: Types.ObjectId;
  sender: Types.ObjectId;
  type: MessageType;
  content: string;
  attachments: IAttachment[];
  replyTo?: Types.ObjectId;
  forwardedFrom?: Types.ObjectId;
  reactions: IReaction[];
  mentions: Types.ObjectId[];
  deliveredTo: Types.ObjectId[];
  readBy: { user: Types.ObjectId; readAt: Date }[];
  isEdited: boolean;
  editedAt?: Date;
  isDeleted: boolean;
  deletedAt?: Date;
  deletedFor: Types.ObjectId[];
  isPinned: boolean;
  /** Image message that recipients may open only once */
  viewOnce?: boolean;
  /** Users who have opened a view-once photo (not including sender) */
  viewOnceViewedBy?: Types.ObjectId[];
  clientId?: string;
  /** True when `content` is client-side E2E ciphertext (server stores opaque blob) */
  isE2E?: boolean;
  linkPreview?: {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<IAttachment>(
  {
    filename: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String, required: true },
    thumbnailUrl: { type: String },
    duration: { type: Number },
    width: { type: Number },
    height: { type: Number },
  },
  { _id: true }
);

const reactionSchema = new Schema<IReaction>(
  {
    emoji: { type: String, required: true },
    users: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { _id: false }
);

const messageSchema = new Schema<IMessage>(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['text', 'image', 'video', 'audio', 'document', 'voice', 'system'],
      default: 'text',
    },
    // Room for base64 ciphertext (E2E expands payload vs plaintext)
    content: { type: String, default: '', maxlength: 20000 },
    attachments: { type: [attachmentSchema], default: [] },
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message' },
    forwardedFrom: { type: Schema.Types.ObjectId, ref: 'Message' },
    reactions: { type: [reactionSchema], default: [] },
    mentions: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    deliveredTo: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    readBy: [
      {
        user: { type: Schema.Types.ObjectId, ref: 'User' },
        readAt: { type: Date, default: Date.now },
      },
    ],
    isEdited: { type: Boolean, default: false },
    editedAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    isPinned: { type: Boolean, default: false },
    viewOnce: { type: Boolean, default: false },
    viewOnceViewedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    clientId: { type: String, maxlength: 64, sparse: true },
    isE2E: { type: Boolean, default: false },
    linkPreview: {
      url: String,
      title: String,
      description: String,
      image: String,
      siteName: String,
    },
  },
  { timestamps: true }
);

// Primary history page: newest messages in a thread
messageSchema.index({ conversation: 1, createdAt: -1, _id: -1 });
// Unread-style filters: non-deleted messages by conversation + time
messageSchema.index({ conversation: 1, isDeleted: 1, createdAt: -1 });
// Pinned messages per conversation (sidebar + chat pins)
messageSchema.index(
  { conversation: 1, isPinned: 1, updatedAt: -1 },
  { partialFilterExpression: { isPinned: true } }
);
// Supports sender filters / analytics
messageSchema.index({ conversation: 1, sender: 1, createdAt: -1 });
// Full-text search (use sparingly — heavy on write)
messageSchema.index({ conversation: 1, content: 'text' });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ mentions: 1, createdAt: -1 });
// Retry-safe sends scoped to conversation (null clientId ignored via sparse)
messageSchema.index(
  { conversation: 1, sender: 1, clientId: 1 },
  { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

export const Message = mongoose.model<IMessage>('Message', messageSchema);
export default Message;
