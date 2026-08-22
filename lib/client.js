window.__ModuleLoader__.load({
	id: "dsh-memory",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		//#region dsh-memory/styles.js
		// One style tag, hashed tag id, injected once per page — the same
		// mechanism the harness bundles use for CSS modules. All classes are
		// ours (dsh-mem- prefix); nothing depends on the harness's hashed class
		// names. Colors follow the harness alias tokens with safe fallbacks.
		const cssId = "@dsh-memory/Memory.module.css";
		const css = "" +
			".dsh-mem-root{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;padding:12px 16px;box-sizing:border-box;font-size:13px;color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".dsh-mem-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}" +
			".dsh-mem-spacer{flex:1}" +
			".dsh-mem-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;overflow:hidden}" +
			".dsh-mem-seg-btn{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);padding:3px 12px;font-size:12px;line-height:20px;cursor:pointer}" +
			".dsh-mem-seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}" +
			".dsh-mem-seg-btn.on{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.28));color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".dsh-mem-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-interactive-bg,transparent);border-radius:8px;padding:3px 12px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary,#9a9a9a);cursor:pointer;white-space:nowrap}" +
			".dsh-mem-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}" +
			".dsh-mem-btn[disabled]{opacity:.5;cursor:default}" +
			".dsh-mem-btn.primary{color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".dsh-mem-btn.danger:hover{color:var(--dsw-alias-label-danger,#ff6b6b);border-color:var(--dsw-alias-label-danger,#ff6b6b)}" +
			".dsh-mem-status{flex:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary,#9a9a9a)}" +
			".dsh-mem-status .warn{color:#f0b429}" +
			".dsh-mem-status .err{color:#ff6b6b}" +
			".dsh-mem-search{flex:0 1 220px;min-width:140px;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;padding:3px 10px;font-size:12px;line-height:20px;color:inherit;outline:none}" +
			".dsh-mem-search:focus{border-color:#4f8ef7}" +
			".dsh-mem-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;flex:1;min-height:0;padding-right:2px}" +
			".dsh-mem-row{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;padding:8px 10px;background:transparent}" +
			".dsh-mem-row.archived{opacity:.55}" +
			".dsh-mem-row.selected{border-color:#4f8ef7}" +
			".dsh-mem-row.linkTarget{cursor:pointer}" +
			".dsh-mem-row.linkTarget:hover{border-color:#9b59f0}" +
			".dsh-mem-dot{flex:none;width:9px;height:9px;border-radius:50%;margin-top:5px}" +
			".dsh-mem-main{flex:1;min-width:0}" +
			".dsh-mem-content{line-height:19px;white-space:pre-wrap;word-break:break-word}" +
			".dsh-mem-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#9a9a9a)}" +
			".dsh-mem-chip{border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:6px;padding:0 6px;line-height:16px}" +
			".dsh-mem-typechip{border-radius:6px;padding:0 6px;line-height:16px;color:#fff;opacity:.85}" +
			".dsh-mem-actions{display:flex;align-items:center;gap:4px;flex:none;opacity:.25;transition:opacity .15s}" +
			".dsh-mem-row:hover .dsh-mem-actions{opacity:1}" +
			".dsh-mem-act{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:11.5px;line-height:20px;padding:0 4px;cursor:pointer;white-space:nowrap}" +
			".dsh-mem-act:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}" +
			".dsh-mem-act.danger:hover{color:#ff6b6b}" +
			".dsh-mem-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#9a9a9a);text-align:center;line-height:20px;padding:24px}" +
			".dsh-mem-add{flex:none;display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:10px}" +
			".dsh-mem-add textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:52px;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;padding:6px 10px;font-size:12.5px;line-height:19px;color:inherit;font-family:inherit;outline:none}" +
			".dsh-mem-add textarea:focus{border-color:#4f8ef7}" +
			".dsh-mem-addrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}" +
			".dsh-mem-addrow input{flex:1;min-width:160px;background:transparent;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:8px;padding:3px 10px;font-size:12px;line-height:20px;color:inherit;outline:none}" +
			".dsh-mem-addlabel{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9a9a9a)}" +
			".dsh-mem-error{font-size:12px;line-height:18px;color:#ff6b6b;flex:none}" +
			".dsh-mem-graphwrap{position:relative;flex:1;min-height:0;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));border-radius:10px;overflow:hidden}" +
			".dsh-mem-canvas{position:absolute;inset:0;width:100%;height:100%;touch-action:none}" +
			".dsh-mem-legend{position:absolute;left:10px;top:8px;display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#9a9a9a);pointer-events:none}" +
			".dsh-mem-legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}" +
			".dsh-mem-detail{position:absolute;right:8px;top:8px;width:min(320px,80%);max-height:60%;overflow-y:auto;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:10px;padding:10px;background:rgba(20,20,20,.92)}" +
			".dsh-mem-detail h4{margin:0 0 4px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#9a9a9a)}" +
			".dsh-mem-detail p{margin:0;line-height:19px;white-space:pre-wrap;word-break:break-word}" +
			".dsh-mem-banner{flex:none;font-size:11.5px;line-height:18px;color:#9b59f0}";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-memory";
			tag.dataset.pluginCss = cssId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region dsh-memory/api.js
		/**
		 * Call one host route and unwrap its envelope.
		 * @param path - route path beginning /api/dsh-memory/.
		 * @param init - optional fetch init (method/body).
		 * @returns the parsed payload (throws on ok:false).
		 */
		async function api(path, init) {
			const response = await fetch(path, init);
			let data;
			try {
				data = await response.json();
			} catch {
				throw new Error("memory: invalid response");
			}
			if (data?.ok !== true) throw new Error(data?.error?.message ?? data?.error?.code ?? "memory: failed");
			return data;
		}

		/** List one scope's memories (project scope resolves via sessionId). */
		function fetchItems(sessionId, scope) {
			const qs = new URLSearchParams({ scope });
			if (scope === "project" && sessionId) qs.set("sessionId", sessionId);
			return api("/api/dsh-memory/items?" + qs.toString());
		}

		/** Graph projection of one scope. */
		function fetchGraph(sessionId, scope) {
			const qs = new URLSearchParams({ scope });
			if (scope === "project" && sessionId) qs.set("sessionId", sessionId);
			return api("/api/dsh-memory/graph?" + qs.toString());
		}

		/** Manual add. */
		function addItem(payload) {
			return api("/api/dsh-memory/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
		}

		/** Edit/archive one memory. */
		function updateItem(id, patch) {
			return api("/api/dsh-memory/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, patch }) });
		}

		/** Delete one memory. */
		function removeItem(id) {
			return api("/api/dsh-memory/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
		}

		/** Create/remove a symmetric link. */
		function setLink(a, b, linked) {
			return api(linked ? "/api/dsh-memory/link" : "/api/dsh-memory/unlink", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ a, b }),
			});
		}

		/** Manual consolidation for one scope. */
		function consolidate(sessionId, scope) {
			return api("/api/dsh-memory/consolidate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(scope === "global" ? { scope } : { scope, sessionId }),
			});
		}

		/** Manual extraction for the current session. */
		function extractNow(sessionId, force) {
			return api("/api/dsh-memory/extract", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionId, force: force === true }),
			});
		}

		/** Tab status line payload. */
		function fetchStatus() {
			return api("/api/dsh-memory/status");
		}
		//#endregion

		//#region dsh-memory/i18n.js
		const NS = "dsh-memory";
		const zh = {
			"view.memory": "记忆",
			"scope.project": "项目",
			"scope.global": "全局",
			"mode.list": "列表",
			"mode.graph": "图谱",
			add: "新增",
			organize: "整理",
			organizing: "整理中…",
			extractNow: "提取",
			extracting: "提取中…",
			search: "搜索记忆…",
			showArchived: "显示已归档",
			hideArchived: "隐藏已归档",
			archived: "已归档",
			edit: "编辑",
			save: "保存",
			cancel: "取消",
			remove: "删除",
			archive: "归档",
			restore: "恢复",
			link: "链接",
			linkBanner: "链接模式：再点一条记忆完成链接（Esc 取消）",
			empty: "暂无记忆。对话结束后会自动提取，或点「新增」手动添加。",
			emptySearch: "没有匹配的记忆。",
			noWorkspace: "当前会话没有工作区，项目记忆不可用；可切换到全局。",
			"type.fact": "事实",
			"type.preference": "偏好",
			"type.decision": "决定",
			"type.pattern": "模式",
			"type.entity": "实体",
			contentPlaceholder: "一句话记忆…例如：本项目使用 pnpm 作为包管理器",
			tagsPlaceholder: "标签（逗号分隔）",
			storeInto: "存入",
			lastConsolidated: "上次整理",
			appliedOps: "{n} 个操作",
			turnsLeft: "本库再提取 {n} 轮后自动整理",
			autoPaused: "自动提取已连续失败暂停，点「提取」重试成功后恢复",
			noRouteHint: "未配置小模型路由，提取/整理将跟随会话模型",
			lastError: "最近错误：{msg}",
			itemsCount: "{n} 条",
			graphEmpty: "暂无节点：先在列表视图添加记忆并建立链接。",
		};
		const en = {
			"view.memory": "Memory",
			"scope.project": "Project",
			"scope.global": "Global",
			"mode.list": "List",
			"mode.graph": "Graph",
			add: "Add",
			organize: "Organize",
			organizing: "Organizing…",
			extractNow: "Extract",
			extracting: "Extracting…",
			search: "Search memories…",
			showArchived: "Show archived",
			hideArchived: "Hide archived",
			archived: "archived",
			edit: "Edit",
			save: "Save",
			cancel: "Cancel",
			remove: "Delete",
			archive: "Archive",
			restore: "Restore",
			link: "Link",
			linkBanner: "Link mode: click another memory to finish the link (Esc cancels)",
			empty: "No memories yet. They are extracted automatically after each turn, or add one manually.",
			emptySearch: "No matching memories.",
			noWorkspace: "This session has no workspace, so project memory is unavailable; switch to Global.",
			"type.fact": "Fact",
			"type.preference": "Preference",
			"type.decision": "Decision",
			"type.pattern": "Pattern",
			"type.entity": "Entity",
			contentPlaceholder: "One-sentence memory… e.g. This repo uses pnpm as its package manager",
			tagsPlaceholder: "Tags (comma separated)",
			storeInto: "Store into",
			lastConsolidated: "Last organized",
			appliedOps: "{n} ops applied",
			turnsLeft: "{n} more extracted turns until auto-organization",
			autoPaused: "Auto-extraction paused after repeated failures; run Extract to recover",
			noRouteHint: "No small-model route configured; extraction follows the session model",
			lastError: "Last error: {msg}",
			itemsCount: "{n} items",
			graphEmpty: "No nodes yet: add memories in list view and link them.",
		};
		//#endregion

		//#region dsh-memory/util.js
		/** Node colors per memory type (mirrored by the legend). */
		const TYPE_COLORS = {
			fact: "#4f8ef7",
			preference: "#9b59f0",
			decision: "#f39c3d",
			pattern: "#2ecc71",
			entity: "#e74c8d",
		};
		const MEMORY_TYPES = Object.keys(TYPE_COLORS);

		/** Locale-neutral short relative time ("3m"/"5h"/"2d"). */
		function timeAgo(ts) {
			if (typeof ts !== "number" || !(ts > 0)) return "";
			const diff = Date.now() - ts;
			const minutes = Math.floor(diff / 60000);
			if (minutes < 1) return "<1m";
			if (minutes < 60) return minutes + "m";
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return hours + "h";
			const days = Math.floor(hours / 24);
			if (days < 30) return days + "d";
			return new Date(ts).toLocaleDateString();
		}

		/** Filter rows by the search box (content + tags substring match). */
		function matchesQuery(item, query) {
			const q = query.trim().toLowerCase();
			if (q === "") return true;
			if (item.content.toLowerCase().includes(q)) return true;
			return item.tags.some((tag) => tag.toLowerCase().includes(q));
		}
		//#endregion

		//#region dsh-memory/rows.js
		const ORIGIN_ICON = { auto: "✦", manual: "✎", consolidation: "⚙" };

		/**
		 * One memory row: type dot + content + tag/meta line + hover actions.
		 * Editing swaps the content for an inline textarea; link mode highlights
		 * candidate targets instead of navigating.
		 */
		const MemoryRow = react.memo(function MemoryRow({ item, t, editing, editText, setEditText, onStartEdit, onSaveEdit, onCancelEdit, onDelete, onToggleArchive, onLinkClick, linkSource, isSelected, onSelect }) {
			const isLinkTarget = linkSource != null && linkSource !== item.id;
			const className = "dsh-mem-row"
				+ (isLinkTarget ? " linkTarget" : "")
				+ (isSelected ? " selected" : "")
				+ (item.status === "archived" ? " archived" : "");
			return react_jsx_runtime.jsxs("div", {
				className,
				onClick: isLinkTarget ? () => onLinkClick(item.id) : undefined,
				children: [
					react_jsx_runtime.jsx("span", { className: "dsh-mem-dot", style: { background: TYPE_COLORS[item.type] ?? "#888" } }, "dot"),
					react_jsx_runtime.jsxs("div", { className: "dsh-mem-main", children: [
						editing === true
							? react_jsx_runtime.jsx("textarea", {
									value: editText,
									onChange: (e) => setEditText(e.target.value),
									rows: 2,
									autoFocus: true,
									style: { width: "100%", boxSizing: "border-box", background: "transparent", border: "1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))", borderRadius: 8, padding: "4px 8px", color: "inherit", font: "inherit", outline: "none" },
								}, "edit")
							: react_jsx_runtime.jsx("div", {
									className: "dsh-mem-content",
									onClick: isLinkTarget ? undefined : () => onSelect(item.id),
									children: item.content,
								}, "content"),
						react_jsx_runtime.jsxs("div", { className: "dsh-mem-meta", children: [
							react_jsx_runtime.jsx("span", { className: "dsh-mem-typechip", style: { background: TYPE_COLORS[item.type] ?? "#888" }, children: t("type." + item.type) }, "type"),
							item.status === "archived" && react_jsx_runtime.jsx("span", { className: "dsh-mem-chip", children: t("archived") }, "arch"),
							item.tags.map((tag) => react_jsx_runtime.jsx("span", { className: "dsh-mem-chip", children: tag }, "tag:" + tag)),
							react_jsx_runtime.jsx("span", { children: (ORIGIN_ICON[item.origin] ?? "•") + " " + timeAgo(item.updatedAt) }, "time"),
							item.useCount > 0 && react_jsx_runtime.jsx("span", { children: "×" + item.useCount }, "uses"),
							item.links.length > 0 && react_jsx_runtime.jsx("span", { children: "⧉ " + item.links.length }, "links"),
						] }, "meta"),
					] }, "main"),
					react_jsx_runtime.jsxs("div", { className: "dsh-mem-actions", children: [
						editing === true
							? [
								react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-act", onClick: onSaveEdit, children: t("save") }, "save"),
								react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-act", onClick: onCancelEdit, children: t("cancel") }, "cancel"),
							]
							: [
								react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-act" + (linkSource === item.id ? " on" : ""), title: t("link"), onClick: (e) => { e.stopPropagation(); onLinkClick(item.id); }, children: "⧉" }, "link"),
								react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-act", onClick: (e) => { e.stopPropagation(); onStartEdit(); }, children: t("edit") }, "edit"),
								react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-act", onClick: (e) => { e.stopPropagation(); onToggleArchive(); }, children: item.status === "archived" ? t("restore") : t("archive") }, "arch"),
								react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-act danger", onClick: (e) => { e.stopPropagation(); onDelete(); }, children: t("remove") }, "del"),
							],
					] }, "actions"),
				] }, item.id);
		});

		/** Inline add form under the toolbar. */
		function AddForm({ t, scope, canProject, busy, onSubmit, onCancel }) {
			const [content, setContent] = react.useState("");
			const [type, setType] = react.useState("fact");
			const [tags, setTags] = react.useState("");
			const submit = () => {
				const trimmed = content.trim();
				if (trimmed === "") return;
				onSubmit({
					content: trimmed,
					type,
					tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter((tag) => tag !== ""),
					scope,
				});
			};
			return react_jsx_runtime.jsxs("div", { className: "dsh-mem-add", children: [
				react_jsx_runtime.jsx("textarea", {
					value: content,
					placeholder: t("contentPlaceholder"),
					onChange: (e) => setContent(e.target.value),
					onKeyDown: (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(); },
					autoFocus: true,
				}, "content"),
				react_jsx_runtime.jsxs("div", { className: "dsh-mem-addrow", children: [
					react_jsx_runtime.jsx("select", {
						value: type,
						onChange: (e) => setType(e.target.value),
						style: { background: "transparent", color: "inherit", border: "1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35))", borderRadius: 8, padding: "3px 6px", fontSize: 12 },
						children: MEMORY_TYPES.map((entry) => react_jsx_runtime.jsx("option", { value: entry, style: { color: "#222" }, children: t("type." + entry) }, entry)),
					}, "typeSel"),
					react_jsx_runtime.jsx("input", { value: tags, placeholder: t("tagsPlaceholder"), onChange: (e) => setTags(e.target.value) }, "tags"),
				] }, "row1"),
				react_jsx_runtime.jsxs("div", { className: "dsh-mem-addrow", children: [
					react_jsx_runtime.jsxs("span", { className: "dsh-mem-addlabel", children: [t("storeInto"), ": ", scope === "global" ? t("scope.global") : t("scope.project")] }, "into"),
					react_jsx_runtime.jsx("span", { className: "dsh-mem-spacer" }, "sp"),
					react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-btn primary", disabled: busy !== "" || content.trim() === "" || (scope === "project" && !canProject), onClick: submit, children: t("save") }, "ok"),
					react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-btn", onClick: onCancel, children: t("cancel") }, "no"),
				] }, "row2"),
			] });
		}
		//#endregion

		//#region dsh-memory/graph.js
		/**
		 * Obsidian-style force-directed graph on a plain canvas: O(n²) repulsion
		 * (fine at memory-store scale), springs along links, mild centering, and
		 * a cooling alpha loop that parks when settled. Wheel zooms around the
		 * cursor; drag pans; dragging a node pins it while held; clicking a node
		 * selects it (parent highlights the neighborhood).
		 */
		function MemoryGraph({ graph, t, selectedId, onSelect }) {
			const wrapRef = react.useRef(null);
			const canvasRef = react.useRef(null);
			const stateRef = react.useRef({ nodes: [], byId: new Map(), alpha: 0, view: { k: 1, tx: 0, ty: 0 }, dragId: null, panning: false });
			const wakeRef = react.useRef(null);

			// Rebuild the particle set whenever the graph payload changes,
			// preserving existing positions so refreshes don't reshuffle.
			react.useEffect(() => {
				const state = stateRef.current;
				const previous = state.byId;
				const nodes = [];
				const byId = new Map();
				for (const node of graph.nodes) {
					const old = previous.get(node.id);
					const angle = (nodes.length / Math.max(graph.nodes.length, 1)) * Math.PI * 2;
					const entry = {
						id: node.id,
						label: node.label,
						type: node.type,
						radius: 7 + Math.min(node.degree, 8) * 1.4,
						x: old?.x ?? Math.cos(angle) * 120,
						y: old?.y ?? Math.sin(angle) * 120,
						vx: 0,
						vy: 0,
					};
					nodes.push(entry);
					byId.set(node.id, entry);
				}
				state.nodes = nodes;
				state.byId = byId;
				state.alpha = nodes.length > 0 ? 1 : 0;
			}, [graph]);

			// The simulation + render loop: runs while the layout is cooling or a
			// node is being dragged, then parks; interactions wake it through
			// wakeRef (set here so the two effects stay decoupled).
			react.useEffect(() => {
				const canvas = canvasRef.current;
				if (canvas === null) return;
				let raf = 0;
				let stopped = false;

				const resize = () => {
					const wrap = wrapRef.current;
					if (wrap === null || canvas === null) return;
					const dpr = window.devicePixelRatio || 1;
					canvas.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
					canvas.height = Math.max(1, Math.floor(wrap.clientHeight * dpr));
				};

				const tick = () => {
					raf = 0;
					if (stopped) return;
					const state = stateRef.current;
					const { nodes, byId } = state;

					// Forces (skip when settled).
					if (state.alpha > 0.005) {
						const repulse = 2600;
						for (let i = 0; i < nodes.length; i++) {
							const a = nodes[i];
							for (let j = i + 1; j < nodes.length; j++) {
								const b = nodes[j];
								let dx = a.x - b.x;
								let dy = a.y - b.y;
								let d2 = dx * dx + dy * dy;
								if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
								if (d2 > 90000) continue;
								const f = repulse / d2;
								const d = Math.sqrt(d2);
								a.vx += (dx / d) * f;
								a.vy += (dy / d) * f;
								b.vx -= (dx / d) * f;
								b.vy -= (dy / d) * f;
							}
							a.vx -= a.x * 0.0035;
							a.vy -= a.y * 0.0035;
						}
						for (const edge of graph.edges) {
							const a = byId.get(edge.a);
							const b = byId.get(edge.b);
							if (a === undefined || b === undefined) continue;
							const dx = b.x - a.x;
							const dy = b.y - a.y;
							const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01);
							const target = 150;
							const f = ((d - target) / d) * 0.02;
							a.vx += dx * f;
							a.vy += dy * f;
							b.vx -= dx * f;
							b.vy -= dy * f;
						}
						const damping = 0.86;
						for (const node of nodes) {
							if (state.dragId === node.id) { node.vx = 0; node.vy = 0; continue; }
							node.vx *= damping;
							node.vy *= damping;
							node.x += Math.max(-14, Math.min(14, node.vx));
							node.y += Math.max(-14, Math.min(14, node.vy));
						}
						state.alpha *= 0.985;
					}

					// Draw.
					const ctx = canvas.getContext("2d");
					if (ctx !== null) {
						const dpr = window.devicePixelRatio || 1;
						const { view } = state;
						ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
						ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
						ctx.translate(canvas.width / (2 * dpr) + view.tx, canvas.height / (2 * dpr) + view.ty);
						ctx.scale(view.k, view.k);

						const neighbors = new Set();
						if (selectedId != null) {
							neighbors.add(selectedId);
							for (const edge of graph.edges) {
								if (edge.a === selectedId) neighbors.add(edge.b);
								if (edge.b === selectedId) neighbors.add(edge.a);
							}
						}
						const hasSelection = neighbors.size > 0;
						ctx.lineWidth = 1 / view.k;
						for (const edge of graph.edges) {
							const a = byId.get(edge.a);
							const b = byId.get(edge.b);
							if (a === undefined || b === undefined) continue;
							const active = !hasSelection || neighbors.has(edge.a);
							ctx.strokeStyle = hasSelection && !active ? "rgba(128,128,128,.12)" : "rgba(128,128,128,.45)";
							ctx.beginPath();
							ctx.moveTo(a.x, a.y);
							ctx.lineTo(b.x, b.y);
							ctx.stroke();
						}
						for (const node of nodes) {
							const dimmed = hasSelection && !neighbors.has(node.id);
							ctx.globalAlpha = dimmed ? 0.25 : 1;
							ctx.fillStyle = TYPE_COLORS[node.type] ?? "#888";
							ctx.strokeStyle = node.id === selectedId ? "#ffffff" : "rgba(0,0,0,.35)";
							ctx.lineWidth = (node.id === selectedId ? 2.5 : 1) / view.k;
							ctx.beginPath();
							ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
							ctx.fill();
							ctx.stroke();
							if (view.k > 0.55) {
								ctx.fillStyle = "rgba(200,200,200,.92)";
								ctx.font = "10px system-ui,sans-serif";
								ctx.textAlign = "center";
								ctx.fillText(node.label, node.x, node.y + node.radius + 11);
							}
							ctx.globalAlpha = 1;
						}
					}

					if (state.alpha > 0.005 || state.dragId != null) {
						state.alpha *= 0.985;
						raf = requestAnimationFrame(tick);
					}
					// Settled and idle: stop the loop; interactions wake it via
					// wakeRef, which re-schedules tick.
				};

				resize();
				const onResize = () => { resize(); wakeRef.current?.(); };
				wakeRef.current = () => {
					if (!stopped && raf === 0) raf = requestAnimationFrame(tick);
				};
				window.addEventListener("resize", onResize);
				raf = requestAnimationFrame(tick);
				return () => {
					stopped = true;
					cancelAnimationFrame(raf);
					window.removeEventListener("resize", onResize);
					wakeRef.current = null;
				};
			}, [graph, selectedId]);

			// Interactions.
			react.useEffect(() => {
				const canvas = canvasRef.current;
				if (canvas === null) return;
				const toWorld = (event) => {
					const rect = canvas.getBoundingClientRect();
					const { view } = stateRef.current;
					return {
						x: (event.clientX - rect.left - rect.width / 2 - view.tx) / view.k,
						y: (event.clientY - rect.top - rect.height / 2 - view.ty) / view.k,
					};
				};
				const hitNode = (event) => {
					const point = toWorld(event);
					for (let index = stateRef.current.nodes.length - 1; index >= 0; index--) {
						const node = stateRef.current.nodes[index];
						const dx = node.x - point.x;
						const dy = node.y - point.y;
						if (dx * dx + dy * dy <= (node.radius + 4) * (node.radius + 4)) return node;
					}
					return null;
				};
				const wake = () => {
					stateRef.current.alpha = Math.max(stateRef.current.alpha, 0.02);
					wakeRef.current?.();
				};
				const onWheel = (event) => {
					event.preventDefault();
					const state = stateRef.current;
					const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
					state.view.k = Math.min(4, Math.max(0.25, state.view.k * factor));
					wake();
				};
				const onPointerDown = (event) => {
					const node = hitNode(event);
					const state = stateRef.current;
					if (node !== null) {
						state.dragId = node.id;
						state.moved = false;
					} else {
						state.panning = true;
						state.panX = event.clientX;
						state.panY = event.clientY;
					}
					canvas.setPointerCapture(event.pointerId);
				};
				const onPointerMove = (event) => {
					const state = stateRef.current;
					if (state.dragId != null) {
						const point = toWorld(event);
						const node = state.byId.get(state.dragId);
						if (node !== undefined) {
							node.x = point.x;
							node.y = point.y;
						}
						state.moved = true;
						wake();
					} else if (state.panning === true) {
						state.view.tx += event.clientX - state.panX;
						state.view.ty += event.clientY - state.panY;
						state.panX = event.clientX;
						state.panY = event.clientY;
						wake();
					}
				};
				const onPointerUp = (event) => {
					const state = stateRef.current;
					if (state.dragId != null && state.moved !== true && onSelect != null) onSelect(state.dragId);
					state.dragId = null;
					state.panning = false;
					try { canvas.releasePointerCapture(event.pointerId); } catch {}
				};
				canvas.addEventListener("wheel", onWheel, { passive: false });
				canvas.addEventListener("pointerdown", onPointerDown);
				canvas.addEventListener("pointermove", onPointerMove);
				canvas.addEventListener("pointerup", onPointerUp);
				return () => {
					canvas.removeEventListener("wheel", onWheel);
					canvas.removeEventListener("pointerdown", onPointerDown);
					canvas.removeEventListener("pointermove", onPointerMove);
					canvas.removeEventListener("pointerup", onPointerUp);
				};
			}, [onSelect]);

			const selectedNode = selectedId != null ? graph.nodes.find((node) => node.id === selectedId) : null;
			return react_jsx_runtime.jsxs("div", { className: "dsh-mem-graphwrap", ref: wrapRef, children: [
				react_jsx_runtime.jsx("canvas", { className: "dsh-mem-canvas", ref: canvasRef }, "cv"),
				react_jsx_runtime.jsx("div", { className: "dsh-mem-legend", children: MEMORY_TYPES.map((type) =>
					react_jsx_runtime.jsxs("span", { children: [react_jsx_runtime.jsx("i", { style: { background: TYPE_COLORS[type] } }), t("type." + type)] }, type)) }, "legend"),
				graph.nodes.length === 0 && react_jsx_runtime.jsx("div", { className: "dsh-mem-empty", style: { position: "absolute", inset: 0 }, children: t("graphEmpty") }, "empty"),
				selectedNode != null && react_jsx_runtime.jsxs("div", { className: "dsh-mem-detail", children: [
					react_jsx_runtime.jsx("h4", { children: t("type." + selectedNode.type) + (selectedNode.degree > 0 ? " · ⧉" + selectedNode.degree : "") }, "h"),
					react_jsx_runtime.jsx("p", { children: graph.fullContent?.get(selectedNode.id) ?? selectedNode.label }, "p"),
				] }, "detail"),
			] });
		}
		//#endregion

		//#region dsh-memory/view.js
		/**
		 * The Memory view tab: scope segments, list/graph mode toggle, search,
		 * add form, status line (consolidation cadence / pause / route hints),
		 * and the row list. All data comes from the host routes; sessionId
		 * resolves the project store server-side.
		 */
		const MemoryView = react.memo(function MemoryView({ t, sessionId: rawSessionId }) {
			const sessionId = typeof rawSessionId === "string" ? rawSessionId : "";
			const [scope, setScope] = react.useState("project");
			const [mode, setMode] = react.useState("list");
			const [items, setItems] = react.useState([]);
			const [resolved, setResolved] = react.useState(true);
			const [storeKey, setStoreKey] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [error, setError] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [showArchived, setShowArchived] = react.useState(false);
			const [addOpen, setAddOpen] = react.useState(false);
			const [editingId, setEditingId] = react.useState(null);
			const [editText, setEditText] = react.useState("");
			const [linkSource, setLinkSource] = react.useState(null);
			const [selectedNode, setSelectedNode] = react.useState(null);
			const [graphData, setGraphData] = react.useState({ nodes: [], edges: [] });
			const [statusInfo, setStatusInfo] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [toast, setToast] = react.useState("");

			const load = react.useCallback(async () => {
				if (sessionId === "" && scope === "project") { setResolved(false); setItems([]); return; }
				setLoading(true);
				try {
					const data = await fetchItems(sessionId, scope);
					setItems(data.items ?? []);
					setResolved(data.resolved !== false);
					setStoreKey(data.storeKey ?? null);
					setError("");
				} catch (caught) {
					setError(String(caught instanceof Error ? caught.message : caught));
				} finally {
					setLoading(false);
				}
			}, [sessionId, scope]);

			const loadGraph = react.useCallback(async () => {
				try {
					const data = await fetchGraph(sessionId, scope);
					setGraphData({ nodes: data.nodes ?? [], edges: data.edges ?? [] });
				} catch {}
			}, [sessionId, scope]);

			const refreshStatus = react.useCallback(async () => {
				try { setStatusInfo(await fetchStatus()); } catch {}
			}, []);

			react.useEffect(() => { void load(); }, [load]);
			react.useEffect(() => {
				if (mode !== "graph") return;
				void loadGraph();
			}, [mode, loadGraph]);
			react.useEffect(() => {
				void refreshStatus();
				const timer = setInterval(() => { void refreshStatus(); }, 25000);
				return () => clearInterval(timer);
			}, [refreshStatus]);

			// Esc cancels link mode.
			react.useEffect(() => {
				if (linkSource == null) return;
				const onKey = (event) => { if (event.key === "Escape") setLinkSource(null); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [linkSource]);

			const flashToast = (message) => {
				setToast(message);
				setTimeout(() => setToast(""), 4000);
			};

			const visible = items.filter((item) => (showArchived || item.status === "active") && matchesQuery(item, query))
				.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

			const handleAdd = async (payload) => {
				setBusy("add");
				try {
					await addItem({ ...payload, sessionId });
					setAddOpen(false);
					await load();
				} catch (caught) {
					setError(String(caught instanceof Error ? caught.message : caught));
				} finally {
					setBusy("");
				}
			};

			const startEdit = (item) => { setEditingId(item.id); setEditText(item.content); };
			const saveEdit = async () => {
				const id = editingId;
				setEditingId(null);
				try {
					await updateItem(id, { content: editText });
					await load();
				} catch (caught) { setError(String(caught instanceof Error ? caught.message : caught)); }
			};

			const handleUpdate = async (id, patch) => {
				try {
					await updateItem(id, patch);
					await load();
				} catch (caught) { setError(String(caught instanceof Error ? caught.message : caught)); }
			};

			const handleDelete = async (id) => {
				if (!window.confirm(t("remove") + "?")) return;
				try {
					await removeItem(id);
					if (selectedNode === id) setSelectedNode(null);
					await Promise.all([load(), mode === "graph" ? loadGraph() : Promise.resolve()]);
				} catch (caught) { setError(String(caught instanceof Error ? caught.message : caught)); }
			};

			const handleLinkClick = async (id) => {
				if (linkSource == null) { setLinkSource(id); return; }
				if (linkSource === id) { setLinkSource(null); return; }
				try {
					await setLink(linkSource, id, true);
					setLinkSource(null);
					await Promise.all([load(), mode === "graph" ? loadGraph() : Promise.resolve()]);
				} catch (caught) { setError(String(caught instanceof Error ? caught.message : caught)); }
			};

			const handleOrganize = async () => {
				setBusy("organize");
				setError("");
				try {
					const result = await consolidate(sessionId, scope);
					flashToast("⚙ " + t("appliedOps", { n: result.applied ?? 0 }));
					await Promise.all([load(), refreshStatus(), mode === "graph" ? loadGraph() : Promise.resolve()]);
				} catch (caught) {
					setError(String(caught instanceof Error ? caught.message : caught));
				} finally {
					setBusy("");
				}
			};

			const handleExtract = async () => {
				if (sessionId === "") return;
				setBusy("extract");
				setError("");
				try {
					const result = await extractNow(sessionId, true);
					flashToast("✦ +" + (result.added ?? 0));
					await Promise.all([load(), refreshStatus()]);
				} catch (caught) {
					setError(String(caught instanceof Error ? caught.message : caught));
				} finally {
					setBusy("");
				}
			};

			const canProject = resolved;
			const turnCount = statusInfo != null && storeKey != null ? statusInfo.turnCounts?.[storeKey] : undefined;
			const lastConsolidated = statusInfo != null && storeKey != null ? statusInfo.lastConsolidation?.[storeKey] : undefined;
			const graphPayload = react.useMemo(() => ({
				nodes: graphData.nodes,
				edges: graphData.edges,
				fullContent: new Map(items.map((item) => [item.id, item.content])),
			}), [graphData, items]);

			return react_jsx_runtime.jsxs("div", { className: "dsh-mem-root", "data-dsh-memory": true, children: [
				react_jsx_runtime.jsxs("div", { className: "dsh-mem-toolbar", children: [
					react_jsx_runtime.jsxs("div", { className: "dsh-mem-seg", children: [
						react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-seg-btn" + (scope === "project" ? " on" : ""), onClick: () => setScope("project"), children: t("scope.project") }, "proj"),
						react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-seg-btn" + (scope === "global" ? " on" : ""), onClick: () => setScope("global"), children: t("scope.global") }, "glob"),
					] }, "scope"),
					react_jsx_runtime.jsxs("div", { className: "dsh-mem-seg", children: [
						react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-seg-btn" + (mode === "list" ? " on" : ""), onClick: () => setMode("list"), children: t("mode.list") }, "list"),
						react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-seg-btn" + (mode === "graph" ? " on" : ""), onClick: () => setMode("graph"), children: t("mode.graph") }, "graph"),
					] }, "mode"),
					mode === "list" && react_jsx_runtime.jsx("input", { className: "dsh-mem-search", value: query, placeholder: t("search"), onChange: (e) => setQuery(e.target.value) }, "search"),
					mode === "list" && react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-btn" + (showArchived ? " on" : ""), onClick: () => setShowArchived((on) => !on), children: (showArchived ? "👁 " : "◌ ") + (showArchived ? t("hideArchived") : t("showArchived")) }, "archTgl"),
					react_jsx_runtime.jsx("span", { className: "dsh-mem-spacer" }, "sp"),
					react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-btn", disabled: busy !== "" || sessionId === "", title: t("extractNow"), onClick: handleExtract, children: busy === "extract" ? t("extracting") : "✦ " + t("extractNow") }, "extract"),
					react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-btn", disabled: busy !== "", onClick: handleOrganize, children: busy === "organize" ? t("organizing") : "⚙ " + t("organize") }, "org"),
					react_jsx_runtime.jsx("button", { type: "button", className: "dsh-mem-btn primary", disabled: scope === "project" && !canProject, onClick: () => setAddOpen((open) => !open), children: "+ " + t("add") }, "add"),
				] }, "toolbar"),

				react_jsx_runtime.jsxs("div", { className: "dsh-mem-status", children: [
					react_jsx_runtime.jsx("span", { children: t("itemsCount", { n: visible.length }) }, "count"),
					turnCount !== undefined && statusInfo?.consolidateEveryTurns > 0 && react_jsx_runtime.jsx("span", { children: t("turnsLeft", { n: Math.max(0, statusInfo.consolidateEveryTurns - turnCount) }) }, "turns"),
					lastConsolidated !== undefined && lastConsolidated != null && react_jsx_runtime.jsx("span", { children: t("lastConsolidated") + ": " + timeAgo(lastConsolidated.at) + " · ⚙" + lastConsolidated.applied }, "lastc"),
					toast !== "" && react_jsx_runtime.jsx("span", { children: toast }, "toast"),
					statusInfo?.paused === true && react_jsx_runtime.jsx("span", { className: "warn", children: "⚠ " + t("autoPaused") }, "paused"),
					statusInfo?.hasRoute !== true && react_jsx_runtime.jsx("span", { children: t("noRouteHint") }, "norr"),
					error !== "" && react_jsx_runtime.jsx("span", { className: "err", children: error }, "err"),
					scope === "project" && !canProject && react_jsx_runtime.jsx("span", { className: "warn", children: t("noWorkspace") }, "nows"),
				] }, "status"),

				linkSource != null && react_jsx_runtime.jsx("div", { className: "dsh-mem-banner", children: "⧉ " + t("linkBanner") }, "banner"),

				addOpen && react_jsx_runtime.jsx(AddForm, { t, scope, canProject, busy, onSubmit: handleAdd, onCancel: () => setAddOpen(false) }, "addform"),

				mode === "list"
					? visible.length > 0
						? react_jsx_runtime.jsx("div", { className: "dsh-mem-list", children: visible.map((item) =>
							react_jsx_runtime.jsx(MemoryRow, {
								item,
								t,
								editing: editingId === item.id,
								editText,
								setEditText,
								onStartEdit: () => startEdit(item),
								onSaveEdit: saveEdit,
								onCancelEdit: () => setEditingId(null),
								onDelete: () => handleDelete(item.id),
								onToggleArchive: () => handleUpdate(item.id, { status: item.status === "archived" ? "active" : "archived" }),
								onLinkClick: handleLinkClick,
								linkSource,
								isSelected: selectedNode === item.id,
								onSelect: () => setSelectedNode((current) => (current === item.id ? null : item.id)),
							}, item.id)) }, "rows")
						: react_jsx_runtime.jsx("div", { className: "dsh-mem-empty", children: query.trim() !== "" ? t("emptySearch") : t("empty") }, "empty")
					: react_jsx_runtime.jsx(MemoryGraph, {
							graph: graphPayload,
							t,
							selectedId: selectedNode,
							onSelect: setSelectedNode,
						}, "graph"),
			] });
		});
		//#endregion

		//#region dsh-memory/index.js
		/**
		 * Client plugin body: one additive entry on the `conversation.view` ring —
		 * the same seat that renders the Chat and Trajectory tabs — so the
		 * Memory tab lands beside Trajectory in every conversation's header
		 * strip. Nothing in the stock composition is replaced.
		 * @param ctx - client root context.
		 */
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-memory: dictionaries");
			const t = ctx.locale.bind(NS);
			const BoundView = (props) => react_jsx_runtime.jsx(MemoryView, { ...props, t });
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "memory",
				order: 11,
				locale: NS,
				label: () => t("view.memory"),
			}, BoundView));
		}
		//#endregion

		exports.MemoryView = MemoryView;
		exports.MemoryRow = MemoryRow;
		exports.MemoryGraph = MemoryGraph;
		exports.AddForm = AddForm;
		exports.fetchItems = fetchItems;
		exports.addItem = addItem;
		exports.updateItem = updateItem;
		exports.removeItem = removeItem;
		exports.setLink = setLink;
		exports.consolidate = consolidate;
		exports.extractNow = extractNow;
		exports.apply = apply;
		exports.inject = inject;




		return module.exports;
	}
});
