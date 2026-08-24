# dsh-memory 项目交接文档

> **文档目的**：AI-to-AI 完整交接。读完本文档即可在不询问原作者的情况下继续开发、调试、部署本项目。
> **最后更新**：v2.0.0（commit `55cb163` 之后）· 由 Claude (ox-alpha) 与用户多轮协作后整理

---

## 1. 项目概览

| 项 | 内容 |
|---|---|
| 名称 | **dsh-memory**（DeepSeek Harness 网页端长期记忆插件） |
| 版本 | 2.0.0 |
| 仓库 | https://github.com/qwert702/dsh-memory （main 分支，标签 v2.0.0） |
| 源码目录 | `D:\CBN-HT\Desktop\AI编程\dsh插件\dsh-memory(记忆插件）`（注意：文件夹名含中文和全角括号，但 package name 是干净的 `dsh-memory`） |
| 许可 | MIT |

**一句话定位**：给 DeepSeek Harness 网页 GUI 加上"项目级 + 全局级"长期记忆：对话自动提取记忆、每次请求自动注入相关记忆、小模型定期整理、Obsidian 风格图谱可视化。

## 2. 本机运行环境地图（关键路径）

```
源码（git 仓库）      D:\CBN-HT\Desktop\AI编程\dsh插件\dsh-memory(记忆插件）\
harness 安装          D:\CBN-HT\Desktop\deepseek hnerses\
  ├ 启动脚本           start-dsh.bat（node bin.js web，日志追加到 dsh-web.log）
  ├ CLI 等价物         node node_modules\@deepseek-ai\dsh\lib\bin.js <cmd>
  └ node_modules       含全部 @deepseek-ai/* 包（插件裸导入靠它解析）
本地插件挂载点        deepseek hnerses\plugins\dsh-memory  ← 目录联接(junction)→源码
profile 目录          C:\Users\cbn\.dsh\profiles\web\
  ├ cordis.patch.yml  末尾有 ui-memory 的 insert 补丁
  └ node_modules\     pnpm 工作区（dsh-link-plugin 等在此）
共享回退目录          C:\Users\cbn\.dsh\profiles\node_modules\
  ├ @deepseek-ai\*    heal 脚本生成的 symlink（boot 时自动补齐）
  ├ dsh-memory        junction → plugins\dsh-memory（手动建，供 profile 解析包名）
  └ @huggingface\transformers  junction → deepseek hnerses\node_modules 里那份
数据目录              C:\Users\cbn\.dsh\memory\（global.json / projects\<hash>.json /
                      vectors\<key>.json / undo\<key>.json / state.json；尊重 $DSH_HOME）
凭据/设置            ~/.dsh/.credentials.yaml、~/.dsh/settings.yaml
服务地址             http://127.0.0.1:3080（启动后约 5 秒可用）
网络注意              GitHub 直连被墙：git push 用 `git -c http.proxy=http://127.0.0.1:7897`；
                      npm registry 已配 npmmirror；HuggingFace 用 hf-mirror.com（见设置 embeddingRemoteHost）
