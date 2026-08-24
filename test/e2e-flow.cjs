// End-to-end business-flow verification for dsh-memory.
// Drives the REAL plugin (lib/index.js apply()) through one continuous story
// in production order, with a scripted LLM and an in-memory session registry:
//
//   Phase 1  a human conversation finishes a turn -> auto-extraction lands
//            memories in the project store (cursor advances)
//   Phase 2  a commander worker session (plugin-sourced turns) runs two turns
//            -> NOTHING extracted, but the usage guide is planted once
//   Phase 3  assembly isolation -> worker gets no briefing, human does
//            (and the briefing carries the planted guide)
//   Phase 4  manual consolidation via route (scripted merge op) -> applied,
//            undo snapshot saved, then POST /undo restores the pre-op state
//   Phase 5  export markdown/json + link/unlink + graph projection
//   Phase 6  status reflects everything (counts, machineSessions, queues)
//
// Run: node test/e2e-flow.cjs   (isolated DSH_HOME; no network needed)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pkg = path.resolve(__dirname, '..');
const localNodeModules = path.join(pkg, 'node_modules');
const harnessModules = process.env.DSH_HARNESS_NODE_MODULES ?? 'C:/Users/cbn/.dsh/profiles/node_modules';
if (!fs.existsSync(localNodeModules) && fs.existsSync(harnessModules)) {
  fs.symlinkSync(harnessModules, localNodeModules, 'junction');
}
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-e2e-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await sleep(step);
  }
}

function fail(msg) { throw new Error('E2E FAIL: ' + msg); }

const CFG = {
  enabled: true, injectEnabled: true, autoExtract: true,
  extractProvider: '', extractModel: '',
  manageProvider: '', manageModel: '',
  consolidateEveryTurns: 20, topK: 8, maxInjectChars: 1500, maxInputChars: 12000,
  maxTokens: 1024, autoArchiveDays: 90, memoryLocale: '',
  embeddingsEnabled: false, embeddingRemoteHost: '', autoLinkThreshold: 0.78,
};

const CWD = 'D:/E2E/DemoProject';
const PKEY_FILE = () => {
  const crypto = require('node:crypto');
  let norm = path.resolve(CWD).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') norm = norm.toLowerCase();
  const key = 'p:' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 16);
  return path.join(process.env.DSH_HOME, 'memory', 'projects', key.slice(2) + '.json');
};
function readProjectStore() {
  const f = PKEY_FILE();
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] };
}

// Scripted auxiliary-model outputs consumed in order by every llm.stream call.
const SCRIPTED_REPLIES = [];
let replyIndex = 0;

