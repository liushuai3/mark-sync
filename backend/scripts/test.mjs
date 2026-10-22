#!/usr/bin/env node
// v3.0 Integration test for MarkSync backend
// Covers: auth/user/token CRUD (retained from v2)
//        + full v3.0 sync suite (LWW, tombstones, force, incremental, expired since)
//
// The suite is self-contained: it starts a fresh backend against a temp DB
// so results are deterministic regardless of any pre-existing data.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(__dirname, '..');
const PORT = process.env.TEST_PORT || 3939;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

async function req(method, path, opts = {}) {
  const { token, body } = opts;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE, // CSRF middleware exempts same-origin
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response (rare)
  }
  return { status: res.status, json };
}

function assert(cond, msg) {
  if (cond) {
    console.log('  ✅', msg);
    passed++;
  } else {
    console.log('  ❌', msg);
    failed++;
  }
}

function section(name) {
  console.log('\n── ' + name + ' ──');
}

async function waitForServer(base, tries = 150) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  console.log('--- MarkSync v3.0 backend integration test ---');
  const tmp = mkdtempSync(join(tmpdir(), 'marksync-test-'));
  const dbPath = join(tmp, 'test.db');
  console.log('  temp DB:', dbPath);

  // Spawn via `node --import tsx` directly rather than the `.bin/tsx`
  // shim: the shim re-execs node in a way that trips a native teardown
  // assertion (node 24 + better-sqlite3) when the parent is a node process,
  // crashing the server before it binds the port.
  const server = spawn(
    process.execPath,
    ['--import', 'tsx', join(backendRoot, 'src/index.ts')],
    {
      cwd: backendRoot,
      env: {
        ...process.env,
        DB_PATH: dbPath,
        PORT: String(PORT),
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d.toString()));
  server.stderr.on('data', (d) => (serverLog += d.toString()));

  const cleanup = () => {
    try {
      server.kill('SIGKILL');
    } catch {}
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });

  const ready = await waitForServer(BASE);
  if (!ready) {
    console.error('Server did not start');
    console.error(serverLog);
    cleanup();
    process.exit(2);
  }

  try {
    // ═════════════════════════════════════════════════════════════════
    // Auth / user / token — retained from v2 (still valid in v3.0)
    // ═════════════════════════════════════════════════════════════════
    section('Auth & tokens (v2-carryover)');

    const health = await req('GET', '/health');
    assert(health.status === 200 && health.json.ok, 'health check');

    const status0 = await req('GET', '/api/auth/status');
    assert(status0.status === 200 && status0.json.data.can_register, 'auth status (fresh DB → can register)');

    const username = 'testuser_' + Date.now();
    const password = 'test123456';
    const reg = await req('POST', '/api/auth/register', {
      body: { username, password, email: `${username}@test.com` },
    });
    if (reg.status !== 200) {
      console.error('register response:', reg.status, JSON.stringify(reg.json));
    }
    assert(reg.status === 200 && reg.json.ok, 'register first user');
    const jwt = reg.json.data.token;
    const userId = reg.json.data.user.id;

    const me = await req('GET', '/api/auth/me', { token: jwt });
    assert(me.status === 200 && me.json.data.username === username, '/auth/me returns user');

    const reg2 = await req('POST', '/api/auth/register', {
      body: { username: 'another', password: 'test1234' },
    });
    assert(reg2.status === 403 && reg2.json.code === 'REG_CLOSED', 'second registration blocked');

    const login = await req('POST', '/api/auth/login', {
      body: { username, password },
    });
    assert(login.status === 200 && login.json.ok, 'login with correct password');

    const badLogin = await req('POST', '/api/auth/login', {
      body: { username, password: 'wrong' },
    });
    assert(badLogin.status === 401, 'login with wrong password fails');

    const tokenRes = await req('POST', '/api/tokens', {
      token: jwt,
      body: { name: 'test-device' },
    });
    assert(
      tokenRes.status === 200 && tokenRes.json.data.token.startsWith('mks_'),
      'create API token'
    );
    const apiToken = tokenRes.json.data.token;
    const tokenId = tokenRes.json.data.id;

    const tokenList = await req('GET', '/api/tokens', { token: jwt });
    assert(tokenList.json.data.length === 1, 'list tokens returns 1');
    assert(!('token' in tokenList.json.data[0]), 'list does not leak plaintext token');

    const noAuth = await req('GET', '/api/auth/me');
    assert(noAuth.status === 401, 'unauthorized without token');

    const wrongToken = await req('GET', '/api/sync/pull', {
      token: 'mks_' + 'x'.repeat(32),
    });
    assert(wrongToken.status === 401, 'invalid API token rejected');

    // ═════════════════════════════════════════════════════════════════
    // Sync v3.0 — full coverage of SRS §7, §8.3, §8.4, §8.5
    // ═════════════════════════════════════════════════════════════════
    section('sync/pull — without since → full + tombstone');

    // Seed: two bookmarks
    const now0 = Date.now();
    const b1 = {
      id: 'uuid-folder-1',
      type: 'folder',
      parent_id: null,
      root: 'bookmark_bar',
      name: '工作',
      url: null,
      position: 0,
      date_added: now0,
      date_modified: now0,
    };
    const b2 = {
      id: 'uuid-url-1',
      type: 'url',
      parent_id: 'uuid-folder-1',
      root: 'bookmark_bar',
      name: 'Vue',
      url: 'https://vuejs.org',
      position: 0,
      date_added: now0,
      date_modified: now0,
    };
    const seed = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [b1, b2], modified: [], removed: [] },
    });
    assert(seed.json.data.added_count === 2, 'seed: 2 new bookmarks written');

    // Delete one to produce a tombstone
    const rm = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [], modified: [], removed: [{ id: 'uuid-url-1', date_modified: Date.now() }] },
    });
    assert(rm.json.data.removed_count === 1, 'seed: soft-delete uuid-url-1');

    // Pull without since → full=true, tombstone included
    const pullFull = await req('GET', '/api/sync/pull', { token: apiToken });
    assert(pullFull.status === 200, 'pull without since returns 200');
    assert(pullFull.json.data.full === true, 'pull without since: full=true');
    assert(pullFull.json.data.bookmarks.length === 2, 'pull without since: returns 2 rows (active + tombstone)');
    const tomb = pullFull.json.data.bookmarks.find((b) => b.id === 'uuid-url-1');
    assert(tomb && tomb.deleted_at != null, 'pull without since: tombstone has deleted_at');
    assert(typeof pullFull.json.data.server_time === 'number', 'pull returns server_time');

    section('sync/pull — with since → incremental');
    // Take snapshot of server_time, then add another bookmark
    const t1 = pullFull.json.data.server_time;
    await new Promise((r) => setTimeout(r, 10));
    const b3 = {
      id: 'uuid-url-2',
      type: 'url',
      parent_id: null,
      root: 'other',
      name: 'GitHub',
      url: 'https://github.com',
      position: 0,
      date_added: Date.now(),
      date_modified: Date.now(),
    };
    const seedB3 = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [b3], modified: [], removed: [] },
    });
    assert(seedB3.json.data.added_count === 1, 'add b3');

    const pullSince = await req('GET', `/api/sync/pull?since=${t1}`, { token: apiToken });
    assert(pullSince.json.data.full === false, 'pull with valid since: full=false');
    assert(
      pullSince.json.data.bookmarks.length === 1 &&
        pullSince.json.data.bookmarks[0].id === 'uuid-url-2',
      'pull with since returns only the newer row'
    );

    section('sync/pull — expired since → full');
    const expiredSince = Date.now() - 40 * 24 * 60 * 60 * 1000; // 40 days ago
    const pullExpired = await req('GET', `/api/sync/pull?since=${expiredSince}`, {
      token: apiToken,
    });
    assert(pullExpired.json.data.full === true, 'pull with since < now-30d: full=true');
    assert(pullExpired.json.data.bookmarks.length === 3, 'pull expired since returns all 3 rows');

    section('sync/push — added new / added existing id');
    const b4 = {
      id: 'uuid-url-3',
      type: 'url',
      parent_id: null,
      root: 'bookmark_bar',
      name: 'Node',
      url: 'https://nodejs.org',
      position: 0,
      date_added: Date.now(),
      date_modified: Date.now(),
    };
    const pushNew = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [b4], modified: [], removed: [] },
    });
    assert(pushNew.json.data.added_count === 1, 'push added new → written');

    const pushDup = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [b4], modified: [], removed: [] },
    });
    assert(pushDup.json.data.added_count === 0, 'push added existing id → not added');
    assert(
      pushDup.json.data.conflicts.length === 1 &&
        pushDup.json.data.conflicts[0].reason === 'newer_exists',
      'push added existing id → conflicts newer_exists'
    );

    section('sync/push — modified newer / older / against tombstone');
    // First read current server date_modified for b4
    const pullNow = await req('GET', '/api/sync/pull', { token: apiToken });
    const b4Row = pullNow.json.data.bookmarks.find((b) => b.id === 'uuid-url-3');
    const b4Dm = b4Row.date_modified;

    const modNewer = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [{ id: 'uuid-url-3', name: 'Node.js', date_modified: b4Dm + 1000 }],
        removed: [],
      },
    });
    assert(modNewer.json.data.modified_count === 1, 'modify newer date_modified → updated');
    assert(
      modNewer.json.data.conflicts.length === 0,
      'modify newer → no conflicts'
    );

    // Verify version bumped
    const pullVer = await req('GET', '/api/sync/pull', { token: apiToken });
    const b4After = pullVer.json.data.bookmarks.find((b) => b.id === 'uuid-url-3');
    assert(b4After.version >= 2, 'modify: version incremented (>=2)');
    assert(b4After.name === 'Node.js', 'modify: name applied');

    // P1-7: LWW is now server-arrival order — an "older" client timestamp
    // is accepted because client clocks are no longer trusted.
    const modOlder = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [
          { id: 'uuid-url-3', name: 'STALE', date_modified: b4Dm - 10000 },
        ],
        removed: [],
      },
    });
    assert(
      modOlder.json.data.modified_count === 1,
      'modify with older client timestamp → accepted (server-arrival LWW)'
    );
    assert(modOlder.json.data.conflicts.length === 0, 'modify older client ts → no conflicts');

    // Server stamps date_modified itself; the new stamp must be >= the
    // stamp of the previous accepted write.
    const pullStamp = await req('GET', '/api/sync/pull', { token: apiToken });
    const stamped = pullStamp.json.data.bookmarks.find((b) => b.id === 'uuid-url-3');
    assert(
      stamped && stamped.name === 'STALE' && stamped.date_modified >= b4After.date_modified,
      `modify: server-stamped date_modified >= previous (${stamped && stamped.date_modified} vs ${b4After.date_modified})`
    );

    // Modify against a tombstone
    const modTomb = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [
          { id: 'uuid-url-1', name: 'zombie', date_modified: Date.now() + 100000 },
        ],
        removed: [],
      },
    });
    assert(modTomb.json.data.modified_count === 0, 'modify against tombstone → rejected');
    assert(
      modTomb.json.data.conflicts.length === 1 &&
        modTomb.json.data.conflicts[0].reason === 'already_deleted',
      'modify against tombstone → conflicts already_deleted'
    );

    section('sync/push — modified missing id');
    const modMissing = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [{ id: 'ghost-id', name: 'x', date_modified: Date.now() }],
        removed: [],
      },
    });
    assert(
      modMissing.json.data.conflicts.length === 1 &&
        modMissing.json.data.conflicts[0].reason === 'not_found',
      'modify missing id → conflicts not_found'
    );

    section('sync/push — removed active / missing / already deleted (idempotent)');
    const rmActive = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [],
        removed: [{ id: 'uuid-url-2', date_modified: Date.now() }],
      },
    });
    assert(rmActive.json.data.removed_count === 1, 'remove active row → 1 removed');

    const rmMissing = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [],
        removed: [{ id: 'ghost-id-2', date_modified: Date.now() }],
      },
    });
    assert(rmMissing.json.data.removed_count === 0, 'remove missing id → 0, no error');
    assert(
      rmMissing.json.data.conflicts.length === 0,
      'remove missing id → no conflict (idempotent silent)'
    );

    const rmDup = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: {
        added: [],
        modified: [],
        removed: [{ id: 'uuid-url-2', date_modified: Date.now() }],
      },
    });
    assert(rmDup.json.data.removed_count === 0, 'remove already-deleted → 0, no error');
    assert(rmDup.json.data.conflicts.length === 0, 'remove already-deleted → idempotent silent');

    section('sync/force — full overwrite');
    const forceRes = await req('POST', '/api/sync/force', {
      token: apiToken,
      body: {
        bookmarks: [
          {
            id: 'uuid-forced-1',
            type: 'url',
            parent_id: null,
            root: 'bookmark_bar',
            name: 'ForcedOnly',
            url: 'https://example.com',
            position: 0,
            date_added: Date.now(),
            date_modified: Date.now(),
          },
        ],
      },
    });
    assert(forceRes.json.data.total === 1, 'force push: 1 total inserted');

    const pullPostForce = await req('GET', '/api/sync/pull', { token: apiToken });
    const active = pullPostForce.json.data.bookmarks.filter((b) => b.deleted_at == null);
    assert(active.length === 1 && active[0].id === 'uuid-forced-1', 'force push: only forced row active');
    // Every pre-force row is now a tombstone
    const tombs = pullPostForce.json.data.bookmarks.filter((b) => b.deleted_at != null);
    assert(tombs.length >= 3, `force push: prior rows became tombstones (${tombs.length})`);

    // ═════════════════════════════════════════════════════════════════
    // Stats / logs / bookmarks list — retained from v2
    // ═════════════════════════════════════════════════════════════════
    section('Stats & sync logs');
    const stats = await req('GET', '/api/stats', { token: jwt });
    assert(stats.status === 200 && stats.json.ok, 'stats endpoint responds');
    assert(stats.json.data.total_tokens === 1, 'stats: 1 api token');

    const logs = await req('GET', '/api/sync-logs', { token: jwt });
    assert(logs.status === 200 && logs.json.data.total >= 5, 'sync-logs: at least 5 events logged');

    section('Bookmarks list & tree (JWT admin views)');
    const bmList = await req('GET', '/api/bookmarks', { token: jwt });
    assert(bmList.status === 200 && bmList.json.data.total === 1, 'bookmarks list (active): 1');
    const bmTree = await req('GET', '/api/bookmarks/tree', { token: jwt });
    assert(bmTree.status === 200, 'bookmarks tree responds');
    assert(
      bmTree.json.data.bookmark_bar.children.length === 1,
      'tree: bookmark_bar has 1 child'
    );

    section('sync/push — folder content-dedup re-parents children (P0-2 regression)');
    // Device A seeds a folder + child.
    const nowD = Date.now();
    const df1 = {
      id: 'uuid-df-1', type: 'folder', parent_id: null, root: 'other',
      name: 'DedupFolder', url: null, position: 0, date_added: nowD, date_modified: nowD,
    };
    const dc1 = {
      id: 'uuid-dc-1', type: 'url', parent_id: 'uuid-df-1', root: 'other',
      name: 'ChildOne', url: 'https://example.com/one', position: 0, date_added: nowD, date_modified: nowD,
    };
    const seedDedup = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [df1, dc1], modified: [], removed: [] },
    });
    assert(seedDedup.json.data.added_count === 2, 'dedup seed: folder + child inserted');

    // Device B pushes the same folder under a NEW uuid + a genuinely new child.
    const df2 = { ...df1, id: 'uuid-df-2' };
    const dc2 = {
      id: 'uuid-dc-2', type: 'url', parent_id: 'uuid-df-2', root: 'other',
      name: 'ChildTwo', url: 'https://example.com/two', position: 1, date_added: nowD, date_modified: nowD,
    };
    const pushRemap = await req('POST', '/api/sync/push', {
      token: apiToken,
      body: { added: [df2, dc2], modified: [], removed: [] },
    });
    assert(
      pushRemap.json.data.added_count === 1,
      'dedup push: only the new child inserted (folder deduped)'
    );
    const dedupEntry = (pushRemap.json.data.deduped || []).find((d) => d.requested_id === 'uuid-df-2');
    assert(
      dedupEntry && dedupEntry.existing_id === 'uuid-df-1',
      'dedup push: folder remapped to existing cloud id'
    );
    const pullDedup = await req('GET', '/api/sync/pull', { token: apiToken });
    const childRow = pullDedup.json.data.bookmarks.find((b) => b.id === 'uuid-dc-2');
    assert(!!childRow && childRow.deleted_at == null, 'dedup push: child is active');
    assert(
      childRow && childRow.parent_id === 'uuid-df-1',
      `dedup push: child re-parented to surviving folder, no orphan (parent_id=${childRow && childRow.parent_id})`
    );

    section('sync/force — second force reusing existing ids (P0-3 regression)');
    // Same payload as the first force: ids already exist as tombstones.
    // The old blind INSERT threw a PRIMARY KEY conflict → whole tx 500.
    const force2 = await req('POST', '/api/sync/force', {
      token: apiToken,
      body: {
        bookmarks: [
          {
            id: 'uuid-forced-1',
            type: 'url',
            parent_id: null,
            root: 'bookmark_bar',
            name: 'ForcedOnly',
            url: 'https://example.com',
            position: 0,
            date_added: Date.now(),
            date_modified: Date.now(),
          },
        ],
      },
    });
    assert(
      force2.status === 200 && force2.json.ok,
      `second force with existing ids → 200 (got ${force2.status}: ${force2.json && (force2.json.error || 'ok')})`
    );
    assert(force2.json.data && force2.json.data.total === 1, 'second force: total=1');
    const pullF2 = await req('GET', '/api/sync/pull', { token: apiToken });
    const activeF2 = pullF2.json.data.bookmarks.filter((b) => b.deleted_at == null);
    assert(
      activeF2.length === 1 && activeF2[0].id === 'uuid-forced-1',
      'second force: exactly the forced row is active (prior rows tombstoned)'
    );

    section('sync/count — live active count (popup realtime display)');
    const cnt = await req('GET', '/api/sync/count', { token: apiToken });
    assert(cnt.status === 200 && cnt.json.ok, 'sync/count responds');
    assert(
      cnt.json.data && cnt.json.data.count === 1,
      `sync/count: live active count is 1 after second force (got ${cnt.json.data && cnt.json.data.count})`
    );
    assert(typeof cnt.json.data.server_time === 'number', 'sync/count returns server_time');

    section('bookmarks DELETE — cascading subtree tombstones (P1-A regression)');
    // Seed a folder + child via force, then delete the FOLDER only from the
    // web API. Old behavior tombstoned just the folder row; the child stayed
    // active with a dead parent_id, which wedged every client's pull
    // checkpoint and resurrected the child at the bookmark-bar root on the
    // next re-merge. The delete must now cascade to the whole subtree.
    const seedTree = await req('POST', '/api/sync/force', {
      token: apiToken,
      body: {
        bookmarks: [
          {
            id: 'uuid-cas-f', type: 'folder', parent_id: null, root: 'bookmark_bar',
            name: 'CascadeFolder', url: null, position: 0,
            date_added: Date.now(), date_modified: Date.now(),
          },
          {
            id: 'uuid-cas-c', type: 'url', parent_id: 'uuid-cas-f', root: 'bookmark_bar',
            name: 'CascadeChild', url: 'https://example.com/cascade', position: 0,
            date_added: Date.now(), date_modified: Date.now(),
          },
        ],
      },
    });
    assert(seedTree.status === 200 && seedTree.json.ok, 'cascade seed: folder+child inserted');
    const delFolder = await req('DELETE', '/api/bookmarks/uuid-cas-f', { token: jwt });
    assert(
      delFolder.status === 200 && delFolder.json.ok,
      `cascade: DELETE folder → 200 (got ${delFolder.status})`
    );
    assert(
      delFolder.json.data && delFolder.json.data.cascaded === 2,
      `cascade: response reports 2 rows tombstoned (got ${delFolder.json.data && delFolder.json.data.cascaded})`
    );
    const pullCascade = await req('GET', '/api/sync/pull', { token: apiToken });
    const casFolder = pullCascade.json.data.bookmarks.find((b) => b.id === 'uuid-cas-f');
    const casChild = pullCascade.json.data.bookmarks.find((b) => b.id === 'uuid-cas-c');
    assert(
      !!casFolder && casFolder.deleted_at != null,
      'cascade: folder row is tombstoned'
    );
    assert(
      !!casChild && casChild.deleted_at != null,
      `cascade: CHILD row is tombstoned too (deleted_at=${casChild && casChild.deleted_at})`
    );
    const delAgain = await req('DELETE', '/api/bookmarks/uuid-cas-f', { token: jwt });
    assert(delAgain.status === 404, 'cascade: deleting an already-deleted folder → 404 (idempotent)');

    section('Token revocation');
    const revoke = await req('DELETE', `/api/tokens/${tokenId}`, { token: jwt });
    assert(revoke.json.ok, 'revoke token');
    const afterRevoke = await req('GET', '/api/sync/pull', { token: apiToken });
    assert(afterRevoke.status === 401, 'revoked token rejected');
  } catch (err) {
    console.error('\nFatal:', err);
    failed++;
  }

  cleanup();

  console.log(`\n──────────────────────────────────────────`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log('\n🎉 All tests passed!');
}

main().catch((err) => {
  console.error('Fatal top-level:', err);
  process.exit(1);
});
