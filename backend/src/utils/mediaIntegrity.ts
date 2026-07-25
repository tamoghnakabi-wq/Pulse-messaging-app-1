/**
 * Boot-time media integrity check.
 *
 * The database stores media as durable relative paths (`/uploads/images/x.jpg`)
 * while the bytes live wherever UPLOAD_DIR points. Those two can drift apart —
 * most easily by starting the app one way (Docker, UPLOAD_DIR=/app/uploads) and
 * then another (local, UPLOAD_DIR=./uploads) against the same database. The
 * symptom is silent: avatars and attachments simply render blank, and nothing
 * in the logs says why.
 *
 * This samples what the database references and reports how much of it is
 * actually on disk, so a storage mismatch is obvious at startup instead of
 * being mistaken for data loss. Read-only: it never deletes or rewrites.
 */
import fs from 'fs';
import path from 'path';
import config from '../config';
import logger from './logger';

/** Upper bound on refs inspected, so boot stays fast on large datasets. */
const SAMPLE_LIMIT = 300;

function resolveUploadPath(relative: string): string | null {
  const clean = String(relative || '').split('?')[0];
  if (!clean.startsWith('/uploads/')) return null;
  if (clean.includes('..') || clean.includes('\0') || clean.includes('\\')) return null;
  const root = path.resolve(config.uploadDir);
  const target = path.resolve(root, `.${clean.slice('/uploads'.length)}`);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

export async function checkMediaIntegrity(): Promise<{
  checked: number;
  missing: number;
}> {
  const refs: string[] = [];

  try {
    const { User } = await import('../models/User');
    const { Conversation } = await import('../models/Conversation');

    const users = await User.find({
      $or: [{ avatar: { $nin: ['', null] } }, { coverPhoto: { $nin: ['', null] } }],
    })
      .select('avatar coverPhoto')
      .limit(SAMPLE_LIMIT)
      .lean();
    for (const u of users) {
      if (u.avatar) refs.push(u.avatar);
      if (u.coverPhoto) refs.push(u.coverPhoto);
    }

    const convs = await Conversation.find({ avatar: { $nin: ['', null] } })
      .select('avatar')
      .limit(SAMPLE_LIMIT)
      .lean();
    for (const c of convs) if (c.avatar) refs.push(c.avatar);
  } catch (err) {
    logger.debug('Media integrity check skipped', {
      message: err instanceof Error ? err.message : String(err),
    });
    return { checked: 0, missing: 0 };
  }

  let checked = 0;
  let missing = 0;
  const examples: string[] = [];

  for (const ref of refs.slice(0, SAMPLE_LIMIT)) {
    const target = resolveUploadPath(ref);
    if (!target) continue;
    checked += 1;
    if (!fs.existsSync(target)) {
      missing += 1;
      if (examples.length < 3) examples.push(ref);
    }
  }

  if (missing > 0) {
    logger.warn(
      `Media integrity: ${missing}/${checked} referenced file(s) missing from UPLOAD_DIR`,
      {
        uploadDir: config.uploadDir,
        examples,
        hint:
          'The database points at files that are not in this UPLOAD_DIR. This usually means the app was previously run with a different upload location (e.g. a Docker volume vs a local folder). Point UPLOAD_DIR at the original store, or copy the files across — nothing has been deleted.',
      }
    );
  } else if (checked > 0) {
    logger.info(`Media integrity: ${checked} referenced file(s) present`);
  }

  return { checked, missing };
}
