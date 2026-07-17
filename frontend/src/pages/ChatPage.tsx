import { lazy, Suspense, useEffect } from 'react';
import { useUIStore } from '../store/uiStore';
import { useChatStore } from '../store/chatStore';
import { useCallStore } from '../store/callStore';
import { Sidebar } from '../components/chat/Sidebar';
import { ChatWindow } from '../components/chat/ChatWindow';
import { useSocketEvents } from '../hooks/useSocketEvents';
import { cn } from '../utils/cn';

// Modals + call UI stay out of the critical chat path
const NewChatModal = lazy(() =>
  import('../components/chat/NewChatModal').then((m) => ({ default: m.NewChatModal }))
);
const NewGroupModal = lazy(() =>
  import('../components/chat/NewGroupModal').then((m) => ({ default: m.NewGroupModal }))
);
const SettingsModal = lazy(() =>
  import('../components/settings/SettingsModal').then((m) => ({ default: m.SettingsModal }))
);
const CallOverlay = lazy(() =>
  import('../components/call/CallOverlay').then((m) => ({ default: m.CallOverlay }))
);

function LazyModals() {
  const showNewChat = useUIStore((s) => s.showNewChat);
  const showNewGroup = useUIStore((s) => s.showNewGroup);
  const showSettings = useUIStore((s) => s.showSettings);

  if (!showNewChat && !showNewGroup && !showSettings) return null;

  return (
    <Suspense fallback={null}>
      {showNewChat ? <NewChatModal /> : null}
      {showNewGroup ? <NewGroupModal /> : null}
      {showSettings ? <SettingsModal /> : null}
    </Suspense>
  );
}

/** Call UI only mounts while a call is live (keeps idle chat lighter). */
function LazyCallOverlay() {
  const active = useCallStore((s) => s.active);
  if (!active) return null;
  return (
    <Suspense fallback={null}>
      <CallOverlay />
    </Suspense>
  );
}

export function ChatPage() {
  useSocketEvents();
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const showMobileSidebar = useUIStore((s) => s.showMobileSidebar);
  const setShowMobileSidebar = useUIStore((s) => s.setShowMobileSidebar);

  // One-shot: if we restored an open chat after Safari cold-start, hide the list once
  useEffect(() => {
    try {
      const restored = sessionStorage.getItem('pulse_active_conversation');
      if (restored && useChatStore.getState().activeConversationId === restored) {
        setShowMobileSidebar(false);
      }
    } catch {
      /* */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only restore
  }, []);

  const showChat = Boolean(activeConversationId);
  // Mobile: either sidebar OR chat. Desktop: both side-by-side.
  const showSidebar = !showChat || showMobileSidebar;

  return (
    <div className="app-shell flex h-full min-h-0 w-full flex-1 overflow-hidden">
      <div
        className={cn(
          'h-full min-h-0 shrink-0',
          // Avoid display:none thrash — keep off-screen with absolute + visibility on mobile
          showSidebar ? 'relative flex w-full md:w-auto' : 'hidden',
          'md:relative md:flex'
        )}
      >
        <Sidebar />
      </div>
      <div
        className={cn(
          'chat-pane h-full min-h-0 min-w-0 flex-1 flex-col',
          // No page-enter on mobile — slide animation re-fires every open and looks like glitching
          showChat ? 'flex' : 'hidden md:flex'
        )}
      >
        <ChatWindow />
      </div>
      <LazyModals />
      <LazyCallOverlay />
    </div>
  );
}
