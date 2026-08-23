# dsh-memory

DeepSeek Harness 网页端**长期记忆插件**：项目记忆 + 全局记忆双库，自动提取、自动注入、小模型定期整理，外加一个 Obsidian 风格的记忆图谱。

> **一键安装：**
> ```
> dsh plugin --profile web add <仓库或本地路径>
> ```
> 例如本地路径：`dsh plugin --profile web add "D:\CBN-HT\Desktop\AI编程\dsh插件\dsh-memory(记忆插件）"`
> 装完重启 harness（`dsh web`）、刷新页面，会话头部「对话 / 轨迹」旁边会出现「**记忆**」标签页。

- **本地语义召回（可选增强）** —— 安装可选依赖后自动启用 `all-MiniLM-L6-v2` 本地嵌入（transformers.js 纯 WASM，无原生编译）：提取/新增的记忆自动向量化存入 sidecar，注入时按"语义相似度 × 词面重合 × 重要性"融合排序——**换说法也能召回**。未安装依赖或模型下载失败时自动回退纯关键词检索，状态在 Tab 状态栏可见。国内网络可用 `embeddingRemoteHost` 配置 hf-mirror 镜像。
- **整理时自动建链** —— 每次整理对余弦相似度 ≥ `autoLinkThreshold`（默认 0.78）且尚无关联的活跃记忆对自动补 related 双向边（单次上限 30 条），图谱随使用自然生长。
- **记忆详情与溯源** —— 列表中点击任意记忆展开详情卡：完整内容、类型/标签、创建与更新时间、强化次数；关联记忆可点击跳转；**「打开来源会话」一键跳回当初产生这条记忆的对话**。

## 功能

- **双作用域记忆库**：
  - **项目记忆** —— 按会话工作区（cwd 哈希）分库，只在该项目的会话中注入；
  - **全局记忆** —— 跨项目共享，所有会话都注入。
  - 存储为纯 JSON（`~/.dsh/memory/global.json` + `projects/<hash>.json`，尊重 `$DSH_HOME`），原子写入 + **跨进程文件锁**（headless/web 多实例并发安全）。
- **相关性召回** —— host 维护每个会话最近用户输入的滚动缓冲；注入时按"与当前对话的相关度 × 重要性"排序，问什么补什么，而不是盲目补最重要的。
- **记忆 Tab**（轨迹旁边的视图环插槽，纯增量、不替换任何原装组件）：
  - **列表视图** —— 一条一张卡片：类型色点、内容、标签、来源时间、强化次数、链接数；行内编辑（内容/类型/标签）、📌置顶、归档/恢复、删除；两步点击建链接（可选 related/supersedes/contradicts 关系）；搜索过滤；显示已归档开关；**撤销整理 / 导出 MD·JSON / 导入备份**。
  - **图谱视图** —— canvas 力导向图：节点=记忆（颜色=类型、半径=链接度）、边=关联；滚轮缩放、拖拽平移/拖节点、点选高亮邻域并显示详情卡；静止后渲染循环自动休眠。
- **自动注入** —— 监听 `system-prompt/assemble` 瀑布，把 Top-K 记忆作为动态上下文追加进每个请求；置顶记忆保底携带；无 cwd 的组装只带全局；任何异常都原样放行 assembly，绝不影响请求。
- **自动提取（v2 协议）** —— 监听 `turn/end` 排队提取；提示词携带既有相关记忆，模型对每条候选标注 `add/update/supersede/contradict` 动作：更新合并到原条目、取代时旧条目归档并建 supersedes 链、冲突时双向 contradicts 链共存；字面近似去重兜底；**子代理会话不参与提取**；连续失败 3 次暂停并弹全局通知；记忆语言跟随对话主语言（可强制 zh/en）。
- **定期整理** —— 每作用域累计 N 轮自动触发或手动触发：模型提 merge/link/archive/retag 操作流，host 校验后事务应用；**过期记忆按 autoArchiveDays 启发式自动归档**（不依赖模型）；每次模型整理前自动快照，Tab 内一键「↩ 撤销整理」。
- **多种记录入口**：
  - 斜杠命令 `/remember <一句话>`（存入当前项目/全局库）；
  - 每条 AI 回复旁的「✦ 记住」按钮（小模型提炼该消息要点入库）。

