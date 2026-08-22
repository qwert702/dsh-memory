// Smoke test for dsh-memory:
// 1. node --check on lib/index.js / lib/store.js / lib/util.js / lib/client.js
// 2. Host half: pure helpers (scope keys, briefing selection, model-output
//    parsers, transcript building, route resolution), route registration,
//    the system-prompt/assemble injection listener, the extraction pipeline
//    (cursor + replay -> small model -> store write -> dedupe reinforcement),
//    and the consolidation pipeline (ops validation + application).
//    All filesystem access is isolated into a temp DSH_HOME.
// 3. Client bundle: conversation.view registration (id/order/label), SSR
//    render of the memory tab shell, and the api layer against mocked fetch.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = path.resolve(__dirname, '..');

// The host half imports harness packages. When this checkout has no
// node_modules (fresh clone), junction the harness install's node_modules
// from $DSH_HARNESS_NODE_MODULES so the smoke test still runs.
const localNodeModules = path.join(pkg, 'node_modules');
const harnessModules = process.env.DSH_HARNESS_NODE_MODULES ?? 'C:/Users/cbn/.dsh/profiles/node_modules';
if (!fs.existsSync(localNodeModules) && fs.existsSync(harnessModules)) {
  fs.symlinkSync(harnessModules, localNodeModules, 'junction');
}

// Isolate all memory storage into a throwaway home before any import.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-test-'));

// --- 1. syntax ---
for (const file of ['lib/index.js', 'lib/store.js', 'lib/util.js', 'lib/client.js']) {
  execFileSync(process.execPath, ['--check', path.join(pkg, file)], { stdio: 'inherit' });
}
console.log('OK: node --check passed (index/store/util/client)');

function readMemoryFile(relative) {
  return JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'memory', relative), 'utf8'));
}

