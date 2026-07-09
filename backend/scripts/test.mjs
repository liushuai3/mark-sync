#!/usr/bin/env node
// Integration test for MarkSync backend

const BASE = process.env.API_BASE || 'http://localhost:3000';

async function req(method, path, opts = {}) {
  const { token, body } = opts;
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

function assert(cond, msg) {
  if (!cond) {
    console.error('❌', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

async function main() {
  console.log('--- MarkSync backend integration test ---');
  console.log('BASE =', BASE);

  // 1. Health
  const health = await req('GET', '/health');
  assert(health.status === 200 && health.json.ok, 'health check');

  // 2. Status - can register?
  const status = await req('GET', '/api/auth/status');
  console.log('  status:', JSON.stringify(status.json.data));

  // 3. Register (first user, is_admin = 1)
  const username = 'testuser_' + Date.now();
  const password = 'test123456';
  const reg = await req('POST', '/api/auth/register', {
    body: { username, password, email: `${username}@test.com` },
  });
  assert(reg.status === 200 && reg.json.ok, 'register first user');
  const jwt = reg.json.data.token;
  const userId = reg.json.data.user.id;
  console.log('  userId:', userId, 'jwt:', jwt.slice(0, 30) + '...');

  // 4. /me with JWT
  const me = await req('GET', '/api/auth/me', { token: jwt });
  assert(me.status === 200 && me.json.data.username === username, '/auth/me returns user');

  // 5. Second register should fail
  const reg2 = await req('POST', '/api/auth/register', {
    body: { username: 'another', password: 'test1234' },
  });
  assert(reg2.status === 403 && reg2.json.code === 'REG_CLOSED', 'second registration blocked');

  // 6. Login
  const login = await req('POST', '/api/auth/login', {
    body: { username, password },
  });
  assert(login.status === 200 && login.json.ok, 'login with correct password');

  const badLogin = await req('POST', '/api/auth/login', {
    body: { username, password: 'wrong' },
  });
  assert(badLogin.status === 401, 'login with wrong password fails');

  // 7. Create API Token
  const tokenRes = await req('POST', '/api/tokens', {
    token: jwt,
    body: { name: 'test-device' },
  });
  assert(tokenRes.status === 200 && tokenRes.json.data.token.startsWith('mks_'), 'create API token');
  const apiToken = tokenRes.json.data.token;
  const tokenId = tokenRes.json.data.id;
  console.log('  apiToken prefix:', apiToken.slice(0, 12));

  // 8. List tokens
  const tokenList = await req('GET', '/api/tokens', { token: jwt });
  assert(tokenList.json.data.length === 1, 'list tokens returns 1');
  assert(!('token' in tokenList.json.data[0]), 'list does not leak plaintext token');

  // 9. Push bookmarks
  const b1 = {
    id: 'uuid-folder-1',
    type: 'folder',
    parent_id: null,
    root: 'bookmark_bar',
    name: '工作',
    url: null,
    path: '/工作',
    position: 0,
    date_added: Date.now(),
  };
  const b2 = {
    id: 'uuid-url-1',
    type: 'url',
    parent_id: 'uuid-folder-1',
    root: 'bookmark_bar',
    name: 'Vue',
    url: 'https://vuejs.org',
    path: '/工作/Vue',
    position: 0,
    date_added: Date.now(),
  };
  const push1 = await req('POST', '/api/sync/push', {
    token: apiToken,
    body: { added: [b1, b2], modified: [], removed: [] },
  });
  assert(push1.status === 200 && push1.json.data.added_count === 2, 'push 2 new bookmarks');

  // 10. Push again - should dedupe
  const push2 = await req('POST', '/api/sync/push', {
    token: apiToken,
    body: { added: [b1, b2], modified: [], removed: [] },
  });
  assert(push2.json.data.added_count === 0 && push2.json.data.skipped_count === 2, 'push dedupe (0 added, 2 skipped)');

  // 11. Pull
  const pull = await req('GET', '/api/sync/pull', { token: apiToken });
  assert(pull.json.data.bookmarks.length === 2, 'pull returns 2 bookmarks');
  assert('server_time' in pull.json.data, 'pull returns server_time');

  // 12. Modify
  const mod = await req('POST', '/api/sync/push', {
    token: apiToken,
    body: {
      added: [],
      modified: [{ id: 'uuid-url-1', name: 'Vue.js 官网' }],
      removed: [],
    },
  });
  assert(mod.json.data.modified_count === 1, 'modify 1 bookmark');

  // 13. Remove
  const rm = await req('POST', '/api/sync/push', {
    token: apiToken,
    body: { added: [], modified: [], removed: ['uuid-url-1'] },
  });
  assert(rm.json.data.removed_count === 1, 'remove 1 bookmark');

  // 14. Pull after removal - only folder left
  const pull2 = await req('GET', '/api/sync/pull', { token: apiToken });
  assert(pull2.json.data.bookmarks.length === 1, 'pull after removal returns 1 bookmark');

  // 15. Pull with since - includes tombstone
  const pull3 = await req('GET', '/api/sync/pull?since=0', { token: apiToken });
  assert(pull3.json.data.bookmarks.length === 2, 'pull with since returns tombstone');
  const tombstone = pull3.json.data.bookmarks.find((b) => b.id === 'uuid-url-1');
  assert(tombstone && tombstone.deleted_at, 'tombstone has deleted_at');

  // 16. Stats
  const stats = await req('GET', '/api/stats', { token: jwt });
  assert(stats.json.data.total_folders === 1, 'stats: 1 folder');
  assert(stats.json.data.total_bookmarks === 0, 'stats: 0 active url');
  assert(stats.json.data.total_tokens === 1, 'stats: 1 token');

  // 17. Sync logs
  const logs = await req('GET', '/api/sync-logs', { token: jwt });
  assert(logs.json.data.total >= 4, 'sync logs recorded');

  // 18. Bookmarks list (JWT)
  const bmList = await req('GET', '/api/bookmarks', { token: jwt });
  assert(bmList.json.data.total === 1, 'bookmarks list (active only): 1');

  // 19. Bookmarks tree
  const bmTree = await req('GET', '/api/bookmarks/tree', { token: jwt });
  assert(bmTree.json.data.bookmark_bar.children.length === 1, 'tree: bookmark_bar has 1 child');

  // 20. Force push
  const force = await req('POST', '/api/sync/force', {
    token: apiToken,
    body: {
      bookmarks: [
        {
          id: 'uuid-new-1',
          type: 'url',
          parent_id: null,
          root: 'bookmark_bar',
          name: 'GitHub',
          url: 'https://github.com',
          path: '/GitHub',
          position: 0,
        },
      ],
    },
  });
  assert(force.json.data.total === 1, 'force push: 1 total');

  const pull4 = await req('GET', '/api/sync/pull', { token: apiToken });
  assert(pull4.json.data.bookmarks.length === 1 && pull4.json.data.bookmarks[0].name === 'GitHub', 'force push replaced all');

  // 21. Auth error scenarios
  const noAuth = await req('GET', '/api/auth/me');
  assert(noAuth.status === 401, 'unauthorized without token');

  const wrongToken = await req('GET', '/api/sync/pull', { token: 'mks_' + 'x'.repeat(32) });
  assert(wrongToken.status === 401, 'invalid API token rejected');

  // 22. Revoke token
  const revoke = await req('DELETE', `/api/tokens/${tokenId}`, { token: jwt });
  assert(revoke.json.ok, 'revoke token');
  const afterRevoke = await req('GET', '/api/sync/pull', { token: apiToken });
  assert(afterRevoke.status === 401, 'revoked token rejected');

  console.log('\n🎉 All tests passed!');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
