#!/usr/bin/env node
/**
 * Orphaned media reaper.
 *
 * Every abandoned upload — a file picked then not sent, a failed send, a
 * replaced group avatar — leaves bytes under UPLOAD_DIR that nothing in the
 * database references. Nothing ever reclaims them, so the directory only grows.
 *
 * Safety first, because the failure mode here is deleting someone's photos:
 *   - reports only, unless you pass --apply
 *   - never touches a file newer than the grace window (default 24h), so an
 *     in-flight upload that has not been attached to a message yet is safe
 *   - resolves every candidate inside UPLOAD_DIR and skips anything that
 *     escapes it
 *   - builds the full reference set BEFORE considering any deletion
 *
 * Usage:
 *   node scripts/media-gc.mjs                 # dry run (default)
 *   node scripts/media-gc.mjs --apply         # actually delete
 *   node scripts/media-gc.mjs --grace-hours=72
 */
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
dotenv.config({ path: path.join(repoRoot, 'backend', '.env') });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const graceArg = args.find((a) => a.startsWith('--grace-hours='));
const GRACE_HOURS = graceArg ? Number(graceArg.split('=')[1]) : 24;

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/pulse';
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR || path.join(repoRoot, 'uploads')
);

if (!Number.isFinite(GRACE_HOURS) || GRACE_HOURS < 0) {
  console.error('--grace-hours must be a non-negative number');
  process.exit(1);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name !== '.gitkeep') out.push(full);
  }
  return out;
}

/** Normalise any stored value to a path relative to the upload root. */
function toRelative(stored) {
  if (!stored || typeof stored !== 'string') return null;
  const clean = stored.split('?')[0].trim();
  const idx = clean.indexOf('/uploads/');
  const rel = idx >= 0 ? clean.slice(idx + '/uploads/'.length) : null;
  if (!rel || rel.includes('..') || rel.includes('\0')) return null;
  return rel;
}

const run = async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const db = client.db();

  const referenced = new Set();
  const add = (v) => {
    const rel = toRelative(v);
    if (rel) referenced.add(rel);
  };

  for (const u of await db
    .collection('users')
    .find({}, { projection: { avatar: 1, coverPhoto: 1 } })
    .toArray()) {
    add(u.avatar);
    add(u.coverPhoto);
  }
  for (const c of await db
    .collection('conversations')
    .find({}, { projection: { avatar: 1 } })
    .toArray()) {
    add(c.avatar);
  }
  for (const m of await db
    .collection('messages')
    .find({ 'attachments.0': { $exists: true } }, { projection: { attachments: 1 } })
    .toArray()) {
    for (const a of m.attachments || []) {
      add(a.url);
      add(a.thumbnailUrl);
    }
  }
  // Attachment rows can exist before a message is sent — treat them as live
  // references so a legitimate in-progress upload is never reaped.
  for (const a of await db
    .collection('attachments')
    .find({}, { projection: { url: 1, thumbnailUrl: 1 } })
    .toArray()) {
    add(a.url);
    add(a.thumbnailUrl);
  }

  const onDisk = walk(UPLOAD_DIR);
  const cutoff = Date.now() - GRACE_HOURS * 3600_000;

  const orphans = [];
  let protectedByGrace = 0;
  let bytes = 0;

  for (const abs of onDisk) {
    const rel = path.relative(UPLOAD_DIR, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // escaped the root
    if (referenced.has(rel)) continue;

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      protectedByGrace += 1;
      continue;
    }
    orphans.push({ abs, rel, size: stat.size });
    bytes += stat.size;
  }

  console.log(`upload dir     : ${UPLOAD_DIR}`);
  console.log(`database       : ${MONGODB_URI.replace(/\/\/.*@/, '//***@')}`);
  console.log(`files on disk  : ${onDisk.length}`);
  console.log(`referenced     : ${referenced.size}`);
  console.log(`within grace   : ${protectedByGrace} (younger than ${GRACE_HOURS}h — kept)`);
  console.log(`orphaned       : ${orphans.length} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);

  // Attachment rows whose message was never sent AND whose file is already gone
  const staleRows = await db
    .collection('attachments')
    .find({ createdAt: { $lt: new Date(cutoff) } }, { projection: { url: 1 } })
    .toArray();
  const deadRows = staleRows.filter((a) => {
    const rel = toRelative(a.url);
    return rel && !fs.existsSync(path.join(UPLOAD_DIR, rel));
  });
  console.log(`dead attachment rows (file already gone): ${deadRows.length}`);

  if (!orphans.length && !deadRows.length) {
    console.log('\nNothing to reclaim.');
    await client.close();
    return;
  }

  for (const o of orphans.slice(0, 15)) {
    console.log(`  ${APPLY ? 'delete' : 'would delete'}  ${o.rel}  (${(o.size / 1024).toFixed(0)} KB)`);
  }
  if (orphans.length > 15) console.log(`  … and ${orphans.length - 15} more`);

  if (!APPLY) {
    console.log('\nDry run — nothing was changed. Re-run with --apply to reclaim.');
    await client.close();
    return;
  }

  let deleted = 0;
  for (const o of orphans) {
    try {
      fs.unlinkSync(o.abs);
      deleted += 1;
    } catch (err) {
      console.warn(`  failed: ${o.rel} — ${err.message}`);
    }
  }
  let rowsRemoved = 0;
  if (deadRows.length) {
    const res = await db
      .collection('attachments')
      .deleteMany({ _id: { $in: deadRows.map((r) => r._id) } });
    rowsRemoved = res.deletedCount;
  }

  console.log(
    `\nReclaimed ${deleted} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB; removed ${rowsRemoved} dead attachment row(s).`
  );
  await client.close();
};

run().catch((err) => {
  console.error('media-gc failed:', err.message);
  process.exit(1);
});
