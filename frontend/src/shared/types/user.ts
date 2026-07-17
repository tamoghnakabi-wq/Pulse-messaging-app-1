export interface UserSettings {
  theme: 'light' | 'dark' | 'system';
  /** Chat message-area wallpaper id (see chatBackgrounds catalog) */
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
    /** false = hide email from other users' contact view (default true) */
    showEmail?: boolean;
    onlineStatus?: 'everyone' | 'contacts' | 'nobody';
    calls?: 'everyone' | 'contacts' | 'nobody';
  };
}

export interface User {
  id: string;
  username: string;
  email?: string;
  /** True when the user has a chat with you but chose to hide email */
  emailHidden?: boolean;
  displayName: string;
  bio?: string;
  avatar?: string;
  /** Wide banner on profile (optional) */
  coverPhoto?: string;
  /** ECDH P-256 public key (SPKI base64) for E2E chat */
  identityPublicKey?: string;
  isOnline?: boolean;
  lastSeen?: string;
  isEmailVerified?: boolean;
  twoFactorEnabled?: boolean;
  blockedUsers?: string[];
  settings?: UserSettings;
  createdAt?: string;
}

export type SessionDeviceType = 'desktop' | 'mobile' | 'tablet' | 'unknown';

export interface SessionDevice {
  label: string;
  browser: string;
  os: string;
  type: SessionDeviceType;
  model?: string;
}

export interface SessionInfo {
  id: string;
  userAgent: string;
  /** Display-ready IP (localhost labeled, IPv6-mapped cleaned) */
  ip: string;
  ipRaw?: string;
  lastActiveAt: string;
  createdAt: string;
  expiresAt?: string;
  current: boolean;
  device?: SessionDevice;
  /** True if active within ~2 minutes (or this session) */
  isOnline?: boolean;
  /** e.g. "Active now", "Active 3h ago" */
  activityLabel?: string;
}
