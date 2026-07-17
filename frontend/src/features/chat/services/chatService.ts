/**
 * Compatibility facade over domain services.
 * Prefer importing conversationService / messageService / userService directly in new code.
 */
import { conversationService } from './conversationService';
import { messageService } from './messageService';
import { userService } from './userService';
import { notificationService } from './notificationService';
import { uploadService } from './uploadService';

export const chatService = {
  getConversations: conversationService.list,
  getConversation: conversationService.getById,
  createDirect: conversationService.createDirect,
  createGroup: conversationService.createGroup,
  updateGroup: conversationService.updateGroup,
  updatePrefs: conversationService.updatePrefs,
  markRead: conversationService.markRead,
  deleteGroup: conversationService.deleteGroup,
  deleteConversationForMe: conversationService.deleteForMe,
  addParticipants: conversationService.addParticipants,
  removeParticipant: conversationService.removeParticipant,

  getMessages: messageService.listByConversation,
  sendMessage: messageService.send,
  editMessage: messageService.edit,
  deleteForMe: messageService.deleteForMe,
  deleteForEveryone: messageService.deleteForEveryone,
  openViewOnce: messageService.openViewOnce,
  react: messageService.react,
  forward: messageService.forward,
  pin: messageService.pin,
  star: messageService.star,
  searchMessages: messageService.search,
  getPinnedMessages: messageService.listPinned,

  searchUsers: userService.search,
  getUser: userService.getById,
  updateProfile: userService.updateProfile,
  updateSettings: userService.updateSettings,
  uploadAvatar: userService.uploadAvatar,
  uploadCoverPhoto: userService.uploadCoverPhoto,
  removeCoverPhoto: userService.removeCoverPhoto,
  changePassword: userService.changePassword,
  getStarred: userService.listStarredMessages,
  listBlocked: userService.listBlocked,
  blockUser: userService.blockUser,
  unblockUser: userService.unblockUser,
  reportUser: userService.reportUser,

  uploadFiles: uploadService.uploadFiles,

  getNotifications: notificationService.list,
  markNotificationRead: notificationService.markRead,
  markAllNotificationsRead: notificationService.markAllRead,
};

export {
  conversationService,
  messageService,
  userService,
  notificationService,
  uploadService,
};
