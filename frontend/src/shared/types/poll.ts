/** Chat poll — server-authoritative (not E2E) */

export interface PollOption {
  id: string;
  text: string;
  voteCount: number;
  /** Present when poll is not anonymous */
  voterIds?: string[];
}

export interface PulsePoll {
  id: string;
  conversation: string;
  creator: string;
  messageId?: string;
  question: string;
  options: PollOption[];
  allowMultiple: boolean;
  isAnonymous: boolean;
  isClosed: boolean;
  closedAt?: string;
  closesAt?: string;
  totalVotes: number;
  myOptionIds: string[];
  createdAt: string;
}

export interface CreatePollInput {
  conversationId: string;
  question: string;
  options: string[];
  allowMultiple?: boolean;
  isAnonymous?: boolean;
  closesAt?: string | null;
}