```

**本地插件安装三步法**（本机约定，token-viewer 同款）：
1. `mklink /J "deepseek hnerses\plugins\dsh-memory" "<源码目录>"`（改源码即时生效）
2. `mklink /J "C:\Users\cbn\.dsh\profiles\node_modules\dsh-memory" "<plugins 里的路径>"`（Node 沿父目录解析包名）
3. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加 `- insert: [- id: ui-memory, name: 'dsh-memory']`

⚠️ **切勿在插件源码目录里执行 `npm i`**——一旦出现本地 node_modules，loader 对 `@deepseek-ai/*` 的解析会立刻断掉导致整树加载失败（血泪教训，见 §7 Bug#11）。可选依赖装到 `deepseek hnerses\node_modules` + 在共享回退目录建 junction（@huggingface 就是这么装的）。

## 3. Harness 平台技术要点（踩坑知识库）

### 3.1 插件双半区架构
- **host 半区** `lib/index.js`（ESM）：导出 `{ name, inject, apply }`；`inject` 数组声明必需服务，`apply(ctx)` 内通过 `ctx.inject(['settings'], cb)` 动态等待可选服务。
- **client 半区** `lib/client.js`：手写 bundle，外层 `window.__ModuleLoader__.load({ id, factory(require){...} })`；require 只能拿 react/react/jsx-runtime 等 client 注入列表里的包。
- `package.json` 的 `dsh.client.inject` 列出客户端需要的模块；`dsh.bundle.patch` 指向 yml 组合补丁。

### 3.2 已验证可用的插槽/服务/事件
| 挂点 | 用法 | 本项目实例 |
|---|---|---|
| `conversation.view`（list 座位） | 注册视图 Tab（对话/轨迹旁），`order` 排序（trajectory=10，我们=11） | 记忆 Tab |
| `conversation.chat.assistant-actions` | 每条 AI 回复旁加按钮（owner 给 messageId） | ✦记住 按钮 |
| `shell.overlay` | 全局浮层 | toast 通知 |
| `conversation.session.header.actions` / `.utilities` | 标题栏动作/右侧工具 | （compressor/exporter 在用） |
| `ctx.commands.register({name,input:{hint},handler})` | 斜杠命令，handler 收 `{rawInput, agent, signal}` 返回 `{kind:'success'|'error', text}` | `/remember` |
| `ctx.on('session/event', (session,event)=>)` | 全量事件火线：user/message、assistant/message、turn/end…；事件带 seq；`event.data.message.source.kind==='plugin'` 可识别机器输入 | 分类+提取触发+相关性缓冲 |
| `ctx.on('system-prompt/assemble', async(asm,ctx,next)=>{ const a=await next(); return {...a,contexts:[...]} })` | 全局瀑布监听，往 `assembly.contexts` push `{name,text}` 即注入；`ctx.agent.session.header.cwd` 定位项目 | 记忆简报注入 |
| `ctx.llm.stream({provider,model,messages,maxTokens,purpose})` | 辅助调用；`purpose` 只允许 `'compaction'｜'session-title'`；BlockAssembler 收块 | 提取/整理/distill |
| `webServer.register({kind:'exact',path,handler(req,res)})` | HTTP API。**只按 path 去重**——同 path 分方法会整树崩溃 | 15 条路由 |
| `installSettingsSection(ctx,ns,schema,entry,hooks)` | schema 自动生成网页设置表单；schemastery 链式 `.description()` 有效 | 设置面板 |
| `sessions.create/fork/open/rename/binding(id).session` | 客户端会话运行时 | 溯源跳转 |

### 3.3 踩坑记录（重要！）
1. **schemastery 没有 `.int()`**（token-viewer 里的 `.int()` 来自 zod）——整数用 `.step(1).min(n)`。
2. **webserver exact 路由按 path 去重**，GET/POST 同路径 = 整树加载失败。POST 一律独立路径（我们用 `/add`）。
3. **PowerShell 5.1 写文件默认带 UTF-8 BOM** → JSON.parse 报 "Unexpected token '?'"；且单引号串里 `` `n `` 不转义会字面写入 JS 造成模板串泄漏。**一律用 Edit/Write 工具或 `[IO.File]::WriteAllText($p,$c,(New-Object Text.UTF8Encoding($false)))`**。
4. **插件目录出现本地 node_modules 会切断 harness 包解析**（ERR_MODULE_NOT_FOUND @deepseek-ai/dsh-settings）。可选依赖装到 harness 目录 + 共享回退目录建 junction。
5. Node ESM 从 **junction 路径**加载时沿 junction 所在链解析——这就是"共享回退目录 junction"能生效的原理。
6. 冒烟测试需要 harness 的 node_modules：脚本自动从 `$DSH_HARNESS_NODE_MODULES`（默认 `C:/Users/cbn/.dsh/profiles/node_modules`）建 junction；隔离数据用 `process.env.DSH_HOME=<临时目录>`（dshHomePath 每次动态读取）。
7. `healProfilesModuleFallback` 每次 boot 把 harness 全部传递依赖 symlink 进 `~/.dsh/profiles/node_modules`——新增顶层依赖后需重启才进回退链。

## 4. 数据模型与文件布局

```jsonc
// 单条记忆 Memory
{
  "id": "mem_<base36ts>_<counter><rand>",
  "scope": "global | project",
  "content": "≤500 字符的一句话",
  "type": "fact | preference | decision | pattern | entity",
  "tags": ["最多5个"],
  "links": [{ "id": "另一条id", "kind": "related | supersedes | contradicts" }],  // 双向存边
  "origin": "auto | manual | consolidation",   // manual 整理时权重更高
  "status": "active | archived",
  "pinned": true?,                              // 📌 注入保底携带
  "cwd": "项目库条目才有",
  "createdAt": 0, "updatedAt": 0, "lastUsedAt": 0, "useCount": 0,
  "sourceSessionId": "溯源跳转用"
}
// store 文件: { version:1, kind, cwd?, items:[Memory] }
// 向量 sidecar: { version:1, model:"Xenova/all-MiniLM-L6-v2", dim:384, items:{ id:{v:[384],at:updatedAt} } }
// state.json: { cursors:{sessionId:seq}, turnCounts:{storeKey:n}, lastConsolidation:{storeKey:{at,applied}} }
```

## 5. 业务逻辑全图

### 5.1 四条写入路径
① **全自动提取**（核心）：`turn/end` → 队列串行 → 按 cursor 取增量事件 → buildTranscript（过滤 plugin-source 用户行，保最新尾截断）→ 小模型输出 JSON 候选（v2 协议：每条带 `action: add|update|supersede|contradict` + targetId，提示词附最多 5 条既有相关记忆）→ applyCandidate 应用（字面 bigram-Jaccard ≥0.65 强制去重强化）→ 游标推进 → 连续失败 3 次 paused（手动成功恢复）。**子代理(origin=subagent/delegationDepth>0)与机器驱动会话跳过**。
② **✦记住按钮**（assistant-actions 插槽）：distill 单条消息走同一提取管线。
③ **/remember 文本**：原样入库 origin=manual。
④ **Tab 表单/导入**：同上。

