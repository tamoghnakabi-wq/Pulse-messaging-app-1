import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAttachmentDoc extends Document {
  _id: Types.ObjectId;
  uploader: Types.ObjectId;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  url: string;
  thumbnailUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
  isE2E?: boolean;
  e2eMeta?: string;
  mediaClass?: string;
  conversation?: Types.ObjectId;
  message?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const attachmentDocSchema = new Schema<IAttachmentDoc>(
  {
    uploader: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    filename: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    url: { type: String, required: true },
    thumbnailUrl: { type: String },
    duration: { type: Number },
    width: { type: Number },
    height: { type: Number },
    isE2E: { type: Boolean, default: false },
    e2eMeta: { type: String, maxlength: 4096 },
    mediaClass: { type: String, maxlength: 32 },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    message: { type: Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);

attachmentDocSchema.index({ uploader: 1, createdAt: -1 });

export const Attachment = mongoose.model<IAttachmentDoc>('Attachment', attachmentDocSchema);
export default Attachment;
