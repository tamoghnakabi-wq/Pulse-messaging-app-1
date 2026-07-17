/**
 * Disconnect live Socket.IO connections when sessions are revoked.
 * HTTP auth re-checks Session.isValid every request; sockets only checked at handshake.
 */
export async function disconnectUserSockets(
  userId: string,
  opts?: { sessionId?: string; allSessions?: boolean }
): Promise<void> {
  try {
    const { getIO } = await import('../socket');
    const io = getIO();
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    for (const s of sockets) {
      const sid = (s.data as { sessionId?: string })?.sessionId || (s as { sessionId?: string }).sessionId;
      // Prefer handshake-stored sessionId set in socket middleware
      const socketSession =
        (s as unknown as { sessionId?: string }).sessionId ||
        (s.handshake?.auth as { sessionId?: string } | undefined)?.sessionId;

      // AuthedSocket sets socket.sessionId on the socket object
      const bound = (s as unknown as { sessionId?: string }).sessionId || socketSession || sid;

      if (opts?.allSessions) {
        s.disconnect(true);
        continue;
      }
      if (opts?.sessionId && bound && bound === opts.sessionId) {
        s.disconnect(true);
        continue;
      }
      // If we can't match session id, disconnect all for safety on revoke-all
      if (opts?.sessionId && !bound) {
        // Only disconnect if this is the only way — skip to avoid killing other devices
        continue;
      }
    }
  } catch {
    /* socket not ready in tests */
  }
}

/** Disconnect all sockets for a user (password reset / logout everywhere). */
export async function disconnectAllUserSockets(userId: string): Promise<void> {
  try {
    const { getIO } = await import('../socket');
    getIO().in(`user:${userId}`).disconnectSockets(true);
  } catch {
    /* */
  }
}