### 5.2 会话驱动者分类（指挥官适配的核心）
- plugin-source 用户消息（如 commander 派发简报 `source.plugin='dsh-commander'`）→ 标记 session 为 `machine`
- 任何人类输入 → 翻转为 `human` 且终身保持
- machine 会话：**不提取、不注入简报、transcript 过滤其派发行**；相关性缓冲只记人类输入
- 分类表上限 500 条 LRU 式淘汰；检测优先读原始事件载荷（derive 可能丢 source）

### 5.3 注入（读路径）
`system-prompt/assemble` 瀑布（next() 后追加）：
```
score = importance × (1 + 10×词面相关) × (1 + 14×语义拉伸)   // 有向量时
importance = recency(~21天半衰) × (1+log2(1+useCount)) × (1+0.15×min(degree,3))
选取：pinned 先占坑 → 全局/项目交替填充至 topK(默认8)，maxInjectChars(1500) 截断
查询向量 = embed(recent 缓冲末2000字符人类输入)，按文本 memo 化；模型未 ready 时后台预热本轮降级
```
命中即节流强化（60s/agent + 3s 批量落盘 useCount/lastUsedAt）。machine 会话直接返回原 assembly。

### 5.4 整理与治理
- 触发：每作用域累计提取 N 轮（默认20）/ 手动按钮。模型 ops 协议 merge/link/archive/retag，id 校验后单事务应用；**模型驱动才写 undo 快照**
- 启发式自动归档：`autoArchiveDays`(90) 未动 + useCount=0 + 无链接 → 合成 archive op（不依赖模型、不覆盖撤销点）
- **自动建链**：整理尾部跑 autoLinkPass——活跃对余弦 ≥ `autoLinkThreshold`(0.78) 补双向 related 边（单次 ≤30 对，不进快照）
- POST /undo 整体还原快照条目

### 5.5 语义召回
- transformers.js 懒加载 all-MiniLM-L6-v2（WASM）；推理链式串行；向量写 sidecar（mtime+size 校验缓存）
- 生成点：extract/distill/manual-add/import 之后 enqueueEmbed；POST /embed 手动回填（等待完成）
- 查询向量仅在 embedder state==='ready' 时同步 await，否则后台预热+本轮降级
- **全链路 fail-soft**：依赖缺失/下载失败 → 词面-only，状态暴露于 status.embeddings

## 6. 版本演进时间线

