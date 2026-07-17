/**
 * One-shot safe migration: rewrite absolute ngrok/localhost media URLs
 * to relative /uploads/... paths so DPs and attachments survive restarts.
 * Never deletes data.
 */
import mongoose from 'mongoose';
import logger from './logger';
import { toRelativeMediaPath } from './mediaUrl';

export async function migrateMediaUrlsToRelative(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;

  let usersFixed = 0;
  let convsFixed = 0;
  let msgsFixed = 0;
  let attsFixed = 0;

  // Users.avatar
  const users = await db
    .collection('users')
    .find({ avatar: { $regex: /^https?:\/\// } })
    .project({ _id: 1, avatar: 1 })
    .toArray();

  for (const u of users) {
    const next = toRelativeMediaPath(u.avatar as string);
    if (next && next !== u.avatar) {
      await db.collection('users').updateOne({ _id: u._id }, { $set: { avatar: next } });
      usersFixed++;
    }
  }

  // Conversations.avatar
  const convs = await db
    .collection('conversations')
    .find({ avatar: { $regex: /^https?:\/\// } })
    .project({ _id: 1, avatar: 1 })
    .toArray();

  for (const c of convs) {
    const next = toRelativeMediaPath(c.avatar as string);
    if (next && next !== c.avatar) {
      await db.collection('conversations').updateOne({ _id: c._id }, { $set: { avatar: next } });
      convsFixed++;
    }
  }

  // Message attachments[].url
  const msgs = await db
    .collection('messages')
    .find({ 'attachments.url': { $regex: /^https?:\/\// } })
    .project({ _id: 1, attachments: 1 })
    .toArray();

  for (const m of msgs) {
    const attachments = (m.attachments as Array<{ url?: string }>) || [];
    let changed = false;
    const nextAtts = attachments.map((a) => {
      if (a.url && /^https?:\/\//.test(a.url)) {
        const rel = toRelativeMediaPath(a.url);
        if (rel !== a.url) {
          changed = true;
          return { ...a, url: rel };
        }
      }
      return a;
    });
    if (changed) {
      await db.collection('messages').updateOne({ _id: m._id }, { $set: { attachments: nextAtts } });
      msgsFixed++;
    }
  }

  // Attachment collection
  const atts = await db
    .collection('attachments')
    .find({ url: { $regex: /^https?:\/\// } })
    .project({ _id: 1, url: 1 })
    .toArray();

  for (const a of atts) {
    const next = toRelativeMediaPath(a.url as string);
    if (next && next !== a.url) {
      await db.collection('attachments').updateOne({ _id: a._id }, { $set: { url: next } });
      attsFixed++;
    }
  }

  if (usersFixed || convsFixed || msgsFixed || attsFixed) {
    logger.info(
      `Media URL migration: users=${usersFixed} groups=${convsFixed} messages=${msgsFixed} attachments=${attsFixed}`
    );
  }
}
