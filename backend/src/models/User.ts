import mongoose, { Document, Schema, Types } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUserSettings {
  theme: 'light' | 'dark' | 'system';
  /** Chat wallpaper id (frontend catalog) */
  chatBackground?: string;
  notifications: {
    browser: boolean;
    sound: boolean;
    mentions: boolean;
    messages: boolean;
  };
  privacy: {
    lastSeen: 'everyone' | 'contacts' | 'nobody';
    readReceipts: boolean;
    profilePhoto: 'everyone' | 'contacts' | 'nobody';
    /** When false, email is hidden from other users' contact view (default true) */
    showEmail?: boolean;
    /** Online status visibility (defaults to lastSeen if unset) */
    onlineStatus?: 'everyone' | 'contacts' | 'nobody';
    /** Who may start calls with this user */
    calls?: 'everyone' | 'contacts' | 'nobody';
  };
}

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password: string;
  displayName: string;
  bio: string;
  avatar: string;
  /** Wide banner image shown on profile (optional) */
  coverPhoto: string;
  /**
   * ECDH P-256 public key (SPKI, base64) for end-to-end chat encryption.
   * Private key never leaves the client device.
   */
  identityPublicKey: string;
  isOnline: boolean;
  lastSeen: Date;
  isEmailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  starredMessages: Types.ObjectId[];
  settings: IUserSettings;
  /** Users this account has blocked (cannot message / call) */
  blockedUsers: Types.ObjectId[];
  /** Failed password attempts (for lockout) */
  failedLoginAttempts?: number;
  lockUntil?: Date;
  /** Optional TOTP 2FA — never compulsory */
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string;
  twoFactorBackupCodes?: string[];
  /**
   * Password-wrapped E2E identity private key (client-encrypted blob).
   * Survives browser origin changes (e.g. Cloudflare tunnel URL rotation).
   * Server never sees the plaintext private key or the password.
   */
  e2eKeyBackup?: {
    v: number;
    publicKey: string;
    salt: string;
    iv: string;
    ciphertext: string;
  };
  lastLoginAt?: Date;
  lastLoginIp?: string;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
  toPublicJSON(): Record<string, unknown>;
  isLocked(): boolean;
}

const CHAT_BACKGROUND_IDS = [
  'default',
  'pulse',
  'midnight',
  'aurora',
  'sunset',
  'ocean',
  'forest',
  'graphite',
  'dusk',
  'sand',
  'ember',
  'frost',
] as const;

const userSettingsSchema = new Schema<IUserSettings>(
  {
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
    chatBackground: {
      type: String,
      enum: CHAT_BACKGROUND_IDS,
      default: 'default',
    },
    notifications: {
      browser: { type: Boolean, default: true },
      sound: { type: Boolean, default: true },
      mentions: { type: Boolean, default: true },
      messages: { type: Boolean, default: true },
    },
    privacy: {
      lastSeen: { type: String, enum: ['everyone', 'contacts', 'nobody'], default: 'everyone' },
      readReceipts: { type: Boolean, default: true },
      profilePhoto: { type: String, enum: ['everyone', 'contacts', 'nobody'], default: 'everyone' },
      showEmail: { type: Boolean, default: true },
      onlineStatus: {
        type: String,
        enum: ['everyone', 'contacts', 'nobody'],
        default: 'everyone',
      },
      calls: {
        type: String,
        enum: ['everyone', 'contacts', 'nobody'],
        default: 'everyone',
      },
    },
  },
  { _id: false }
);

const userSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 32,
      match: /^[a-z0-9_]+$/,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 64,
    },
    bio: {
      type: String,
      default: '',
      maxlength: 300,
    },
    avatar: {
      type: String,
      default: '',
    },
    coverPhoto: {
      type: String,
      default: '',
    },
    identityPublicKey: {
      type: String,
      default: '',
      maxlength: 2048,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpires: { type: Date, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date, select: false },
    starredMessages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    settings: {
      type: userSettingsSchema,
      default: () => ({}),
    },
    blockedUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    failedLoginAttempts: { type: Number, default: 0 },
    lockUntil: { type: Date },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, select: false, default: '' },
    twoFactorBackupCodes: { type: [String], select: false, default: [] },
    e2eKeyBackup: {
      type: new Schema(
        {
          v: { type: Number, default: 1 },
          publicKey: { type: String, maxlength: 2048, default: '' },
          salt: { type: String, maxlength: 128, default: '' },
          iv: { type: String, maxlength: 64, default: '' },
          ciphertext: { type: String, maxlength: 8192, default: '' },
        },
        { _id: false }
      ),
      select: false,
      default: undefined,
    },
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String, default: '' },
  },
  { timestamps: true }
);

userSchema.index({ username: 'text', displayName: 'text' });
userSchema.index({ isOnline: 1, lastSeen: -1 });
// Login by email or username (unique already on fields; compound helps $or plans)
userSchema.index({ email: 1, username: 1 });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  // Work factor configurable via BCRYPT_ROUNDS (default 12)
  const rounds = Math.min(
    15,
    Math.max(10, parseInt(process.env.BCRYPT_ROUNDS || '12', 10) || 12)
  );
  this.password = await bcrypt.hash(this.password, rounds);
  next();
});

userSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.isLocked = function (): boolean {
  return !!(this.lockUntil && this.lockUntil > new Date());
};

userSchema.methods.toPublicJSON = function () {
  // Sign media URLs at the edge when serving (DB keeps plain relative paths)
  let avatar = this.avatar || '';
  let coverPhoto = this.coverPhoto || '';
  try {
    // Lazy require to avoid circular import at model load time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { signUploadPath } = require('../utils/mediaSign') as {
      signUploadPath: (p: string) => string;
    };
    if (avatar.includes('/uploads/')) {
      avatar = signUploadPath(String(avatar).split('?')[0]);
    }
    if (coverPhoto.includes('/uploads/')) {
      coverPhoto = signUploadPath(String(coverPhoto).split('?')[0]);
    }
  } catch {
    /* keep plain path */
  }
  return {
    id: this._id.toString(),
    username: this.username,
    email: this.email,
    displayName: this.displayName,
    bio: this.bio,
    avatar,
    coverPhoto,
    identityPublicKey: this.identityPublicKey || '',
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
    isEmailVerified: this.isEmailVerified,
    twoFactorEnabled: !!this.twoFactorEnabled,
    settings: this.settings,
    blockedUsers: (this.blockedUsers || []).map((id: Types.ObjectId) => id.toString()),
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model<IUser>('User', userSchema);
export default User;
