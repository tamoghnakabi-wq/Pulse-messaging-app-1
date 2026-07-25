import mongoose, { Document, Schema, Types } from 'mongoose';

export type ConversationType = 'direct' | 'group';

export interface IParticipant {
  user: Types.ObjectId;
  role: 'member' | 'admin' | 'owner';
  joinedAt: Date;
  lastReadAt: Date;
  lastReadMessageId?: Types.ObjectId;
  isMuted: boolean;
  isPinned: boolean;
  isArchived: boolean;
  isFavorite: boolean;
  /** Denormalized unread for O(1) chat-list rendering at scale */
  unreadCount?: number;
  deletedForMeAt?: Date;
  nickname?: string;
}

export interface IConversation extends Document {
  _id: Types.ObjectId;
  type: ConversationType;
  name?: string;
  description?: string;
  avatar?: string;
  participants: IParticipant[];
  /**
   * Stable `${smallerUserId}:${largerUserId}` key for direct chats, unique so
   * two people opening a chat with each other simultaneously cannot end up with
   * two conversations. Unset for groups and for direct chats created before
   * this field existed.
   */
  directKey?: string;
  createdBy: Types.ObjectId;
  lastMessage?: Types.ObjectId;
  lastMessageAt?: Date;
  pinnedMessages: Types.ObjectId[];
  inviteCode?: string;
  isActive: boolean;
  /**
   * Group E2E: AES group key wrapped (encrypted) for each participant
   * with their identity public key. Server cannot unwrap.
   */
  e2eWrappedKeys?: { userId: Types.ObjectId; wrappedKey: string }[];
  e2eVersion?: number;
  createdAt: Date;
  updatedAt: Date;
}

const participantSchema = new Schema<IParticipant>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['member', 'admin', 'owner'], default: 'member' },
    joinedAt: { type: Date, default: Date.now },
    lastReadAt: { type: Date, default: Date.now },
    lastReadMessageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    isMuted: { type: Boolean, default: false },
    isPinned: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    isFavorite: { type: Boolean, default: false },
    unreadCount: { type: Number, default: 0, min: 0 },
    deletedForMeAt: { type: Date },
    nickname: { type: String, maxlength: 64 },
  },
  { _id: false }
);

const conversationSchema = new Schema<IConversation>(
  {
    type: { type: String, enum: ['direct', 'group'], required: true },
    name: { type: String, trim: true, maxlength: 100 },
    description: { type: String, maxlength: 500, default: '' },
    avatar: { type: String, default: '' },
    participants: { type: [participantSchema], required: true },
    directKey: { type: String, unique: true, sparse: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastMessage: { type: Schema.Types.ObjectId, ref: 'Message' },
    lastMessageAt: { type: Date },
    pinnedMessages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    inviteCode: { type: String, unique: true, sparse: true },
    isActive: { type: Boolean, default: true },
    e2eVersion: { type: Number, default: 0 },
    e2eWrappedKeys: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'User' },
        wrappedKey: { type: String, maxlength: 4096 },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

// Hot path: list chats for a user sorted by activity
conversationSchema.index({ 'participants.user': 1, isActive: 1, lastMessageAt: -1 });
conversationSchema.index({ type: 1, isActive: 1 });
// Direct-call authorization: both participants + active
conversationSchema.index({ type: 1, isActive: 1, 'participants.user': 1 });

/** Canonical, order-independent key for the direct chat between two users. */
export function directConversationKey(userA: string, userB: string): string {
  return userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;
}

export const Conversation = mongoose.model<IConversation>('Conversation', conversationSchema);
export default Conversation;
