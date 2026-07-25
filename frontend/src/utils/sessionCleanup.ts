/**
 * Full client-side session cleanup — no server data is touched.
 * Used on logout and failed token refresh to avoid leaking chat/call state.
 */
import { setAccessToken } from '../services/api';
import { clearAllAuthTokens } from '../shared/api/tokenStorage';
import { disconnectSocket } from '../services/socket';
import { webrtc } from '../services/webrtc';
import { useChatStore } from '../store/chatStore';
import { useCallStore } from '../store/callStore';
import { clearSessionCaches } from './sessionCache';

export function clearClientSessionState(): void {
  try {
    void webrtc.hangup(false);
  } catch {
    /* */
  }
  try {
    useCallStore.getState().endCall(false);
  } catch {
    /* */
  }

  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    messages: {},
    hasMore: {},
    typing: {},
    sidebarFilter: 'all',
    searchQuery: '',
    replyTo: null,
    editingMessage: null,
    uploadProgress: null,
    onlineUsers: new Set(),
    focusMessageId: null,
  });

  setAccessToken(null);
  clearAllAuthTokens();
  try {
    sessionStorage.removeItem('pulse_active_conversation');
  } catch {
    /* */
  }
  clearSessionCaches();
  // Decrypted attachment blobs are plaintext — they must not survive logout
  void import('../components/chat/E2EMediaAttachment')
    .then(({ clearDecryptedMediaCache }) => clearDecryptedMediaCache())
    .catch(() => undefined);
  // Clear in-memory E2E session keys (per-user device identity stays for re-login)
  void import('../services/e2e')
    .then(({ clearE2ESessionCaches, setE2EUserContext }) => {
      setE2EUserContext(null);
      clearE2ESessionCaches();
    })
    .catch(() => undefined);
  disconnectSocket();
}