// --- 2. host tests ---
async function hostTests() {
  const hostUrl = 'file:///' + path.join(pkg, 'lib/index.js').replace(/\\/g, '/');
  const host = await import(hostUrl);
  if (host.name !== 'dsh-memory-host') throw new Error('bad host name: ' + host.name);
  for (const service of ['webServer', 'settings', 'sessions', 'llm']) {
    if (!host.inject.includes(service)) throw new Error('host missing inject: ' + service);
  }
  const T = host.__test;

  // pure helpers ------------------------------------------------------------
  const keyA = T.projectKeyFor('D:/Work/App');
  const keyB = T.projectKeyFor('d:\\work\\app\\');
  const keyC = T.projectKeyFor('D:/Other');
  if (keyA !== keyB || keyA === keyC || !keyA.startsWith('p:')) throw new Error('projectKeyFor unstable: ' + [keyA, keyB, keyC].join(','));
  console.log('OK: projectKeyFor normalizes separators/case/trailing slashes');

  const mk = (id, scope, content, extra) => ({ id, scope, content, type: 'fact', tags: [], links: [], origin: 'auto', status: 'active', createdAt: Date.now(), updatedAt: Date.now(), useCount: 0, ...extra });
  const briefing = T.selectBriefing(
    [mk('g1', 'global', '全局偏好一'), mk('g2', 'global', '全局偏好二', { status: 'archived' }), mk('g3', 'global', '全局偏好三')],
    [mk('p1', 'project', '项目事实一'), mk('p2', 'project', '项目事实二')],
    4, 10000,
  );
  if (!briefing.text.includes('<memory-briefing>')) throw new Error('briefing missing wrapper');
  if (!briefing.text.includes('【全局】全局偏好一') || !briefing.text.includes('【项目】项目事实一')) throw new Error('briefing missing lines');
  if (briefing.text.includes('全局偏好二')) throw new Error('briefing included archived item');
  if (briefing.ids.length !== 4) throw new Error('briefing picked wrong count: ' + briefing.ids.length);
  if (T.selectBriefing([], [], 8, 1500).text !== '') throw new Error('empty briefing should be empty text');
  const capped = T.selectBriefing([mk('g1', 'global', 'x'.repeat(60)), mk('g2', 'global', 'y'.repeat(60))], [], 8, 70);
  if (capped.ids.length !== 1) throw new Error('char cap failed: ' + capped.ids.length);
  console.log('OK: selectBriefing interleaves scopes, skips archived, honors caps');

  if (T.parseCandidates('前言```json\n[{"content":"甲","type":"decision","tags":["a"]},{"content":"","type":"fact"},{"content":"乙","type":"bogus"}]\n```').length !== 2) throw new Error('parseCandidates fence/prose handling');
  if (T.parseCandidates('[1,null,{"content":123}]').length !== 0) throw new Error('parseCandidates validation');
  if (T.parseCandidates('not json at all').length !== 0) throw new Error('parseCandidates garbage tolerance');
  console.log('OK: parseCandidates sanitizes fences/prose/junk');

  const ops = T.parseOps('{"ops":[{"op":"merge","into":"a","from":["b"],"content":"合并"},{"op":"link","a":"a","b":"b","kind":"weird"},{"op":"nope"}]}');
  if (ops.length !== 2 || ops[0].op !== 'merge' || ops[1].kind !== 'related') throw new Error('parseOps validation: ' + JSON.stringify(ops));
  console.log('OK: parseOps validates op shapes');

  const fixtureEvents = [
    { type: 'user/message', seq: 1, time: 1, data: {} },
    { type: 'assistant/message', seq: 2, time: 2, data: {} },
    { type: 'user/message', seq: 3, time: 3, data: {} },
  ];
  const deriveMap = { 1: { role: 'user', content: '第一条消息' }, 2: { role: 'assistant', content: [{ type: 'text', text: '第二条回复' }] }, 3: { role: 'user', content: '第三条消息，这一条很长很长' } };
  const transcriptSession = {
    events: fixtureEvents,
    deriveEventMessage: (event) => deriveMap[event.seq] ?? null,
  };
  const tr = T.buildTranscript(transcriptSession, 0, 100000);
  if (!tr.text.includes('第一条消息') || !tr.text.includes('第三条消息') || tr.lastSeq !== 3) throw new Error('transcript full build wrong: ' + JSON.stringify(tr));
  const trCapped = T.buildTranscript(transcriptSession, 2, 30);
  if (trCapped.text.includes('第一条消息') || !trCapped.text.includes('第三条消息')) throw new Error('transcript budget must keep newest tail: ' + trCapped.text);
  if (T.buildTranscript(transcriptSession, 3, 100).text !== '') throw new Error('transcript past-cursor should be empty');
  console.log('OK: buildTranscript filters by cursor and keeps the newest tail');

  if (T.resolveRoute({ extractProvider: 'p1', extractModel: 'm1' }, { config: { provider: 'ph', model: 'mh' } }).model !== 'm1') throw new Error('route override should win');
  if (T.resolveRoute({ extractProvider: '', extractModel: '' }, { config: { provider: 'ph', model: 'mh' } }).model !== 'mh') throw new Error('route header fallback');
  if (T.resolveRoute({ extractProvider: '', extractModel: '' }, undefined) !== undefined) throw new Error('route absent case');
  console.log('OK: resolveRoute precedence');

  // apply(): registrations ----------------------------------------------------
  const listeners = new Map();
  const routes = [];
  let settingsRegisterCount = 0;
  const effectsRun = [];
  const baseCtx = () => ({
    inject(services, cb) { cb({ settings: { register: () => ({ get: () => ({}) }) } }); },
    effect(fn, label) { effectsRun.push(label ?? ''); fn(); },
    on(event, handler) { listeners.set(event, handler); },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    sessions: { get: () => undefined },
    llm: { stream: async function* () {} },
  });
  const ctx = baseCtx();
  host.apply(ctx);
  if (settingsRegisterCount !== 0) throw new Error('unexpected');
  const expectedPaths = ['/api/dsh-memory/items', '/api/dsh-memory/add', '/api/dsh-memory/update', '/api/dsh-memory/remove', '/api/dsh-memory/link', '/api/dsh-memory/unlink', '/api/dsh-memory/graph', '/api/dsh-memory/consolidate', '/api/dsh-memory/extract', '/api/dsh-memory/status'];
  for (const expected of expectedPaths) {
    if (!routes.some((r) => r.path === expected)) throw new Error('missing route: ' + expected);
  }
  if (!listeners.has('system-prompt/assemble')) throw new Error('assemble listener not registered');
  if (!listeners.has('session/event')) throw new Error('session/event listener not registered');
  const seenPaths = routes.map((r) => r.path);
  if (new Set(seenPaths).size !== seenPaths.length) throw new Error('duplicate route paths (webserver dedupes by path alone): ' + seenPaths.join(','));
  console.log('OK: host registers 10 unique-path routes + assemble/session listeners');

  // injection listener --------------------------------------------------------
  const cwd = 'D:/Work/DemoProject';
  const pKey = T.projectKeyFor(cwd);
  const memoryDir = path.join(process.env.DSH_HOME, 'memory');
  fs.mkdirSync(path.join(memoryDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'global.json'), JSON.stringify({ version: 1, kind: 'global', items: [mk('g1', 'global', '用户偏好中文回复')] }));
  fs.writeFileSync(path.join(memoryDir, 'projects', pKey.slice(2) + '.json'), JSON.stringify({ version: 1, kind: 'project', cwd, items: [mk('p1', 'project', '本项目用 TypeScript')] }));

  const assemble = listeners.get('system-prompt/assemble');
  const makeAssembly = () => ({ sections: [], contexts: [], tools: [], variables: {} });
  const injectedAssembly = await assemble(makeAssembly(), { agent: { session: { header: { cwd } } } }, async () => makeAssembly());
  const memContexts = injectedAssembly.contexts.filter((entry) => entry.name === 'dsh-memory');
  if (memContexts.length !== 1) throw new Error('injection did not add exactly one context');
  if (!memContexts[0].text.includes('用户偏好中文回复') || !memContexts[0].text.includes('本项目用 TypeScript')) throw new Error('injection text missing memories');
  const noAgentAssembly = await assemble(makeAssembly(), {}, async () => makeAssembly());
  const globalsOnly = noAgentAssembly.contexts.filter((entry) => entry.name === 'dsh-memory');
  if (globalsOnly.length !== 1 || !globalsOnly[0].text.includes('用户偏好中文回复') || globalsOnly[0].text.includes('本项目用 TypeScript')) throw new Error('agentless assembly should carry globals only');
  const otherProjectAssembly = await assemble(makeAssembly(), { agent: { session: { header: { cwd: 'D:/nowhere' } } } }, async () => makeAssembly());
  const otherProjectContexts = otherProjectAssembly.contexts.filter((entry) => entry.name === 'dsh-memory');
  if (otherProjectContexts.length !== 1 || !otherProjectContexts[0].text.includes('用户偏好中文回复') || otherProjectContexts[0].text.includes('本项目用 TypeScript')) {
    throw new Error('a different workspace must scope to globals only');
  }
  console.log('OK: injection adds scoped briefing (full / global-only / none)');

  // extraction pipeline ---------------------------------------------------------
  const extractionModelReplies = [
    '[{"content":"用户偏好深色主题界面","type":"preference","tags":["ui"]},{"content":"团队决定用 pnpm 管理依赖","type":"decision","tags":["工具链"]}]',
    '[{"content":"团队决定用 pnpm 管理所有依赖","type":"decision","tags":["工具链"]}]',
  ];
  let replyIndex = 0;
  const extractionCtx = baseCtx();
  extractionCtx.sessions.get = (id) => (id === 'session-1'
    ? {
        id: 'session-1',
        header: { cwd },
        events: [...fixtureEvents, { type: 'turn/end', seq: 4, time: 4, data: {} }],
        deriveEventMessage: (event) => deriveMap[event.seq] ?? null,
        requestHeader: () => ({ config: { provider: 'asdf', model: 'qwen38' } }),
      }
    : undefined);
  extractionCtx.llm = {
    stream: async function* () {
      const reply = extractionModelReplies[Math.min(replyIndex, extractionModelReplies.length - 1)];
      replyIndex += 1;
      yield { type: 'text-delta', index: 0, text: reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const runtime = T.createRuntime(extractionCtx, () => ({
    enabled: true, injectEnabled: true, autoExtract: true,
    extractProvider: '', extractModel: '',
    consolidateEveryTurns: 20, topK: 8, maxInjectChars: 1500, maxInputChars: 12000, maxTokens: 1024,
  }));
  const firstExtract = await T.extractSession(runtime, 'session-1', false);
  let projectStore = readMemoryFile(path.join('projects', pKey.slice(2) + '.json'));
  if (firstExtract.added !== 2 || firstExtract.reinforced !== 0) throw new Error('first extract wrong: ' + JSON.stringify(firstExtract));
  projectStore = readMemoryFile(path.join('projects', pKey.slice(2) + '.json'));
  // 1 seeded during injection tests + 2 freshly extracted.
  if (projectStore.items.length !== 3) throw new Error('project store should hold 3 items: ' + projectStore.items.length);
  if (!projectStore.items.some((item) => item.content.includes('深色主题')) || !projectStore.items.some((item) => item.content.includes('pnpm'))) {
    throw new Error('extracted memories missing: ' + JSON.stringify(projectStore.items.map((i) => i.content)));
  }
  if (runtime.state.cursors['session-1'] !== 4) throw new Error('extraction cursor not advanced: ' + runtime.state.cursors['session-1']);
  const secondExtract = await T.extractSession(runtime, 'session-1', true);
  if (secondExtract.added !== 0 || secondExtract.reinforced !== 1) throw new Error('dedupe reinforce wrong: ' + JSON.stringify(secondExtract));
  projectStore = readMemoryFile(path.join('projects', pKey.slice(2) + '.json'));
  const pnpmItem = projectStore.items.find((item) => item.content.includes('pnpm'));
  if (projectStore.items.length !== 3 || pnpmItem.useCount !== 1) throw new Error('near-duplicate should reinforce in place');
  console.log('OK: extraction replays tail, routes via header, writes project store, reinforces near-duplicates');

  // consolidation pipeline ---------------------------------------------------------
  replyIndex = 0;
  const themeItem = projectStore.items.find((item) => item.content.includes('深色主题'));
  // The consolidation guard skips scopes with fewer than 4 active memories.
  await runtime.store.addOrReinforce(pKey, { content: '部署前必须跑通全部单元测试', type: 'pattern', tags: ['流程'], origin: 'manual', cwd });
  extractionCtx.llm = {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: '{"ops":[{"op":"merge","into":"' + pnpmItem.id + '","from":["' + themeItem.id + '"],"content":"用户偏好深色主题且团队统一使用 pnpm"},{"op":"archive","id":"missing-id"}]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
  const consolidated = await T.consolidateScope(runtime, pKey, 'session-1');
  if (consolidated !== 1) throw new Error('consolidation should apply exactly 1 valid op: ' + consolidated);
  projectStore = readMemoryFile(path.join('projects', pKey.slice(2) + '.json'));
  const activeItems = projectStore.items.filter((item) => item.status === 'active');
  const archivedItems = projectStore.items.filter((item) => item.status === 'archived');
  if (activeItems.length !== 3 || archivedItems.length !== 1) throw new Error('merge did not archive the source: ' + JSON.stringify(projectStore.items.map((i) => i.status)));
  const mergedActive = activeItems.find((item) => item.id === pnpmItem.id);
  if (mergedActive.content !== '用户偏好深色主题且团队统一使用 pnpm') throw new Error('merged content wrong: ' + mergedActive.content);
  if (!mergedActive.links.some((edge) => edge.kind === 'supersedes' && edge.id === themeItem.id)) throw new Error('merge should link supersedes toward the source');
  if (runtime.state.lastConsolidation[pKey] === undefined) throw new Error('lastConsolidation not recorded');
  if (runtime.state.turnCounts[pKey] !== 0) throw new Error('turn counter not reset');
  console.log('OK: consolidation validates ids, merges+archives, records the run');

  // status route -------------------------------------------------------------------
  const statusRoute = routes.find((r) => r.path === '/api/dsh-memory/status');
  let statusBody = '';
  await statusRoute.handler(
    { url: '/' },
    { writeHead() {}, end(body) { statusBody = body; } },
  );
  const status = JSON.parse(statusBody);
  if (status.ok !== true || status.enabled !== true || typeof status.counts.global.active !== 'number') throw new Error('status payload wrong: ' + statusBody.slice(0, 200));
  console.log('OK: status route reports counters');

  // items GET route (explicit scope params) -------------------------------------------
  // Registered on a fresh ctx whose session table can resolve session-1.
  const scopedRoutes = [];
  const scopedCtx = baseCtx();
  scopedCtx.webServer = { register(route) { scopedRoutes.push(route); return () => {}; } };
  scopedCtx.sessions.get = (id) => (id === 'session-1' ? { id, header: { cwd } } : undefined);
  host.apply(scopedCtx);
  const itemsRoute = scopedRoutes.filter((r) => r.path === '/api/dsh-memory/items')[0];
  const fakeRes = () => {
    const box = {};
    return { res: { writeHead() {}, end(body) { box.body = body; } }, json: () => JSON.parse(box.body) };
  };
  let f = fakeRes();
  await itemsRoute.handler({ url: '/?scope=project&sessionId=session-1' }, f.res);
  let parsedItems = f.json();
  if (parsedItems.ok !== true || parsedItems.scope !== 'project' || parsedItems.resolved !== true) {
    throw new Error('items project route wrong: ' + JSON.stringify(parsedItems).slice(0, 200));
  }
  f = fakeRes();
  await itemsRoute.handler({ url: '/?scope=project&sessionId=nope' }, f.res);
  parsedItems = f.json();
  if (parsedItems.resolved !== false) throw new Error('unresolved project scope should report resolved:false');
  f = fakeRes();
  await itemsRoute.handler({ url: '/?scope=global' }, f.res);
  parsedItems = f.json();
  if (parsedItems.scope !== 'global' || parsedItems.items.length !== 1) throw new Error('items global route wrong');
  console.log('OK: items route resolves scopes explicitly');

  // remaining routes against the scoped ctx -------------------------------------
  const byPath = (p, method) => scopedRoutes.find((r) => r.path === p && (r.method ?? 'GET') === (method ?? 'GET'));
  const post = async (route, body) => {
    const box = { code: 0, raw: '' };
    const chunks = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const stream = {
      [Symbol.asyncIterator]() {
        let sent = false;
        return { next: async () => (sent ? { done: true } : (sent = true, { done: false, value: chunks })) };
      },
    };
    await route.handler(stream, { writeHead(s) { box.code = s; }, end(b) { box.raw = b ?? ''; } });
    return { status: box.code, payload: JSON.parse(box.raw) };
  };

  // manual add: created, then near-duplicate reinforces instead of duplicating
  const addRoute = byPath('/api/dsh-memory/add');
  let r = await post(addRoute, { scope: 'project', sessionId: 'session-1', content: '接口统一返回 Result 包装结构', type: 'pattern', tags: ['api'] });
  if (r.status !== 200 || r.payload.created !== true) throw new Error('manual add failed: ' + JSON.stringify(r));
  const manualId = r.payload.item.id;
  r = await post(addRoute, { scope: 'project', sessionId: 'session-1', content: '接口统一返回Result包装结构', type: 'pattern', tags: [] });
  if (r.status !== 200 || r.payload.created !== false || r.payload.item.id !== manualId) throw new Error('manual add should dedupe: ' + JSON.stringify(r.payload));
  r = await post(addRoute, { scope: 'project', sessionId: 'session-1', content: '' });
  if (r.status !== 400 || r.payload.error.code !== 'bad-request') throw new Error('empty content must 400');
  r = await post(addRoute, { scope: 'project', sessionId: 'ghost-session', content: '无工作区会话应拒绝项目写入' });
  if (r.status !== 400 || r.payload.error.code !== 'no-workspace') throw new Error('unresolvable project add must 400 no-workspace');
  console.log('OK: manual add creates / dedupes / validates workspace');

  // update: edit + archive + 404
  const updateRoute = byPath('/api/dsh-memory/update', 'POST');
  r = await post(updateRoute, { id: manualId, patch: { content: '接口统一返回 Result<T> 包装结构', status: 'archived' } });
  if (r.status !== 200 || r.payload.item.content !== '接口统一返回 Result<T> 包装结构' || r.payload.item.status !== 'archived') throw new Error('update failed: ' + JSON.stringify(r));
  r = await post(updateRoute, { id: 'mem_missing', patch: { content: 'x' } });
  if (r.status !== 404) throw new Error('update of unknown id must 404');
  console.log('OK: update edits/archives, 404s unknown ids');

  // link/unlink: symmetric edge, dedupe, guards
  const linkRoute = byPath('/api/dsh-memory/link', 'POST');
  const unlinkRoute = byPath('/api/dsh-memory/unlink', 'POST');
  const gId = readMemoryFile('global.json').items[0].id;
  r = await post(linkRoute, { a: gId, b: gId });
  if (r.status !== 400 || r.payload.error.code !== 'self-link') throw new Error('self link must 400');
  r = await post(linkRoute, { a: gId, b: manualId });
  if (r.status !== 400 || r.payload.error.code !== 'cross-scope') throw new Error('cross-scope link must 400');
  const themeId2 = readMemoryFile(path.join('projects', pKey.slice(2) + '.json')).items.find((i) => i.content.includes('深色主题'))?.id;
  const pnpmId2 = readMemoryFile(path.join('projects', pKey.slice(2) + '.json')).items.find((i) => i.id === pnpmItem.id)?.id;
  r = await post(linkRoute, { a: themeId2, b: pnpmId2, kind: 'related' });
  if (r.status !== 200) throw new Error('link failed: ' + JSON.stringify(r));
  r = await post(linkRoute, { a: themeId2, b: pnpmId2 });
  if (r.status !== 200) throw new Error('duplicate link must stay 200');
  const linkedStore = readMemoryFile(path.join('projects', pKey.slice(2) + '.json'));
  const edgeCount = linkedStore.items.find((i) => i.id === themeId2).links.filter((e) => e.id === pnpmId2).length;
  if (edgeCount !== 1) throw new Error('link should be stored once per direction: ' + edgeCount);
  r = await post(unlinkRoute, { a: themeId2, b: pnpmId2 });
  if (r.status !== 200) throw new Error('unlink failed');
  console.log('OK: link/unlink enforce same-store, self-link guard, single-edge dedupe');

  // remove: hard delete + 404
  const removeRoute = byPath('/api/dsh-memory/remove', 'POST');
  r = await post(removeRoute, { id: manualId });
  if (r.status !== 200) throw new Error('remove failed: ' + JSON.stringify(r));
  r = await post(removeRoute, { id: manualId });
  if (r.status !== 404) throw new Error('second remove must 404');
  console.log('OK: remove deletes once then 404s');

  // graph: nodes = active items, edges follow links
  const graphRoute = byPath('/api/dsh-memory/graph');
  f = fakeRes();
  await graphRoute.handler({ url: '/?scope=project&sessionId=session-1' }, f.res);
  const graphPayload = f.json();
  const expectedActive = readMemoryFile(path.join('projects', pKey.slice(2) + '.json')).items.filter((i) => i.status === 'active').length;
  if (graphPayload.ok !== true || graphPayload.nodes.length !== expectedActive) throw new Error('graph nodes wrong: ' + JSON.stringify(graphPayload).slice(0, 160));
  f = fakeRes();
  await graphRoute.handler({ url: '/?scope=project&sessionId=ghost' }, f.res);
  if (f.json().resolved !== false || f.json().nodes.length !== 0) throw new Error('unresolved graph must be empty');
  console.log('OK: graph projection counts only active items');

  // extract route: missing sessionId -> 400; unknown session -> silent ok
  const extractRoute = byPath('/api/dsh-memory/extract', 'POST');
  r = await post(extractRoute, {});
  if (r.status !== 400) throw new Error('extract without sessionId must 400');
  r = await post(extractRoute, { sessionId: 'unknown-session' });
  if (r.status !== 200 || r.payload.added !== 0) throw new Error('extract of unknown session should no-op 200');
  console.log('OK: extract route validates input, no-ops unknown sessions');
}

// --- 3. client bundle tests ---
async function clientTests() {
  const react = require(path.join(harnessModules, 'react'));
  const jsxRuntime = require(path.join(harnessModules, 'react/jsx-runtime'));

  const loader = {};
  global.window = {
    __ModuleLoader__: {
      load(entry) {
        loader.id = entry.id;
        loader.exports = entry.factory((spec) => {
          if (spec === 'react') return react;
          if (spec === 'react/jsx-runtime') return jsxRuntime;
          throw new Error('unexpected require: ' + spec);
        });
      },
    },
  };
  try {
    const source = fs.readFileSync(path.join(pkg, 'lib/client.js'), 'utf8');
    (0, eval)(source);
  } finally {
    delete global.window;
  }
  if (loader.id !== 'dsh-memory') throw new Error('wrong bundle id: ' + loader.id);
  const client = loader.exports;
  if (client.inject.length !== 2 || client.inject[0] !== 'slots' || client.inject[1] !== 'locale') {
    throw new Error('wrong client inject: ' + JSON.stringify(client.inject));
  }
  console.log('OK: client bundle loads, inject slots+locale');

  // registration: one additive entry on the conversation.view ring
  let dictionaries;
  const entries = [];
  const localeBound = (key) => 'T:' + key;
  const ctx = {
    effect(fn) { fn(); },
    locale: {
      register(ns, dict) { dictionaries = { ns, dict }; },
      bind() { return localeBound; },
    },
    slots: {
      inject(key, factory) {
        if (key !== 'conversation.view') throw new Error('wrong injected seat: ' + key);
        const registerCall = factory();
        registerCall();
        return () => {};
      },
      register(opts, component) {
        entries.push({ opts, component });
        return () => {};
      },
    },
  };
  client.apply(ctx);
  if (dictionaries.ns !== 'dsh-memory' || dictionaries.dict.zh['view.memory'] !== '记忆') throw new Error('locale dictionaries not registered');
  const views = entries.filter((e) => e.opts.name === 'conversation.view');
  if (views.length !== 1) throw new Error('expected one conversation.view entry');
  if (views[0].opts.id !== 'memory') throw new Error('view id wrong: ' + views[0].opts.id);
  if (views[0].opts.order !== 11) throw new Error('view order should sit right after trajectory (10)');
  if (views[0].opts.label() !== 'T:view.memory') throw new Error('view label not wired through locale bind');
  console.log('OK: client registers the memory view tab beside trajectory');

  // SSR: the tab shell renders with an empty store
  const renderer = require(path.join(harnessModules, 'react-dom/server'));
  const t = (key, params) => {
    let value = dictionaries.dict.zh[key] ?? key;
    if (params != null) for (const [k, v] of Object.entries(params)) value = value.replaceAll('{' + k + '}', String(v));
    return value;
  };
  const html = renderer.renderToString(react.createElement(client.MemoryView, { t, sessionId: 'session-1' }));
  if (!html.includes('data-dsh-memory')) throw new Error('memory tab root missing');
  for (const marker of ['项目', '全局', '列表', '图谱', '整理', '新增']) {
    if (!html.includes(marker)) throw new Error('tab toolbar missing marker: ' + marker);
  }
  console.log('OK: client SSR renders the memory tab shell');

  // api layer against mocked fetch
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ json: async () => ({ ok: true, applied: 3 }) });
    const result = await client.consolidate('session-1', 'project');
    if (result.applied !== 3) throw new Error('consolidate api wrong');
    global.fetch = async () => ({ json: async () => ({ ok: false, error: { code: 'no-route', message: 'no provider/model' } }) });
    let failed = false;
    try {
      await client.extractNow('session-1', true);
    } catch (error) {
      failed = String(error.message).includes('no provider/model');
    }
    if (!failed) throw new Error('extract failure path did not throw');
    console.log('OK: api layer success + failure paths');
  } finally {
    global.fetch = originalFetch;
  }
}

async function main() {
  await hostTests();
  await clientTests();
  console.log('all smoke tests passed');
}

main().then(() => {
  try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch {}
}).catch((error) => {
  console.error(error);
  try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});

