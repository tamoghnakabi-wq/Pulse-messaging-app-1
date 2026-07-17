import { Types } from 'mongoose';
import { CallLog, type CallLogStatus, type CallLogType } from '../../models/CallLog';
import logger from '../../utils/logger';
import { signUploadPath } from '../../utils/mediaSign';

function oid(id: string | Types.ObjectId) {
  return typeof id === 'string' ? new Types.ObjectId(id) : id;
}

function signAvatar(avatar?: string | null): string | null {
  if (!avatar) return null;
  const path = String(avatar).split('?')[0];
  if (path.includes('/uploads/')) return signUploadPath(path);
  return path || null;
}

export async function recordCallStart(opts: {
  callId: string;
  initiatorId: string;
  peerId: string;
  conversationId?: string;
  callType?: string;
}): Promise<void> {
  try {
    const callType = (['audio', 'video', 'screen'].includes(String(opts.callType))
      ? opts.callType
      : 'audio') as CallLogType;

    await CallLog.findOneAndUpdate(
      { callId: opts.callId },
      {
        $setOnInsert: {
          callId: opts.callId,
          initiator: oid(opts.initiatorId),
          peer: oid(opts.peerId),
          participants: [oid(opts.initiatorId), oid(opts.peerId)],
          conversation: opts.conversationId ? oid(opts.conversationId) : undefined,
          callType,
          status: 'ringing' as CallLogStatus,
          startedAt: new Date(),
        },
      },
      { upsert: true, new: true }
    );
  } catch (e) {
    logger.warn('recordCallStart failed', e);
  }
}

export async function recordCallAccepted(callId: string): Promise<void> {
  try {
    await CallLog.findOneAndUpdate(
      { callId, status: { $in: ['ringing', 'active'] } },
      {
        $set: {
          status: 'active',
          answeredAt: new Date(),
        },
      }
    );
  } catch (e) {
    logger.warn('recordCallAccepted failed', e);
  }
}

export async function recordCallRejected(callId: string): Promise<void> {
  try {
    await CallLog.findOneAndUpdate(
      { callId, status: { $in: ['ringing', 'active'] } },
      {
        $set: {
          status: 'rejected',
          endedAt: new Date(),
        },
      }
    );
  } catch (e) {
    logger.warn('recordCallRejected failed', e);
  }
}

export async function recordCallEnded(callId: string): Promise<void> {
  try {
    const log = await CallLog.findOne({ callId });
    if (!log) return;
    if (log.status === 'completed' || log.status === 'rejected' || log.status === 'missed') {
      return;
    }

    const endedAt = new Date();
    if (log.answeredAt || log.status === 'active') {
      const start = log.answeredAt || log.startedAt;
      const durationSec = Math.max(0, Math.round((endedAt.getTime() - start.getTime()) / 1000));
      log.status = 'completed';
      log.endedAt = endedAt;
      log.durationSec = durationSec;
    } else {
      // Never answered — missed for callee, shown as "No answer" for caller in UI
      log.status = 'missed';
      log.endedAt = endedAt;
      log.durationSec = 0;
    }
    await log.save();
  } catch (e) {
    logger.warn('recordCallEnded failed', e);
  }
}

export async function listCallHistoryForUser(userId: string, limit = 80) {
  const uid = oid(userId);
  const rows = await CallLog.find({ participants: uid })
    .sort({ startedAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .populate('initiator', 'username displayName avatar')
    .populate('peer', 'username displayName avatar')
    .populate('conversation', '_id type')
    .lean();

  return rows.map((r) => {
    const initiator = r.initiator as {
      _id: Types.ObjectId;
      username?: string;
      displayName?: string;
      avatar?: string;
    };
    const peer = r.peer as {
      _id: Types.ObjectId;
      username?: string;
      displayName?: string;
      avatar?: string;
    };
    const isOutgoing = String(initiator._id) === String(uid);
    const other = isOutgoing ? peer : initiator;

    return {
      id: String(r._id),
      callId: r.callId,
      conversationId: r.conversation ? String((r.conversation as { _id: Types.ObjectId })._id) : null,
      callType: r.callType,
      status: r.status,
      direction: isOutgoing ? ('outgoing' as const) : ('incoming' as const),
      startedAt: r.startedAt,
      answeredAt: r.answeredAt || null,
      endedAt: r.endedAt || null,
      durationSec: r.durationSec ?? 0,
      otherUser: {
        id: String(other?._id || ''),
        username: other?.username || '',
        displayName: other?.displayName || other?.username || 'User',
        // Must sign like conversation list — raw /uploads paths 403 without ?exp=&sig=
        avatar: signAvatar(other?.avatar),
      },
    };
  });
}