async function main() {
  // ---------- boot the real plugin ----------
  const hostUrl = 'file:///' + path.join(pkg, 'lib/index.js').replace(/\\/g, '/');
  const host = await import(hostUrl);
  const T = host.__test;

  const listeners = new Map();
  const routes = [];
  const registeredCommands = [];
  const sessionsRegistry = new Map(); // id -> session fixture (mutable events)

  function makeSession(id, cwdOverride) {
    const sess = {
      id,
      header: { cwd: cwdOverride ?? CWD },
      events: [],
      _nextSeq: 1,
      append(type, message, opts) {
        const event = { type, seq: this._nextSeq++, time: Date.now(), data: { message } };
        this.events.push(event);
        // Mirror what the real firehose does: notify our captured listener.
        const handler = listeners.get('session/event');
        if (handler) handler(this, event);
        return event;
      },
      deriveEventMessage(event) { return event.data?.message ?? null; },
      requestHeader() { return { config: { provider: 'e2e-provider', model: 'e2e-model' } } },
    };
    sessionsRegistry.set(id, sess);
    return sess;
  }

  const baseCtx = {
    config: {},
    inject(services, cb) {
      if (services.includes('settings')) cb({ settings: { register: () => ({ get: () => ({ ...CFG }) }) } });
      if (services.includes('commands')) cb({ commands: { register: (def) => registeredCommands.push(def) } });
    },
    effect(fn) { fn(); },
    on(event, handler) { listeners.set(event, handler); },
    webServer: { register(route) { routes.push(route); return () => {}; } },
    sessions: { get: (id) => sessionsRegistry.get(id), flush: async () => {} },
    llm: {
      stream: async function* () {
        const reply = SCRIPTED_REPLIES[Math.min(replyIndex, SCRIPTED_REPLIES.length - 1)] ?? '';
        yield { type: 'text-delta', index: 0, text: reply };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  };
  host.apply(baseCtx);

  const byPath = (p) => routes.find((r) => r.path === p);
  async function callRoute(p, method, urlOrBody, isGetWithQuery) {
    const route = routes.find((r) => r.path === p); // paths are unique (webserver dedupes by path)
    if (route === undefined) throw new Error('missing route ' + p);
    const box = { code: 0, raw: '' };
    if (method === 'GET') {
      await route.handler({ url: urlOrBody }, { writeHead(s) { box.code = s; }, end(b) { box.raw = b ?? ''; } });
    } else {
      const chunks = Buffer.from(JSON.stringify(urlOrBody), 'utf8');
      const stream = { [Symbol.asyncIterator]() { let sent = false; return { next: async () => (sent ? { done: true } : (sent = true, { done: false, value: chunks })) }; } };
      await route.handler(stream, { writeHead(s) { box.code = s; }, end(b) { box.raw = b ?? ''; } });
    }
    let payload = null;
    try { payload = JSON.parse(box.raw || '{}'); } catch { /* non-JSON (markdown export) is fine */ }
    return { status: box.code, payload, raw: box.raw };
  }

  const assembleHandler = listeners.get('system-prompt/assemble');
  const sessionEvents = (handler) => listeners.get('session/event');
  const turnListener = sessionEvents();
  if (typeof turnListener !== 'function') fail('session/event listener missing');

  // ---------- PHASE 1: human conversation -> auto-extraction ----------
  console.log('PHASE 1: human conversation drives auto-extraction');
  const s1 = makeSession('s1-human');
  SCRIPTED_REPLIES.push('[{"content":"本项目包管理器是 pnpm","type":"decision","tags":["工具链"],"action":"add","targetId":null},{"content":"用户偏好深色主题","type":"preference","tags":["ui"],"action":"add","targetId":null}]');
  replyIndex = 0;
  s1.append('user/message', { role: 'user', content: '我们项目用 pnpm，帮我设置一下深色主题' });
  s1.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '好的，已了解。' }] });
  s1.append('turn/end', {});
  await waitFor(() => readProjectStore().items.length >= 2, 8000);
  const p1Items = readProjectStore().items;
  if (p1Items.length !== 2) fail('phase1 expected 2 extracted memories, got ' + p1Items.length);
  await waitFor(() => {
    const f = path.join(process.env.DSH_HOME, 'memory', 'state.json');
    if (!fs.existsSync(f)) return false;
    try { return (JSON.parse(fs.readFileSync(f, 'utf8')).cursors ?? {})['s1-human'] === 3; } catch { return false; }
  }, 8000);
  const cursorAfterP1 = 3;
  console.log('  OK 2 memories extracted, cursor advanced to 3');

  // ---------- PHASE 2: commander worker isolation + guide planting ----------
  console.log('PHASE 2: commander worker session is isolated, guide planted once');
  SCRIPTED_REPLIES.length = 0; // if the extractor ever ran here, empty reply -> no text -> hard failure surfaces
  replyIndex = 0;
  const w1 = makeSession('w1-worker');
  w1.append('user/message', { role: 'user', content: '【指挥官派发】实现登录页面', source: { kind: 'plugin', plugin: 'dsh-commander' } });
  w1.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '收到，开始实现登录页。' }] });
  w1.append('turn/end', {});
  await waitFor(() => fs.existsSync(PKEY_FILE()) && readProjectStore().items.some((i) => Array.isArray(i.tags) && i.tags.includes('dsh-commander-guide')), 8000);
  let storeNow = readProjectStore();
  const guides = storeNow.items.filter((i) => Array.isArray(i.tags) && i.tags.includes('dsh-commander-guide'));
  if (guides.length !== 1) fail('phase2 guide must be planted exactly once');
  const taskMemories = storeNow.items.filter((i) => i.content.includes('登录页'));
  if (taskMemories.length !== 0) fail('phase2 worker task content leaked into memory');
  // second dispatched turn: still nothing new except nothing duplicated
  w1.append('user/message', { role: 'user', content: '【指挥官派发】继续登录页的表单校验', source: { kind: 'plugin', plugin: 'dsh-commander' } });
  w1.append('assistant/message', { role: 'assistant', content: [{ type: 'text', text: '表单校验完成。' }] });
  w1.append('turn/end', {});
  await sleep(600);
  storeNow = readProjectStore();
  if (storeNow.items.filter((i) => i.content.includes('登录页')).length !== 0) fail('phase2 second worker turn leaked');
  if (storeNow.items.filter((i) => Array.isArray(i.tags) && i.tags.includes('dsh-commander-guide')).length !== 1) fail('phase2 guide duplicated');
  console.log('  OK worker turns produced zero memories; guide planted exactly once');

  // ---------- PHASE 3: injection isolation ----------
  console.log('PHASE 3: assembly isolation between worker and human sessions');
  const mkAsm = () => ({ sections: [], contexts: [], tools: [], variables: {} });
  const workerAsm = await assembleHandler(mkAsm(), { agent: { session: w1 } }, async () => mkAsm());
  if (workerAsm.contexts.some((c) => c.name === 'dsh-memory')) fail('phase3 worker session received a briefing');
  const humanAsm = await assembleHandler(mkAsm(), { agent: { session: s1 } }, async () => mkAsm());
  const memCtx = humanAsm.contexts.find((c) => c.name === 'dsh-memory');
  if (memCtx === undefined) fail('phase3 human session lost its briefing');
  if (!memCtx.text.includes('指挥官模式使用规范')) fail('phase3 briefing should carry the planted guide');
  if (!memCtx.text.includes('pnpm')) fail('phase3 briefing should carry phase-1 memory');
  console.log('  OK worker: silent; human: briefing with guide + project memories');

  // ---------- PHASE 4: consolidation + undo ----------
  console.log('PHASE 4: consolidation applies merge; undo restores');
  // Seed two more so the >=4 guard passes: 2 extracted + guide + seed below.
  await callRoute('/api/dsh-memory/add', 'POST', { scope: 'project', sessionId: 's1-human', content: '测试环境用 staging 域名', type: 'fact', tags: ['env'] });
  SCRIPTED_REPLIES.length = 0;
  SCRIPTED_REPLIES.push('{"ops":[{"op":"merge","into":"' + storeNow.items[0].id + '","from":["' + storeNow.items[1].id + '"],"content":"团队统一使用 pnpm 且用户偏好深色主题"}]}');
  replyIndex = 0;
  const consResult = await callRoute('/api/dsh-memory/consolidate', 'POST', { scope: 'project', sessionId: 's1-human' });
  if (consResult.status !== 200 || typeof consResult.payload.applied !== 'number' || consResult.payload.applied < 1) {
    fail('phase4 consolidate failed: ' + JSON.stringify(consResult));
  }
  let store4 = readProjectStore();
  const archivedOne = store4.items.filter((i) => i.status === 'archived').length;
  if (archivedOne < 1) fail('phase4 merge should archive the source item');
  // undo
  const undoResult = await callRoute('/api/dsh-memory/undo', 'POST', { scope: 'project', sessionId: 's1-human' });
  if (undoResult.status !== 200 || undoResult.payload.restored < 2) fail('phase4 undo wrong: ' + JSON.stringify(undoResult.payload));
  store4 = readProjectStore();
  if (store4.items.filter((i) => i.status === 'archived').length !== 0) fail('phase4 undo should clear archives');
  if (!store4.items.some((i) => i.content === '用户偏好深色主题')) fail('phase4 undo should restore original content');
  console.log('  OK merge applied then fully undone (' + undoResult.payload.restored + ' items restored)');

  // re-do the merge so later phases see a consolidated store
  const redo = await callRoute('/api/dsh-memory/consolidate', 'POST', { scope: 'project', sessionId: 's1-human' });
  if (redo.payload.applied < 1) fail('phase4 redo merge failed');

  // ---------- PHASE 5: link/unlink + graph + export ----------
  console.log('PHASE 5: links, graph projection, export');
  const actives = readProjectStore().items.filter((i) => i.status === 'active');
  const [idA, idB] = [actives[0].id, actives[1].id];
  await callRoute('/api/dsh-memory/link', 'POST', { a: idA, b: idB, kind: 'related' });
  const graph = await callRoute('/api/dsh-memory/graph', 'GET', '/?scope=project&sessionId=s1-human', true);
  if (!graph.payload.edges.some((e) => (e.a === idA && e.b === idB) || (e.a === idB && e.b === idA))) fail('phase5 graph edge missing');
  await callRoute('/api/dsh-memory/unlink', 'POST', { a: idA, b: idB });
  const graph2 = await callRoute('/api/dsh-memory/graph', 'GET', '/?scope=project&sessionId=s1-human', true);
  if (graph2.payload.edges.length !== 0) fail('phase5 unlink did not clear the edge');
  const md = await callRoute('/api/dsh-memory/export', 'GET', '/?format=markdown&scope=project&sessionId=s1-human', true);
  if (!md.raw.includes('# dsh-memory 导出')) fail('phase5 markdown export broken');
  const js = await callRoute('/api/dsh-memory/export', 'GET', '/?format=json&scope=global', true);
  if (!Array.isArray(js.payload?.items)) fail('phase5 json export broken');
  console.log('  OK edges cycle, graph projects, exports serve');

  // ---------- PHASE 6: command + status ----------
  console.log('PHASE 6: /remember command + status truthfulness');
  const rememberCmd = registeredCommands.find((c) => c.name === 'remember');
  if (rememberCmd === undefined) fail('phase6 /remember missing');
  const rememberResult = await rememberCmd.handler({ rawInput: '记住：发布前要更新 CHANGELOG', agent: { session: s1 } });
  if (rememberResult.kind !== 'success') fail('phase6 /remember failed: ' + JSON.stringify(rememberResult));
  const changelogItem = readProjectStore().items.find((i) => i.content.includes('CHANGELOG'));
  if (changelogItem === undefined) fail('phase6 /remember did not persist');
  const st = await callRoute('/api/dsh-memory/status', 'GET', '/', true);
  if (st.payload.machineSessions < 1) fail('phase6 status should count machine sessions');
  if (st.payload.embeddings.enabled !== false) fail('phase6 embeddings should reflect disabled config');
  if (st.payload.counts.projects.length < 1) fail('phase6 project counts missing');
  console.log('  OK /remember persisted; status truthful (machineSessions=' + st.payload.machineSessions + ')');

  // cleanup the /remember item to leave a tidy store
  await callRoute('/api/dsh-memory/remove', 'POST', { id: changelogItem.id });

  console.log('\nALL BUSINESS FLOWS VERIFIED END-TO-END');
}

main().then(() => {
  try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch {}
  console.log('e2e-flow: PASS');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  try { fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
