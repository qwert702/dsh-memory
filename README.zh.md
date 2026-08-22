# dsh-memory

DeepSeek Harness 网页端**长期记忆插件**：项目记忆 + 全局记忆双库，自动提取、自动注入、小模型定期整理，外加一个 Obsidian 风格的记忆图谱。

> **一键安装：**
> ```
> dsh plugin --profile web add <仓库或本地路径>
> ```
> 例如本地路径：`dsh plugin --profile web add "D:\CBN-HT\Desktop\AI编程\dsh插件\dsh-memory(记忆插件）"`
> 装完重启 harness（`dsh web`）、刷新页面，会话头部「对话 / 轨迹」旁边会出现「**记忆**」标签页。

## 功能

- **双作用域记忆库**：
  - **项目记忆** —— 按会话工作区（cwd 哈希）分库，只在该项目的会话中注入；
  - **全局记忆** —— 跨项目共享，所有会话都注入。
  - 存储为纯 JSON（`~/.dsh/memory/global.json` + `projects/<hash>.json`，尊重 `$DSH_HOME`），原子写入。
- **记忆 Tab**（轨迹旁边的视图环插槽，纯增量、不替换任何原装组件）：
  - **列表视图** —— 一条一张卡片：类型色点（事实/偏好/决定/模式/实体）、内容、标签、来源与时间、强化次数、链接数；行内编辑、归档/恢复、删除；两步点击建链接；搜索框实时过滤；显示已归档开关。
  - **图谱视图** —— canvas 力导向图：节点=记忆（颜色=类型、半径=链接度）、边=关联；滚轮缩放、拖拽平移/拖节点、点选高亮邻域并显示详情卡；静止后渲染循环自动休眠。
- **自动注入** —— 监听 harness 的 `system-prompt/assemble` 瀑布，把按"新鲜度 × 强化 × 链接度"选出的 Top-K 记忆（全局/项目交替取，字符帽内）作为动态上下文追加进每个请求；无 cwd 的组装只带全局；任何异常都原样放行 assembly，绝不影响请求。
- **自动提取** —— 监听 `turn/end` 事件排队：把本轮新事件回放成文字记录，让模型输出 JSON 候选（每轮最多 5 条）；与现有记忆做字符 bigram Jaccard 近似去重（≥0.65 视为重复，只强化计数不重复入库）；连续失败 3 次暂停自动提取，手动「提取」成功即恢复。
- **定期整理** —— 每个作用域累计提取 N 轮（默认 20）后自动触发，或点「整理」手动触发：模型对清单提出 merge/link/archive/retag 操作流，host 校验 id 后事务式应用；Tab 状态栏展示上次整理结果与剩余轮次。

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
  extractProvider: ''           # 小模型路由（成对填写）
  extractModel: ''
  consolidateEveryTurns: 20     # 自动整理的提取轮次阈值（0 = 关闭自动整理）
  topK: 8                       # 注入条数上限
  maxInjectChars: 1500          # 注入总字符帽
  maxInputChars: 12000          # 提取回放字符上限
  maxTokens: 1024               # 辅助调用输出预算
```

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