## 小模型路由

辅助调用（提取/整理）走 harness 的 `ctx.llm`，凭据不出服务器：

1. 设置里成对配置 `extractProvider` / `extractModel`（推荐配一个小模型）；
2. 未配置时跟随会话自身路由的模型（与 dsh-context-compressor 同一约定）；
3. 都没有时报错并在状态栏提示。

## 设置（可选）

在 `~/.dsh/settings.yaml` 添加命名空间 `dsh-memory`：

```yaml
dsh-memory:
  enabled: true                 # 总开关
  injectEnabled: true           # 自动注入开关
  autoExtract: true             # 自动提取开关
  extractProvider: ''           # 提取模型路由（成对填写；留空跟随会话模型）
  extractModel: ''
  manageProvider: ''            # 管理/整理专用模型（成对填写；留空则用提取模型）
  manageModel: ''
  consolidateEveryTurns: 20     # 自动整理的提取轮次阈值（0 = 关闭自动整理）
  topK: 8                       # 注入条数上限
  maxInjectChars: 1500          # 注入总字符帽
  maxInputChars: 12000          # 提取回放字符上限
  maxTokens: 1024               # 辅助调用输出预算
  autoArchiveDays: 90           # 过期自动归档天数（0 = 关闭）
  memoryLocale: ''              # 记忆语言：空=跟随对话，或强制 zh/en
  embeddingsEnabled: true       # 本地语义嵌入开关（需可选依赖，见下）
  embeddingRemoteHost: ''       # HuggingFace 镜像（国内推荐 https://hf-mirror.com）
  autoLinkThreshold: 0.78       # 整理时自动建链的余弦阈值（0 = 关闭）
```

**模型分工**：`extract*` 管高频的自动提取与「记住这条」提炼；`manage*` 管低频的记忆整理/归档。`manage*` 留空时回落到 `extract*`，再留空则跟随会话模型。典型用法：提取用便宜快的小模型，整理用更强的模型。

**启用语义召回（可选）**：在 harness 安装目录执行一次 `npm i @huggingface/transformers`，重启后首次使用自动下载 ~23MB 量化模型（国内可配 `embeddingRemoteHost: 'https://hf-mirror.com'` 加速）。不安装不影响其余功能——自动回退关键词检索。

以上设置也可在 harness 网页设置界面中直接修改（设置面板按 schema 自动生成，模型字段带说明文字）。

## 工作原理

```
turn/end ──▶ 提取队列 ──▶ 回放新增事件 ──▶ 小模型出 JSON ──▶ 去重 ──▶ 写库
                                              │
                                     累计 N 轮 ─┴──▶ 整理队列 ──▶ 小模型出 ops ──▶ 校验+应用
任何请求 ──▶ system-prompt/assemble 瀑布 ──▶ 选 Top-K ──▶ 追加 <memory-briefing> 上下文
浏览器「记忆」Tab ──▶ /api/dsh-memory/*（items/update/remove/link/unlink/graph/consolidate/extract/status）
```

## 仓库布局

- `lib/index.js` — host 半区：设置 + 监听器（注入/提取）+ 整理管线 + 9 条路由。
- `lib/store.js` — 双作用域 JSON 库（缓存 + 每文件串行锁 + 原子写）与持久化游标/计数。
- `lib/util.js` — 纯函数：作用域键、相似度、简报挑选、模型输出解析、回放构建。
- `lib/client.js` — 浏览器半区（手写 bundle）：`conversation.view` 增量条目（列表 + 图谱）。
- `test/smoke.cjs` — `node test/smoke.cjs`：纯函数断言、路由注册、注入监听器、提取/整管线（临时 DSH_HOME 隔离）、client 注册与 SSR。

## 已知限制

- 注入排序基于重要性而非当前问题关键词（assembly 阶段拿不到消息文本）；靠 topK + 字符帽控制体量。
- 自动整理需要可用的模型路由；未配置且会话未路由过时会失败并提示。
- 图谱布局为简单力导向（无社区着色等高级特性），数百节点内流畅。
- Windows 下项目键对路径做了大小写折叠，跨平台共享同一目录视为同一项目。

## License

MIT
