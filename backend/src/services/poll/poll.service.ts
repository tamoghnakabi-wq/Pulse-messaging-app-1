import { Types } from 'mongoose';
import { Poll, newOptionId, type IPoll } from '../../models/Poll';
import { Message } from '../../models/Message';
import { Conversation } from '../../models/Conversation';
import { ensureConversationParticipant } from '../conversation/conversationAccess.service';
import { formatMessage } from '../../utils/messageFormat';
import { AppError } from '../../utils/AppError';
import { getIO } from '../../socket';
import { isObjectIdString } from '../../utils/sanitize';

export type PollPublic = {
  id: string;
  conversation: string;
  creator: string;
  messageId?: string;
  question: string;
  options: {
    id: string;
    text: string;
    voteCount: number;
    /** Present when not anonymous — display names optional later */
    voterIds?: string[];
  }[];
  allowMultiple: boolean;
  isAnonymous: boolean;
  isClosed: boolean;
  closedAt?: string;
  closesAt?: string;
  totalVotes: number;
  /** Option ids the current viewer selected */
  myOptionIds: string[];
  createdAt: string;
};

function maybeAutoClose(poll: IPoll): boolean {
  if (poll.isClosed) return false;
  if (poll.closesAt && poll.closesAt.getTime() <= Date.now()) {
    poll.isClosed = true;
    poll.closedAt = new Date();
    return true;
  }
  return false;
}

export function formatPoll(poll: IPoll, viewerId?: string): PollPublic {
  maybeAutoClose(poll);

  const myVote = viewerId
    ? poll.votes.find((v) => String(v.user) === String(viewerId))
    : undefined;

  // Build voter lists per option when not anonymous
  const votersByOption = new Map<string, string[]>();
  if (!poll.isAnonymous) {
    for (const opt of poll.options) votersByOption.set(opt.id, []);
    for (const v of poll.votes) {
      const uid = String(v.user);
      for (const oid of v.optionIds || []) {
        const list = votersByOption.get(oid);
        if (list && !list.includes(uid)) list.push(uid);
      }
    }
  }

  let totalVotes = 0;
  const options = poll.options.map((o) => {
    totalVotes += o.voteCount || 0;
    return {
      id: o.id,
      text: o.text,
      voteCount: o.voteCount || 0,
      ...(!poll.isAnonymous
        ? { voterIds: votersByOption.get(o.id) || [] }
        : {}),
    };
  });

  return {
    id: String(poll._id),
    conversation: String(poll.conversation),
    creator: String(poll.creator),
    messageId: poll.message ? String(poll.message) : undefined,
    question: poll.question,
    options,
    allowMultiple: !!poll.allowMultiple,
    isAnonymous: !!poll.isAnonymous,
    isClosed: !!poll.isClosed,
    closedAt: poll.closedAt?.toISOString(),
    closesAt: poll.closesAt?.toISOString(),
    totalVotes,
    myOptionIds: myVote?.optionIds ? [...myVote.optionIds] : [],
    createdAt: poll.createdAt?.toISOString?.() || new Date().toISOString(),
  };
}

function emitPollUpdated(conversationId: string, pollDto: PollPublic) {
  try {
    getIO().to(`conversation:${conversationId}`).emit('poll:updated', { poll: pollDto });
  } catch {
    /* */
  }
}

function emitMessageNew(conversationId: string, formatted: Record<string, unknown>) {
  try {
    getIO().to(`conversation:${conversationId}`).emit('message:new', formatted);
  } catch {
    /* */
  }
}