| 阶段 | 内容 |
|---|---|
| M1-M6 初版 | 骨架/注入/提取/整理/图谱/打磨；上线时抓到路由重复 bug（POST /items→/add） |
| 扫描1-4轮 | 修 10 bug：touch()调已删API致强化失效(高危)、flush并发窗口丢增量、supersede双边、import无id、响应竞态、错库回退、BOM、键盘绕过 busy 等 |
| 调研 | Mem0/Letta/Zep/LangMem + 编码助手插件生态 → 确认"本地嵌入混合检索"是行业标准且为我们唯一战略短板 |
| **v2.0** | 语义召回(embeddings.js)+自动建链+详情页溯源+manage 双模型分工；37→40 冒烟；e2e-flow 六阶段业务流验证入 CI |
| 指挥官适配 | machine/human 会话分类三级隔离（§5.2）；指南自动植入（幂等，tag=dsh-commander-guide，内容含 dispatch 协议与规范，388字符） |
| 扫描5 | transcript source 检测优先原始载荷（防 derive 丢失）；sessionKinds 封顶 500 |

## 7. 测试体系

| 套件 | 文件 | 内容 | 状态 |
|---|---|---|---|
| smoke | test/smoke.cjs | **40 项**：纯函数/14路由注册/注入三场景/提取+去重/整理ops/undo/导出导入/distill//remember/嵌入退化或真实推理/自动建链/机器隔离/client注册+SSR | ✅ 全绿 |
| e2e | test/e2e-flow.cjs | 六阶段连续故事（见 §6 v2.0 行） | ✅ PASS |
| CI | .github/workflows/smoke.yml | ubuntu + npm i @deepseek-ai/dsh react react-dom → 跑两套件（尚未实际触发过一次） | ⚠️ 待首次运行确认 |

运行：`node test/smoke.cjs && node test/e2e-flow.cjs`（自动临时 DSH_HOME 隔离；smoke 需要 harness node_modules 可达——本机默认路径存在，CI 走 env）。

## 8. 已知限制与未验证项（诚实清单）

1. **真实小模型的提取质量未验证**——需配 extractProvider/Model 跑几天看准确率（当前机器 hasRoute=false，辅助调用跟随会话模型或报 no-route）
2. **设置面板卡片是否渲染、/remember 是否出现在斜杠菜单**——机制有先例+mock 断言，但没有人在真 UI 点过
3. turnCounts 跨进程 ±1 漂移（有意取舍，注释声明）
4. 列表无虚拟滚动（数百条后卡）；图谱 O(n²) 上限几百节点
5. dsh-link 公网桥接场景下 API 无鉴权（未评估桥接器是否透传）
6. host 错误消息为英文未做 locale 映射
7. index.js ~1300 行，可拆 pipelines/routes 模块
8. README 无截图

## 9. 路线图建议（按性价比）

1. 统计面板（token 花费/提取命中/死重）——观测性是下一个 9 分门票
2. Bi-temporal 视图（as_of 查询，地基已有）
3. 程序记忆（行为规则反馈提示词，LangMem 思路）
4. 会话级记忆开关、批量操作
5. 远程场景鉴权（若 dsh-link 透传 API）

## 10. 常用命令速查

```powershell
# 重启 harness（杀3080再起）
Get-NetTCPConnection -LocalPort 3080 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }
Start-Process cmd -ArgumentList '/c','"D:\CBN-HT\Desktop\deepseek hnerses\start-dsh.bat"' -WindowStyle Hidden

# 测试
node test/smoke.cjs ; node test/e2e-flow.cjs        # 在源码目录

# 推送（需代理）
git -c http.proxy=http://127.0.0.1:7897 push origin main --tags

# 安装到他人机器
dsh plugin --profile web add qwert702/dsh-memory
```

## 11. 关键设计决策记录（为什么这么做）

| 决策 | 理由 |
|---|---|
| JSON 而非 SQLite | 保住 Windows 零原生编译优势（对手的 better-sqlite3/sqlite-vec 是常见翻车点）；量级 ≤数千条足够 |
| bigram Jaccard 而非编辑距离 | O(n) 集合运算、CJK 友好 |
| 注入排序重要性而非关键词 | assemble 阶段拿不到消息文本；v2.0 用 recent 缓冲近似解决 |
| supersede 归档而非删除 | ≈Zep invalidation 思想，保留时间线可 undo |
| ADD 倾向 + 整理兜底 | Mem0 v3 同款哲学：过早合并毁时间线 |
| 手写 bundle 而非构建 | 与生态其他插件一致，免构建链 |
