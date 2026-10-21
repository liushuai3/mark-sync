// v3.0 sync API — LWW conflicts, incremental pull with tombstones,
// force overwrite. See docs/SRS-v3.0.md §6, §7, §8.
import { Hono } from 'hono';
import { z } from 'zod';
import { db, now, type Bookmark, type User, type ApiToken } from '../db.js';
import { requireApiToken } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

const app = new Hono();
app.use('*', requireApiToken);

// ─── Constants ────────────────────────────────────────────────────────
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ─── Zod schemas (SRS §8.4 / §8.5) ────────────────────────────────────
const rootEnum = z.enum(['bookmark_bar', 'other', 'mobile']);
const typeEnum = z.enum(['folder', 'url']);

const bookmarkInput = z.object({
  id: z.string().min(1),
  type: typeEnum,
  parent_id: z.string().nullable().optional(),
  root: rootEnum,
  name: z.string(),
  url: z.string().nullable().optional(),
  position: z.number().int().optional(),
  date_added: z.number().nullable().optional(),
  date_modified: z.number().nullable().optional(),
});

const modifiedInput = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().nullable().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
  date_modified: z.number(), // ⭐ required, LWW baseline
});

const removedInput = z.object({
  id: z.string().min(1),
  date_modified: z.number(), // ⭐ required, deletion action time
});

const pushSchema = z.object({
  added: z.array(bookmarkInput).default([]),
  modified: z.array(modifiedInput).default([]),
  removed: z.array(removedInput).default([]),
});

const forceSchema = z.object({
  bookmarks: z.array(bookmarkInput),
});

// ─── Prepared statements ──────────────────────────────────────────────
const selectAllForPull = db.prepare<[number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? ORDER BY server_updated_at'
);
const selectSincePull = db.prepare<[number, number], Bookmark>(
  'SELECT * FROM bookmarks WHERE user_id = ? AND server_updated_at > ? ORDER BY server_updated_at'
);
const findById = db.prepare<[string, number], Bookmark>(
  'SELECT * FROM bookmarks WHERE id = ? AND user_id = ?'
);
// Content-based dedup: find an existing active bookmark with same root/parent/name/url.
// Used on push to prevent duplicate bookmarks from different browsers/devices.
const findDuplicate = db.prepare<
  [number, string, string, string, string],
  Bookmark