export const pollService = {
  async create(
    userId: string,
    conversationId: string,
    input: {
      question: string;
      options: string[];
      allowMultiple?: boolean;
      isAnonymous?: boolean;
      closesAt?: string | Date | null;
    }
  ) {
    if (!isObjectIdString(conversationId)) {
      throw new AppError('Invalid conversation', 400, 'VALIDATION');
    }
    await ensureConversationParticipant(conversationId, userId);

    const question = String(input.question || '').trim().slice(0, 500);
    if (question.length < 1) {
      throw new AppError('Question is required', 400, 'VALIDATION');
    }

    const texts = (input.options || [])
      .map((t) => String(t || '').trim().slice(0, 200))
      .filter(Boolean);
    if (texts.length < 2 || texts.length > 12) {
      throw new AppError('Poll needs 2–12 options', 400, 'VALIDATION');
    }

    let closesAt: Date | undefined;
    if (input.closesAt) {
      const d = new Date(input.closesAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        throw new AppError('closesAt must be a future date', 400, 'VALIDATION');
      }
      closesAt = d;
    }

    const options = texts.map((text) => ({
      id: newOptionId(),
      text,
      voteCount: 0,
    }));

    const poll = await Poll.create({
      conversation: conversationId,
      creator: userId,
      question,
      options,
      allowMultiple: !!input.allowMultiple,
      isAnonymous: !!input.isAnonymous,
      closesAt,
      votes: [],
    });

    const message = await Message.create({
      conversation: conversationId,
      sender: userId,
      type: 'poll',
      content: question,
      pollId: poll._id,
      deliveredTo: [userId],
      readBy: [{ user: userId, readAt: new Date() }],
    });

    poll.message = message._id as Types.ObjectId;
    await poll.save();

    await Conversation.updateOne(
      { _id: conversationId },
      {
        $set: { lastMessage: message._id, lastMessageAt: message.createdAt },
        $inc: { 'participants.$[others].unreadCount': 1 },
      },
      { arrayFilters: [{ 'others.user': { $ne: new Types.ObjectId(userId) } }] }
    );

    await message.populate('sender', 'username displayName avatar');
    const formatted = formatMessage(message, { viewerId: userId });
    emitMessageNew(conversationId, formatted);

    // Broadcast without viewer-specific myOptionIds (clients refresh for self)
    emitPollUpdated(conversationId, formatPoll(poll));

    return { poll: formatPoll(poll, userId), message: formatted };
  },

  async get(userId: string, pollId: string) {
    if (!isObjectIdString(pollId)) throw new AppError('Invalid poll', 400, 'VALIDATION');
    const poll = await Poll.findById(pollId);
    if (!poll) throw new AppError('Poll not found', 404, 'NOT_FOUND');
    await ensureConversationParticipant(String(poll.conversation), userId);
    if (maybeAutoClose(poll)) await poll.save();
    return formatPoll(poll, userId);
  },

  async vote(userId: string, pollId: string, optionIds: string[]) {
    if (!isObjectIdString(pollId)) throw new AppError('Invalid poll', 400, 'VALIDATION');
    const poll = await Poll.findById(pollId);
    if (!poll) throw new AppError('Poll not found', 404, 'NOT_FOUND');
    await ensureConversationParticipant(String(poll.conversation), userId);

    if (maybeAutoClose(poll)) {
      await poll.save();
      throw new AppError('This poll is closed', 400, 'POLL_CLOSED');
    }
    if (poll.isClosed) {
      throw new AppError('This poll is closed', 400, 'POLL_CLOSED');
    }

    const validIds = new Set(poll.options.map((o) => o.id));
    const chosen = [...new Set((optionIds || []).map(String).filter((id) => validIds.has(id)))];
    if (!chosen.length) {
      throw new AppError('Select at least one option', 400, 'VALIDATION');
    }
    if (!poll.allowMultiple && chosen.length > 1) {
      throw new AppError('This poll allows only one choice', 400, 'VALIDATION');
    }

    // Remove previous vote counts
    const prevIdx = poll.votes.findIndex((v) => String(v.user) === String(userId));
    if (prevIdx >= 0) {
      const prev = poll.votes[prevIdx];
      for (const oid of prev.optionIds || []) {
        const opt = poll.options.find((o) => o.id === oid);
        if (opt && opt.voteCount > 0) opt.voteCount -= 1;
      }
      poll.votes.splice(prevIdx, 1);
    }

    for (const oid of chosen) {
      const opt = poll.options.find((o) => o.id === oid);
      if (opt) opt.voteCount = (opt.voteCount || 0) + 1;
    }
    poll.votes.push({
      user: new Types.ObjectId(userId),
      optionIds: chosen,
      at: new Date(),
    });

    await poll.save();
    emitPollUpdated(String(poll.conversation), formatPoll(poll));
    return formatPoll(poll, userId);
  },

  async close(userId: string, pollId: string) {
    if (!isObjectIdString(pollId)) throw new AppError('Invalid poll', 400, 'VALIDATION');
    const poll = await Poll.findById(pollId);
    if (!poll) throw new AppError('Poll not found', 404, 'NOT_FOUND');
    await ensureConversationParticipant(String(poll.conversation), userId);

    if (String(poll.creator) !== String(userId)) {
      throw new AppError('Only the creator can close this poll', 403, 'FORBIDDEN');
    }
    if (!poll.isClosed) {
      poll.isClosed = true;
      poll.closedAt = new Date();
      await poll.save();
    }
    emitPollUpdated(String(poll.conversation), formatPoll(poll));
    return formatPoll(poll, userId);
  },
};