>(
  `SELECT * FROM bookmarks
    WHERE user_id = ? AND root = ?
      AND COALESCE(parent_id, '') = ?
      AND name = ? AND COALESCE(url, '') = ?
      AND deleted_at IS NULL
    LIMIT 1`
);
const insertBookmark = db.prepare(
  `INSERT INTO bookmarks
     (id, user_id, type, parent_id, root, name, url, position,
      date_added, date_modified, server_updated_at, deleted_at, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`
);
// Force-push upsert: force semantics = client state wins, including
// reviving rows that softDeleteAllActive just tombstoned. A blind INSERT
// used to throw a PRIMARY KEY conflict whenever the client reused an
// existing cloud id (the normal case for any second force upload) and the
// whole transaction rolled back with a 500.
const upsertBookmark = db.prepare(
  `INSERT INTO bookmarks
     (id, user_id, type, parent_id, root, name, url, position,
      date_added, date_modified, server_updated_at, deleted_at, version, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)
   ON CONFLICT(id) DO UPDATE SET
     type = excluded.type,
     parent_id = excluded.parent_id,
     root = excluded.root,
     name = excluded.name,
     url = excluded.url,
     position = excluded.position,
     date_added = excluded.date_added,
     date_modified = excluded.date_modified,
     server_updated_at = excluded.server_updated_at,
     deleted_at = NULL,
     version = bookmarks.version + 1`
);
// Force push: soft-delete one row by id (used to clear intra-payload
// content duplicates that would otherwise violate idx_bookmarks_dedupe).
const softDeleteByIdInForce = db.prepare(
  `UPDATE bookmarks
      SET deleted_at = ?, date_modified = ?, server_updated_at = ?, version = version + 1
    WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
);
const softDeleteAllActive = db.prepare(
  `UPDATE bookmarks
      SET deleted_at = ?, server_updated_at = ?, version = version + 1
    WHERE user_id = ? AND deleted_at IS NULL`
);
const insertSyncLog = db.prepare(
  `INSERT INTO sync_logs
     (user_id, token_id, action, added_count, removed_count, modified_count,
      device_info, ip, duration_ms, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// ─── Helpers ──────────────────────────────────────────────────────────
type ClientMeta = { ip: string | null; ua: string | null };

function getClientMeta(c: any): ClientMeta {
  const ip =
    c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
    c.req.header('x-real-ip') ||
    null;
  const ua = c.req.header('user-agent') || null;
  return { ip, ua };
}

/**
 * Strip server-only fields from a bookmark before returning to clients.
 * SRS §8.3: clients do not receive `server_updated_at` or internal columns.
 */
function toPullRow(b: Bookmark) {
  return {
    id: b.id,
    type: b.type,
    parent_id: b.parent_id,
    root: b.root,
    name: b.name,
    url: b.url,
    position: b.position,
    date_added: b.date_added,
    date_modified: b.date_modified,
    deleted_at: b.deleted_at,
    version: b.version,
  };
}

type Conflict = {
  id: string;
  reason: 'not_found' | 'already_deleted' | 'newer_exists';
  server_date_modified?: number;
};

// ─── 8.3 GET /api/sync/pull?since=<ms> ────────────────────────────────
app.get('/pull', (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;

  const sinceStr = c.req.query('since');
  const sinceRaw = sinceStr != null ? Number(sinceStr) : null;
  const sinceValid = sinceRaw != null && Number.isFinite(sinceRaw) && sinceRaw >= 0;
  const serverTime = now();

  // Full when since is missing/invalid or older than the tombstone window
  const full = !sinceValid || (sinceRaw as number) < serverTime - TOMBSTONE_RETENTION_MS;

  const rows = full
    ? selectAllForPull.all(user.id)
    : selectSincePull.all(user.id, sinceRaw as number);

  const bookmarks = rows.map(toPullRow);

  const { ip, ua } = getClientMeta(c);
  try {
    insertSyncLog.run(
      user.id,
      token?.id ?? null,
      'pull',
      0,
      0,
      0,
      ua,
      ip,
      Date.now() - start,
      now()
    );
  } catch (err) {
    logger.warn('sync_logs insert failed (pull)', err);
  }

  return c.json({
    ok: true,
    data: {
      bookmarks,
      server_time: serverTime,
      full,
    },
  });
});

// ─── 8.4 POST /api/sync/push ──────────────────────────────────────────
app.post('/push', async (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;

  const body = await c.req.json().catch(() => ({}));
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' },
      400
    );
  }
  const { added, modified, removed } = parsed.data;

  let addedCount = 0;
  let modifiedCount = 0;
  let removedCount = 0;
  const conflicts: Conflict[] = [];
  /** Content-based dedup results returned to client for idMap correction. */
  const deduped: Array<{ requested_id: string; existing_id: string; name: string }> = [];

  const tx = db.transaction(() => {
    const ts = now();

    // ── added ────────────────────────────────────────────────────────
    // Phase A — classify every row BEFORE inserting anything:
    //   conflict / content-dedup / candidate-for-insert.
    // The requested_id → existing_id remap built here is applied to
    // children in the SAME batch. Without it, when a folder row is
    // content-deduped (skipped), its children used to be inserted with
    // a dangling parent_id → orphan rows that other clients resolved to
    // the bookmark-bar root ("bookmarks drift to root" bug).
    const idRemap = new Map<string, string>();
    const resolveParentId = (pid: string | null | undefined): string | null => {
      let cur = pid ?? null;
      for (let i = 0; cur && i < 8; i++) {
        const mapped = idRemap.get(cur);
        if (!mapped) break;
        cur = mapped;
      }
      return cur;
    };

    type PendingAdd = (typeof added)[number] & { finalParent: string | null };
    const candidates: PendingAdd[] = [];
    for (const b of added) {
      // SRS §8.4: id 已存在（含墓碑）→ conflicts newer_exists
      const existing = findById.get(b.id, user.id);
      if (existing) {
        conflicts.push({ id: b.id, reason: 'newer_exists' });
        continue;
      }

      // Content-based dedup: check if an active bookmark with same
      // (root, parent_id, name, url) already exists. This prevents
      // duplicates when two browsers/devices push the same bookmark
      // under different client-generated UUIDs. parent_id is checked
      // AFTER remapping so dedup works even when the parent itself was
      // just deduped to a different id.
      const finalParent = resolveParentId(b.parent_id);
      const dup = findDuplicate.get(
        user.id,
        b.root,
        finalParent ?? '',
        b.name,
        b.url ?? ''
      );
      if (dup) {
        deduped.push({
          requested_id: b.id,
          existing_id: dup.id,
          name: b.name,
        });
        idRemap.set(b.id, dup.id);
        continue;
      }
      candidates.push({ ...b, finalParent });
    }

    // Phase B — insert parent-first. A row whose parent is in this batch
    // waits for it; a row whose parent cannot be found anywhere falls back
    // to top-level (null) instead of dangling.
    const pendingIds = new Set(candidates.map((c) => c.id));
    const insertOne = (b: PendingAdd) => {
      // Re-check content dedup with the final parent: parent remapping in
      // phase B may have changed the dedup key (and guards the partial
      // unique index from ever throwing inside the transaction).
      const dupNow = findDuplicate.get(
        user.id,
        b.root,
        b.finalParent ?? '',
        b.name,
        b.url ?? ''
      );
      if (dupNow && dupNow.id !== b.id) {
        deduped.push({ requested_id: b.id, existing_id: dupNow.id, name: b.name });
        idRemap.set(b.id, dupNow.id);
        return;
      }
      insertBookmark.run(
        b.id,
        user.id,
        b.type,
        b.finalParent,
        b.root,
        b.name,
        b.url ?? null,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? ts,
        ts, // server_updated_at
        ts  // created_at
      );
      addedCount++;
    };

    let remaining = candidates;
    let guard = candidates.length + 8;
    while (remaining.length && guard-- > 0) {
      const next: PendingAdd[] = [];
      let progress = false;
      for (const b of remaining) {
        // Refresh parent through any dedup decisions made since phase A.
        b.finalParent = resolveParentId(b.finalParent);
        if (b.finalParent == null) {
          insertOne(b);
          progress = true;
          continue;
        }
        const parentRow = findById.get(b.finalParent, user.id);
        if (parentRow && parentRow.deleted_at == null) {
          insertOne(b);
          progress = true;
        } else if (parentRow) {
          // Parent is a tombstone → attach to top-level, never dangle.
          b.finalParent = null;
          insertOne(b);
          progress = true;
        } else if (pendingIds.has(b.finalParent)) {
          next.push(b); // parent is in this batch, wait for it
        } else {
          // Parent unknown anywhere → top-level, never dangle.
          b.finalParent = null;
          insertOne(b);
          progress = true;
        }
      }
      remaining = next;
      if (!progress) break;
    }
    // Cycles / stragglers: still insert (top-level) so no row is dropped.
    for (const b of remaining) {
      b.finalParent = null;
      insertOne(b);
    }

    // ── modified (LWW, SRS §7.2) ─────────────────────────────────────
    for (const m of modified) {
      const dbRow = findById.get(m.id, user.id);
      if (!dbRow) {
        conflicts.push({ id: m.id, reason: 'not_found' });
        continue;
      }
      if (dbRow.deleted_at != null) {
        // 删除赢
        conflicts.push({ id: m.id, reason: 'already_deleted' });
        continue;
      }
      // P1-7: LWW is decided by SERVER arrival order, not client clocks.
      // The old `m.date_modified < dbDm` check compared clocks across
      // devices (and against web-admin edits that were already
      // server-stamped) — a device with a fast clock always won and web
      // edits could be overwritten by stale extension pushes. The server
      // now stamps `date_modified` itself on every accepted write; the
      // client-supplied value is kept only for diagnostics upstream.

      // Build partial update: only fields present in payload change.
      const nextName = m.name !== undefined ? m.name : dbRow.name;
      const nextUrl =
        m.url !== undefined ? m.url : dbRow.url;
      const nextParent =
        m.parent_id !== undefined ? m.parent_id : dbRow.parent_id;
      const nextPos =
        m.position !== undefined ? m.position : dbRow.position;

      db.prepare(
        `UPDATE bookmarks
            SET name = ?, url = ?, parent_id = ?, position = ?,
                date_modified = ?, server_updated_at = ?,
                version = version + 1
          WHERE id = ? AND user_id = ?`
      ).run(
        nextName,
        nextUrl,
        nextParent,
        nextPos,
        ts, // P1-7: server-arrival stamp
        ts,
        m.id,
        user.id
      );
      modifiedCount++;
    }

    // ── removed (SRS §7.2, 删除赢, 幂等) ─────────────────────────────
    for (const r of removed) {
      const dbRow = findById.get(r.id, user.id);
      if (!dbRow) continue; // 静默忽略（幂等）
      if (dbRow.deleted_at != null) continue; // 已墓碑
      db.prepare(
        `UPDATE bookmarks
            SET deleted_at = ?, date_modified = ?,
                server_updated_at = ?, version = version + 1
          WHERE id = ? AND user_id = ?`
        // P1-7: server-arrival stamp, same rationale as `modified`.
      ).run(ts, ts, ts, r.id, user.id);
      removedCount++;
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('push transaction failed', err);
    return c.json(
      { ok: false, error: 'Transaction failed', code: 'SERVER_ERROR' },
      500
    );
  }

  const serverTime = now();
  const { ip, ua } = getClientMeta(c);
  try {
    insertSyncLog.run(
      user.id,
      token?.id ?? null,
      'push',
      addedCount,
      removedCount,
      modifiedCount,
      ua,
      ip,
      Date.now() - start,
      serverTime
    );
  } catch (err) {
    logger.warn('sync_logs insert failed (push)', err);
    // eslint-disable-next-line no-console
    console.log(
      `[sync] push user=${user.id} added=${addedCount} modified=${modifiedCount} removed=${removedCount} conflicts=${conflicts.length}`
    );
  }

  return c.json({
    ok: true,
    data: {
      added_count: addedCount,
      modified_count: modifiedCount,
      removed_count: removedCount,
      deduped: deduped.length > 0 ? deduped : undefined,
      conflicts,
      server_time: serverTime,
    },
  });
});

// ─── 8.5 POST /api/sync/force ─────────────────────────────────────────
app.post('/force', async (c) => {
  const start = Date.now();
  const user = c.get('user' as never) as User;
  const token = c.get('token' as never) as ApiToken | undefined;

  const body = await c.req.json().catch(() => ({}));
  const parsed = forceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { ok: false, error: parsed.error.issues[0].message, code: 'INVALID_INPUT' },
      400
    );
  }
  const { bookmarks } = parsed.data;

  let total = 0;
  const tx = db.transaction(() => {
    const ts = now();
    // Soft-delete every active row for this user
    softDeleteAllActive.run(ts, ts, user.id);
    // Upsert with client-supplied ids (client state wins).
    // forceRemap: dup-id → survivor-id, so children of an intra-payload
    // content-deduped folder reattach to the surviving row instead of
    // dangling.
    const forceRemap = new Map<string, string>();
    for (const b of bookmarks) {
      // Parent guard: never attach to a tombstoned/unknown parent.
      let parentId = b.parent_id ?? null;
      for (let i = 0; parentId && i < 8; i++) {
        const mapped = forceRemap.get(parentId);
        if (!mapped) break;
        parentId = mapped;
      }
      if (parentId) {
        const parentRow = findById.get(parentId, user.id);
        if (!parentRow || parentRow.deleted_at != null) parentId = null;
      }
      // Intra-payload content duplicates (different ids, same content)
      // would violate idx_bookmarks_dedupe → last one wins, others become
      // tombstones. Keeps the force transaction from rolling back.
      const dup = findDuplicate.get(user.id, b.root, parentId ?? '', b.name, b.url ?? '');
      if (dup && dup.id !== b.id) {
        softDeleteByIdInForce.run(ts, ts, ts, dup.id, user.id);
        forceRemap.set(dup.id, b.id);
      }
      upsertBookmark.run(
        b.id,
        user.id,
        b.type,
        parentId,
        b.root,
        b.name,
        b.url ?? null,
        b.position ?? 0,
        b.date_added ?? ts,
        b.date_modified ?? ts,
        ts,
        ts
      );
      total++;
    }
  });

  try {
    tx();
  } catch (err) {
    logger.error('force transaction failed', err);
    return c.json(
      { ok: false, error: 'Transaction failed', code: 'SERVER_ERROR' },
      500
    );
  }

  const serverTime = now();
  const { ip, ua } = getClientMeta(c);
  try {
    insertSyncLog.run(
      user.id,
      token?.id ?? null,
      'force_push',
      total,
      0,
      0,
      ua,
      ip,
      Date.now() - start,
      serverTime
    );
  } catch (err) {
    logger.warn('sync_logs insert failed (force)', err);
  }

  return c.json({
    ok: true,
    data: { total, server_time: serverTime },
  });
});

export default app;
