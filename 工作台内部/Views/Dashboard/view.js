/* ═══════════════════════════════════════════════════════════════════
   MyTask-OS · 工作台视图（工单 T04）
   变体 D 布局：页头问候+月历+速记条 → 2×2 四区卡 → 底部「未安排 | 已完成」折叠
   功能：六分区渲染 / 分区新增 / 勾选（含子任务 n/m）/ 拖拽引擎全量 /
        背景三档（玻璃→实卡→关）/ 隔夜归档清扫（基础版）

   翻译源：prototype/工作台UI原型.html（renderD / taskRow / subRow / zoneBody /
   zoneFoot / zoneCardHTML / calendarHTML / quickcap / 拖拽引擎
   dragVal+dropSpec+computeSpec+executeDrop / accOpen / collapsed / bgmode）。
   按 Obsidian 环境适配（SPEC §3、§4、§5.2）：
   - 作用域：只控制 dv.container；状态类挂在根元素 .pos-dash，样式/查询不出容器
   - 命名空间：全部类名加 pos- 前缀，避免与主题通用类（.card/.task/.zone/.cb）冲突
   - 数据层：工作台内部/Services/task-service.js（new Function 工厂 + vault adapter io）
   - 会话事实源：内存 state；每次变更后 saveZone 入队写盘，再本地重渲染
   - 页面每次执行（打开/切回/Dataview 自动刷新重跑）先 loadAll 重读文件（手编即生效），
     再清扫、再首渲染；页内重渲染（root.innerHTML 重建）不重跑清扫
   - UI 状态：accOpen / collapsed / 月历月份存 window 级会话缓存（Dataview 自动刷新
     会重跑本模块，跨执行不丢）；collapsed 以「分区+任务文字」签名为键（T05 修补）——
     内存 id 每次重读文件都会重新生成，不能作跨执行键；bgmode 存 localStorage
   - 背景图：app.vault.adapter.getResourcePath 取 app:// URL，禁止 CSS 相对路径
   ═══════════════════════════════════════════════════════════════════ */
(async () => {
    "use strict";

    /* ── 常量 ─────────────────────────────────────────────────────── */

    /* 项目根自定位特征文件：工作台.md 无论放在 Vault 哪一层（含被拷入主 Vault
       当子文件夹），启动时在 Vault 内反查此文件，定位项目根。 */
    const ANCHOR_FILE = "工作台内部/Services/task-service.js";
    const BG_MODES = ["glass", "solid", "none"];                    // 玻璃 → 实卡 → 关
    const BG_NAMES = { glass: "玻璃", solid: "实卡", none: "关" };
    const BG_STORAGE_KEY = "mytaskos-bgmode";

    /* ── 纯工具 ───────────────────────────────────────────────────── */

    const esc = s => String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");

    const pad2 = n => String(n).padStart(2, "0");
    const fmtDate = d => d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    const TODAY = fmtDate(new Date());

    /** 问候语按时段（SPEC §3.1：夜深了/早上好/下午好/晚上好） */
    function greeting() {
        const hour = new Date().getHours();
        return hour < 6 ? "夜深了" : hour < 12 ? "早上好" : hour < 18 ? "下午好" : "晚上好";
    }

    function readBgmode() {
        try {
            const v = localStorage.getItem(BG_STORAGE_KEY);
            return BG_MODES.includes(v) ? v : "glass";
        } catch (_) { return "glass"; }
    }
    function writeBgmode(v) {
        try { localStorage.setItem(BG_STORAGE_KEY, v); } catch (_) { /* 隐私模式等：忽略 */ }
    }

    /** 事件目标兜底取最近祖先（e.target 偶可为非元素节点） */
    const closestEl = (target, selector) =>
        (target && typeof target.closest === "function") ? target.closest(selector) : null;

    /* ── 模块级可变状态（本页面每次执行重置；UI 状态走 window 会话缓存） ── */

    let svc = null;         // task-service 工厂实例
    let state = null;       // { zones: { today, temp, near, long, someday, done } }，会话内事实源
    let root = null;        // .pos-dash 根元素（本执行内持久；重渲染只重建其 innerHTML）
    let heroUrl = "";       // 背景图 app:// URL
    let bgmode = "glass";   // 背景三档（localStorage 记忆）
    let dragVal = null;     // 当前拖拽项："taskId" 或 "taskId/subId"（原型 dragVal）
    let dropSpec = null;    // dragover 实时计算的落点（原型 dropSpec）

    /**
     * UI 会话缓存：Dataview refreshEnabled（默认开，2500ms）会在索引变更
     * （含本视图自己的写盘）后重跑本模块，因此把「渲染重建不丢」的状态
     * 放在 window 级缓存，跨执行保留。同仓多开工作台窗格时共享，可接受。
     */
    const UI = window.__mytaskOsDashboardUi || (window.__mytaskOsDashboardUi = {
        accOpen: new Set(),   // 底部折叠区当前展开的分区（拖入 someday/done 自动展开）
        collapsed: new Set(), // 被折叠的子任务列表（键 = foldKey 签名，跨执行稳定）
        cal: null             // 月历当前月 {y, m}；null = 跟随真实当月
    });
    const accOpen = UI.accOpen;
    const collapsed = UI.collapsed;

    /**
     * 折叠记忆键（T05 修补，跨执行稳定）：分区 id + 任务文字。
     * 任务内存 id 在每次 loadAll 重读时都会重新生成，若以 id 为折叠键，
     * Dataview 自动刷新重跑本模块后折叠状态会全部丢失（违背 SPEC §5.3 跨渲染记忆、
     * 工单 05「不因新增任务等操作重置」——写盘即触发重跑）。
     * 文字在会话内不可变（无重命名入口）故可作键；同分区同名重复行会一起折叠，
     * 属纯 UI 状态的取舍，数据操作（勾选/拖拽）仍按内存 id 互不干扰（SPEC §2.2）。
     */
    const foldKey = (zoneId, task) => zoneId + "\u0001" + task.text;

    /* ── 数据定位（翻译自原型 findTask / targetInfo / detachDragged） ── */

    function findTask(id) {
        for (const zid of Object.keys(state.zones)) {
            const task = (state.zones[zid] || []).find(x => x.id === id);
            if (task) return { task, zone: zid };
        }
        return null;
    }

    /** dragId（"taskId" 或 "taskId/subId"）→ 行信息；重复文字行按内存 id 互不干扰 */
    function targetInfo(dragId) {
        const slash = dragId.indexOf("/");
        if (slash < 0) {
            const hit = findTask(dragId);
            if (!hit) return null;
            return { kind: "task", zone: hit.zone, task: hit.task, index: state.zones[hit.zone].indexOf(hit.task) };
        }
        const pid = dragId.slice(0, slash);
        const sid = dragId.slice(slash + 1);
        const hit = findTask(pid);
        if (!hit) return null;
        const idx = hit.task.subs.findIndex(s => s.id === sid);
        if (idx < 0) return null;
        return { kind: "sub", zone: hit.zone, parent: hit.task, index: idx };
    }

    /** 把被拖拽项从原位置摘除（先删）；返回原列表引用与原下标供索引补偿 */
    function detachDragged(val) {
        const slash = val.indexOf("/");
        if (slash < 0) {
            const hit = findTask(val);
            const fromList = state.zones[hit.zone];
            const fromIndex = fromList.indexOf(hit.task);
            fromList.splice(fromIndex, 1);
            return { obj: hit.task, fromList, fromIndex };
        }
        const pid = val.slice(0, slash);
        const sid = val.slice(slash + 1);
        const hit = findTask(pid);
        const fromList = hit.task.subs;
        const fromIndex = fromList.findIndex(s => s.id === sid);
        const [sub] = fromList.splice(fromIndex, 1);
        return { obj: sub, fromList, fromIndex };
    }

    /** 升为顶级（拖父任务 = 整棵子树一起走，保留 subs 引用） */
    const asTop = o => ({ id: o.id, text: o.text, done: !!o.done, doneDate: (o.doneDate ?? null), subs: (o.subs || []) });
    /** 降为子任务（无 subs 字段；自带子任务由调用方拍平为同级） */
    const asSub = o => ({ id: o.id, text: o.text, done: !!o.done, doneDate: (o.doneDate ?? null) });

    function newTask(text) {
        return { id: svc.taskId(), text, done: false, doneDate: null, subs: [] };
    }

    const zoneById = id => svc.ZONES.find(z => z.id === id) || { id, name: id };
    const zoneName = id => zoneById(id).name;

    /* ── 写盘：变更过的分区入队整文件重写；失败提示不阻塞 ── */

    function commit(zoneIds) {
        for (const zid of new Set(zoneIds)) {
            if (!zid || !state.zones[zid]) continue;
            svc.saveZone(zid, state.zones[zid]).catch(err => {
                console.error("[MyTask-OS] 分区写盘失败：" + zid, err);
                toast("保存失败：「" + zoneName(zid) + "」写入出错");
            });
        }
    }

    /* ── 渲染片段（翻译自原型 taskRow / subRow / zoneBody / zoneFoot / zoneCardHTML） ── */

    /**
     * 顶级任务行：caret（▼折叠）+ 复选框 + 标题 + n/m 进度签 + ✅ 日期 + ＋子任务。
     * 计数/进度只按数据本身；已完成区复选框锁定（只进不出）。
     */
    function taskRow(task, zoneId) {
        const inDone = zoneId === "done";
        const cb = (inDone && task.done)
            ? '<span class="pos-cb pos-locked pos-on" title="已完成区只进不出 · 拖出即复活"></span>'
            : '<span class="pos-cb' + (task.done ? " pos-on" : "") + '" data-check="' + esc(task.id) + '" title="' + (task.done ? "点此取消完成" : "标记完成") + '"></span>';
        const date = task.done && task.doneDate
            ? '<span class="pos-td-date" title="完成于 ' + esc(task.doneDate) + '">✅ ' + (inDone ? esc(task.doneDate) : esc(task.doneDate.slice(5))) + "</span>"
            : "";
        const prog = (task.subs.length && !task.done)
            ? '<span class="pos-prog">' + task.subs.filter(s => s.done).length + "/" + task.subs.length + "</span>"
            : "";
        const caret = task.subs.length
            ? '<span class="pos-caret" data-fold="' + esc(task.id) + '">' + (collapsed.has(foldKey(zoneId, task)) ? "▶" : "▼") + "</span>"
            : "";
        const plus = '<span class="pos-subplus" data-addsub="' + esc(task.id) + '" title="添加子任务">＋子任务</span>';
        const del = '<span class="pos-del" data-deltask="' + esc(task.id) + '" title="删除任务">×</span>';
        let html = '<div class="pos-task' + (task.done ? " pos-done" : "") + '" draggable="true" data-drag="' + esc(task.id) + '">'
            + caret + cb + '<span class="pos-tx">' + esc(task.text) + "</span>" + prog + date + plus + del + "</div>";
        if (task.subs.length && !collapsed.has(foldKey(zoneId, task))) {
            html += '<div class="pos-subs">' + task.subs.map(s => subRow(task, s, inDone)).join("") + "</div>";
        }
        return html;
    }

    /** 子任务行：独立复选框 + ✅ 日期；可拖拽（兄弟排序 / 跨区升级） */
    function subRow(task, sub, inDone) {
        const cb = '<span class="pos-cb pos-sm' + (sub.done ? " pos-on" : "") + '" data-checksub="' + esc(task.id + "/" + sub.id) + '" title="' + (sub.done ? "点此取消完成" : "标记完成") + '"></span>';
        const date = sub.done && sub.doneDate
            ? '<span class="pos-td-date" title="完成于 ' + esc(sub.doneDate) + '">✅ ' + (inDone ? esc(sub.doneDate) : esc(sub.doneDate.slice(5))) + "</span>"
            : "";
        return '<div class="pos-task pos-sub' + (sub.done ? " pos-done" : "") + '" draggable="true" data-drag="' + esc(task.id + "/" + sub.id) + '">'
            + cb + '<span class="pos-tx">' + esc(sub.text) + "</span>" + date
            + '<span class="pos-del pos-del-sm" data-delsub="' + esc(task.id + "/" + sub.id) + '" title="删除子任务">×</span>' + "</div>";
    }

    /** 分区列表体：空状态文案（已完成区专属文案）；data-zone 供拖拽空白落点 */
    function zoneBodyHTML(zoneId) {
        const list = state.zones[zoneId] || [];
        const inner = list.length
            ? list.map(x => taskRow(x, zoneId)).join("")
            : '<div class="pos-empty">' + (zoneId === "done" ? "还没有完成的任务" : "拖任务到这里，或点下方新增") + "</div>";
        return '<div class="pos-zone-body pos-zone-drop" data-zone="' + zoneId + '">' + inner + "</div>";
    }

    /** 分区脚：已完成区无新增按钮，改「隔夜归档区 · 拖出可复活」提示（SPEC §3.2） */
    function zoneFootHTML(zoneId) {
        if (zoneId === "done") {
            return '<div class="pos-zone-foot pos-arch-hint">隔夜归档区 · 拖出可复活</div>';
        }
        return '<div class="pos-zone-foot"><button class="pos-add-btn" data-add="' + zoneId + '">＋ 新增任务</button></div>';
    }

    /** 2×2 上区分区卡（计数只算顶级）；卡元素本身也带 data-zone（标题/空白可落） */
    function zoneCardHTML(zone) {
        const list = state.zones[zone.id] || [];
        return '<div class="pos-card pos-zone" data-zone="' + zone.id + '">'
            + '<div class="pos-zone-head"><span class="pos-dot"></span>' + esc(zone.name)
            + '<span class="pos-cnt">' + list.length + "</span></div>"
            + zoneBodyHTML(zone.id) + zoneFootHTML(zone.id) + "</div>";
    }

    /** 底部折叠条（未安排 | 已完成）：open 类由 accOpen 集合驱动，跨渲染记忆 */
    function accHTML(zoneId) {
        const zone = zoneById(zoneId);
        const list = state.zones[zoneId] || [];
        const inner = list.length
            ? list.map(x => taskRow(x, zoneId)).join("")
            : '<div class="pos-empty pos-empty-inset">' + (zoneId === "done" ? "还没有完成的任务" : "拖任务到这里，或点下方新增") + "</div>";
        return '<div class="pos-vd-acc' + (accOpen.has(zoneId) ? " pos-open" : "") + '" data-vdacc="' + zoneId + '" data-zone="' + zoneId + '">'
            + '<div class="pos-vd-acc-head" data-vdacc-toggle="' + zoneId + '"><span class="pos-arrow">▶</span>' + esc(zone.name)
            + '<span class="pos-cnt">' + list.length + "</span></div>"
            + '<div class="pos-vd-acc-body pos-zone-drop" data-zone="' + zoneId + '">' + inner + zoneFootHTML(zoneId) + "</div></div>";
    }

    /** 紧凑月历：周一起始、今天高亮、‹ › 翻月；纯展示不含任务数据（SPEC §3.1） */
    function calendarHTML() {
        const now = new Date();
        if (!UI.cal) UI.cal = { y: now.getFullYear(), m: now.getMonth() };
        const y = UI.cal.y;
        const m = UI.cal.m;
        const offset = (new Date(y, m, 1).getDay() + 6) % 7;   // 周一开头
        const days = new Date(y, m + 1, 0).getDate();
        let cells = "";
        for (const w of ["一", "二", "三", "四", "五", "六", "日"]) cells += '<span class="pos-wd">' + w + "</span>";
        for (let i = 0; i < offset; i++) cells += '<span class="pos-day pos-dim"></span>';
        for (let d = 1; d <= days; d++) {
            const isToday = y === now.getFullYear() && m === now.getMonth() && d === now.getDate();
            cells += '<span class="pos-day' + (isToday ? " pos-day-now" : "") + '">' + d + "</span>";
        }
        return '<div class="pos-cal-head">' + (y + " 年 " + (m + 1) + " 月")
            + '<span class="pos-cal-nav">'
            + '<button data-cal="prev" title="上个月">‹</button>'
            + '<button data-cal="next" title="下个月">›</button>'
            + '<button class="pos-bg-btn" data-bgtoggle title="背景模式：玻璃 → 实卡 → 关（当前：' + BG_NAMES[bgmode] + '）">' + BG_NAMES[bgmode] + "</button>"
            + "</span></div>"
            + '<div class="pos-cal-grid">' + cells + "</div>";
    }

    /** 变体 D 全量布局（翻译自原型 renderD） */
    function layoutHTML() {
        const top4 = ["today", "temp", "near", "long"].map(id => zoneCardHTML(zoneById(id))).join("");
        return '<div class="pos-vd">'
            + '<div class="pos-vd-top"><div class="pos-vd-greet"><h1>' + greeting() + "</h1>"
            + '<div class="pos-vd-sub">' + TODAY + " · 今天只有一件事也值得认真对待</div></div>"
            + '<div class="pos-card pos-cal">' + calendarHTML() + "</div></div>"
            + '<div class="pos-quickcap"><input data-capto="someday" placeholder="想到什么先丢进来…（Enter 记为未安排）">'
            + '<button class="pos-cap-go" data-cap>速记</button></div>'
            + '<div class="pos-vd-grid">' + top4 + "</div>"
            + '<div class="pos-vd-bottom">' + accHTML("someday") + accHTML("done") + "</div>"
            + "</div>"
            + '<div class="pos-bg-img"></div><div class="pos-bg-overlay"></div>'
            + '<div class="pos-toast"></div>';
    }

    /** 本地重渲染：只重建 root.innerHTML（dv.view 注入的 <style> 与 root 上的状态类不受影响） */
    function render() {
        root.innerHTML = layoutHTML();
        const bgEl = root.querySelector(".pos-bg-img");
        if (bgEl && heroUrl) bgEl.style.backgroundImage = 'url("' + heroUrl + '")';
    }

    /* ── 操作逻辑（勾选 / 速记 / 清扫） ───────────────────────────── */

    /** 勾选顶级任务：✅ 当天 / 取消剥离 ✅；父任务手动，不随子任务自动（SPEC §3.3） */
    function toggleTask(id) {
        const hit = findTask(id);
        if (!hit) return;
        if (!hit.task.done) { hit.task.done = true; hit.task.doneDate = TODAY; }
        else { hit.task.done = false; hit.task.doneDate = null; }
        commit([hit.zone]);
        render();
    }

    /** 子任务独立勾选（带自己的 ✅） */
    function toggleSub(val) {
        const slash = val.indexOf("/");
        if (slash < 0) return;
        const hit = findTask(val.slice(0, slash));
        if (!hit) return;
        const sub = hit.task.subs.find(s => s.id === val.slice(slash + 1));
        if (!sub) return;
        if (!sub.done) { sub.done = true; sub.doneDate = TODAY; }
        else { sub.done = false; sub.doneDate = null; }
        commit([hit.zone]);
        render();
    }

    /** 删除顶级任务（连同其整棵子树），直接写盘；不可恢复 */
    function deleteTask(id) {
        const hit = findTask(id);
        if (!hit) return;
        const list = state.zones[hit.zone];
        const idx = list.indexOf(hit.task);
        if (idx < 0) return;
        list.splice(idx, 1);
        collapsed.delete(foldKey(hit.zone, hit.task));   // 折叠记忆键随任务一并清掉
        commit([hit.zone]);
        render();
        toast("已删除任务");
    }

    /** 删除单个子任务，直接写盘；不可恢复 */
    function deleteSub(val) {
        const slash = val.indexOf("/");
        if (slash < 0) return;
        const hit = findTask(val.slice(0, slash));
        if (!hit) return;
        const sid = val.slice(slash + 1);
        const idx = hit.task.subs.findIndex(s => s.id === sid);
        if (idx < 0) return;
        hit.task.subs.splice(idx, 1);
        commit([hit.zone]);
        render();
        toast("已删除子任务");
    }

    /** 应用重命名：改内存态 → 写盘 → 重渲染；折叠键随文字迁移（保住折叠状态） */
    function applyRename(dragId, newText) {
        const slash = dragId.indexOf("/");
        if (slash < 0) {
            const hit = findTask(dragId);
            if (!hit) { render(); return; }
            const oldKey = foldKey(hit.zone, hit.task);
            const wasFolded = collapsed.has(oldKey);
            hit.task.text = newText;
            if (wasFolded) { collapsed.delete(oldKey); collapsed.add(foldKey(hit.zone, hit.task)); }
            commit([hit.zone]);
            render();
            toast("已重命名");
            return;
        }
        const hit = findTask(dragId.slice(0, slash));
        if (!hit) { render(); return; }
        const sub = hit.task.subs.find(s => s.id === dragId.slice(slash + 1));
        if (!sub) { render(); return; }
        sub.text = newText;
        commit([hit.zone]);
        render();
        toast("已重命名子任务");
    }

    /** 双击文字进入行内编辑：把 .pos-tx 原位换成输入框（不改内存态）。
     *  Enter / 失焦 = 确认（空文字或未改动则视为取消）；Esc = 撤销。 */
    function startRename(txSpan, dragId) {
        const slash = dragId.indexOf("/");
        const hit = findTask(slash < 0 ? dragId : dragId.slice(0, slash));
        if (!hit) return;
        const sub = slash < 0 ? null : (hit.task.subs.find(s => s.id === dragId.slice(slash + 1)) || null);
        if (slash >= 0 && !sub) return;
        const current = sub ? sub.text : hit.task.text;

        const input = document.createElement("input");
        input.className = "pos-rename-input";
        input.value = current;
        input.setAttribute("draggable", "false");   // 编辑态禁用行拖拽
        let finished = false;
        const finish = text => {
            if (finished) return;
            finished = true;
            if (text && text !== current) applyRename(dragId, text);
            else render();
        };
        input.onkeydown = ev => {
            if (ev.key === "Enter") { ev.preventDefault(); finish(input.value.trim()); }
            else if (ev.key === "Escape") { finished = true; render(); }
        };
        input.onblur = () => finish(input.value.trim());
        txSpan.replaceWith(input);
        input.focus();
        if (typeof input.select === "function") input.select();
    }

    /** 速记条：Enter / 按钮 → 追加到未安排末尾 + toast（SPEC §3.1） */
    function quickcapSubmit() {
        const qc = root.querySelector("[data-capto]");
        if (!qc) return;
        const to = qc.dataset.capto || "someday";
        const text = qc.value.trim();
        if (!text) return;
        state.zones[to].push(newTask(text));
        commit([to]);
        render();
        toast("已速记到「" + zoneName(to) + "」");
    }

    /**
     * 隔夜归档清扫（基础版，SPEC §3.5）：所有分区中「已勾选 且 ✅ 日期 < 今天」的
     * 顶级任务（含其子树）移入已完成顶部；算法幂等；变更过的分区写盘；
     * 返回移动条数（0 条不 toast —— 当天重复执行无副作用则不重复报数）。
     */
    function runSweep() {
        const allGo = [];
        const dirty = [];
        for (const zone of svc.ZONES) {
            if (zone.id === "done") continue;
            const list = state.zones[zone.id] || [];
            const keep = [];
            const go = [];
            for (const t of list) {
                (t.done && t.doneDate && t.doneDate < TODAY ? go : keep).push(t);
            }
            if (go.length) {
                state.zones[zone.id] = keep;
                dirty.push(zone.id);
                allGo.push(...go);
            }
        }
        if (!allGo.length) return 0;
        state.zones.done = allGo.concat(state.zones.done || []);   // 插顶部（最新完成的在最上面）
        dirty.push("done");
        commit(dirty);
        return allGo.length;
    }

    /* ── 拖拽引擎（翻译自原型 clearDropFx / computeSpec / executeDrop / wireDndOnce） ──
       落点三段式（SPEC §3.4）：任务行上 30% 前插 / 下 30% 后插 / 中间 50% 嵌为子任务；
       子任务行上/下半 = 兄弟排序；行外落点（分区标题/折叠条/空白/底部）=
       已完成区插顶部，其余分区追加末尾。 */

    function clearDropFx() {
        root.querySelectorAll(".pos-over, .pos-ins-before, .pos-ins-after, .pos-nest-ok")
            .forEach(el => el.classList.remove("pos-over", "pos-ins-before", "pos-ins-after", "pos-nest-ok"));
    }

    /**
     * 由悬停行 + 鼠标位置算落点。返回 null = 该行不可落（随后 dragover 会回退到
     * 分区级落点，与原型一致）；返回 {deny:true} = 整行禁放（dragover 不回退分区
     * 落点、不挂任何反馈类，真实浏览器中不 preventDefault 即显示禁止光标）。
     * 防环三条（T06）：拖到自己（悬停拖拽项自身前置拦截 + 行内防御）、顶级任务
     * 拖入自己的子任务列表（拒绝 → 回退分区落点）、子任务拖回自己的父任务行
     * （禁放 → 松手无操作，绝不把该子任务意外升级为顶级）。
     */
    function computeSpec(row, e) {
        const t = targetInfo(row.dataset.drag);
        if (!t) return null;
        const rect = row.getBoundingClientRect();
        const rel = (e.clientY - rect.top) / Math.max(rect.height, 1);
        const slash = dragVal.indexOf("/");
        if (t.kind === "sub") {
            if (dragVal === row.dataset.drag) return null;                  // 拖到自己
            if (slash < 0 && dragVal === t.parent.id) return null;          // 顶级任务不能进自己的子任务列表
            return {
                spec: { type: "sub", parentId: t.parent.id, index: t.index + (rel < .5 ? 0 : 1) },
                fx: rel < .5 ? "pos-ins-before" : "pos-ins-after",
                row
            };
        }
        if (slash < 0) {
            if (dragVal === t.task.id) return null;                         // 拖到自己
        } else if (t.task.id === dragVal.slice(0, slash)) {
            return { deny: true };   // 子任务拖回自己父任务行 = 整行禁放（无操作，T06）
        }
        if (rel < .3) return { spec: { type: "zone", zone: t.zone, index: t.index }, fx: "pos-ins-before", row };
        if (rel > .7) return { spec: { type: "zone", zone: t.zone, index: t.index + 1 }, fx: "pos-ins-after", row };
        // 中段 = 嵌套：目标必为顶级任务（子任务行走上方分支），不可能落在被拖项
        // 自己的子树内（自己的子任务行 kind="sub"），天然防环，无需额外判定。
        return { spec: { type: "nest", parentId: t.task.id }, fx: "pos-nest-ok", row };
    }

    /**
     * 执行落点：改内存态 → 变更分区入队写盘 → 本地重渲染。
     * 拖入已完成 = 未勾选则立即视为今天完成（自动勾选 + ✅ 今天）并展开该区；
     * 拖出已完成（任意分区落点）= 复活剥离 ✅；已完成区内重排保持 ✅ 日期不变；
     * 嵌为子任务时自带子任务拍平为同级（一级嵌套原则）。
     */
    function executeDrop(val, spec) {
        if (!val || !spec) return;
        if (spec.type === "zone") {
            const from = targetInfo(val);
            if (!from) return;
            const fromZone = from.zone;
            const { obj, fromList, fromIndex } = detachDragged(val);
            const task = asTop(obj);
            if (spec.zone === "done") {
                if (!task.done) { task.done = true; task.doneDate = TODAY; }   // 拖入 = 今天完成
            } else if (task.done) {
                task.done = false; task.doneDate = null;                       // 拖出 = 复活
            }
            const list = state.zones[spec.zone];
            let idx = spec.index;
            if (fromList === list && idx > fromIndex) idx--;                   // 同列表先删后插的索引补偿
            list.splice(Math.max(0, Math.min(idx, list.length)), 0, task);
            if (spec.zone === "someday" || spec.zone === "done") accOpen.add(spec.zone);   // 拖入自动展开
            commit([fromZone, spec.zone]);
        } else {
            // type "sub"（子任务兄弟排序）与 "nest"（嵌为子任务）同构：都是插入某父任务的 subs
            const hit = findTask(spec.parentId);
            if (!hit) return;
            const from = targetInfo(val);
            if (!from) return;
            const fromZone = from.zone;
            const { obj, fromList, fromIndex } = detachDragged(val);
            const subs = [asSub(obj)].concat((obj.subs || []).map(asSub));     // 自带子任务拍平成同级
            let idx = spec.index;
            if (fromList === hit.task.subs && idx > fromIndex) idx--;          // 索引补偿
            hit.task.subs.splice(Math.max(0, Math.min(idx, hit.task.subs.length)), 0, ...subs);
            if (hit.zone === "someday" || hit.zone === "done") accOpen.add(hit.zone);
            commit([fromZone, hit.zone]);
        }
        render();
    }

    /* ── toast：容器内绝对定位胶囊 ── */

    function toast(msg) {
        const el = root.querySelector(".pos-toast");
        if (!el) return;
        el.textContent = msg;
        el.classList.add("pos-show");
        clearTimeout(el._posToastTimer);
        el._posToastTimer = setTimeout(() => el.classList.remove("pos-show"), 2200);
    }

    /* ── 事件：一次性委托挂在持久的 root 上（重渲染不重复绑定，原型 wireDndOnce 模式） ── */

    function bindEvents() {
        root.addEventListener("click", e => {
            /* 背景三档：玻璃 → 实卡 → 关（localStorage 记忆） */
            const bgBtn = closestEl(e.target, "[data-bgtoggle]");
            if (bgBtn) {
                bgmode = BG_MODES[(BG_MODES.indexOf(bgmode) + 1) % BG_MODES.length];
                root.dataset.bgmode = bgmode;
                writeBgmode(bgmode);
                render();
                return;
            }
            const checkSub = closestEl(e.target, "[data-checksub]");
            if (checkSub) { toggleSub(checkSub.dataset.checksub); return; }
            const check = closestEl(e.target, "[data-check]");
            if (check) { toggleTask(check.dataset.check); return; }
            const delSub = closestEl(e.target, "[data-delsub]");
            if (delSub) { deleteSub(delSub.dataset.delsub); return; }
            const delTask = closestEl(e.target, "[data-deltask]");
            if (delTask) { deleteTask(delTask.dataset.deltask); return; }
            const fold = closestEl(e.target, "[data-fold]");
            if (fold) {
                const hit = findTask(fold.dataset.fold);
                if (hit) {
                    const key = foldKey(hit.zone, hit.task);
                    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
                }
                render();
                return;
            }
            const addSubBtn = closestEl(e.target, "[data-addsub]");
            if (addSubBtn) {
                const pid = addSubBtn.dataset.addsub;
                const hitNow = findTask(pid);
                const rowEl = addSubBtn.closest(".pos-task");
                const old = rowEl.nextElementSibling;
                const inputRow = document.createElement("div");
                inputRow.className = "pos-subs";
                inputRow.innerHTML = '<input class="pos-add-input" placeholder="子任务内容，Enter 确认 / Esc 取消">';
                let container = inputRow;
                if (old && old.classList.contains("pos-subs")
                    && !(hitNow && collapsed.has(foldKey(hitNow.zone, hitNow.task)))) {
                    old.appendChild(inputRow.firstChild);   // 输入框移进已有子任务列表
                    container = old;                        // 原型修过的两容器 bug：之后必须查实际所在容器
                } else {
                    rowEl.insertAdjacentElement("afterend", inputRow);
                }
                const input = container.querySelector("input");
                input.focus();
                input.onkeydown = ev => {
                    if (ev.key === "Enter" && input.value.trim()) {
                        const hit = findTask(pid);
                        if (hit) {
                            hit.task.subs.push({ id: svc.taskId(), text: input.value.trim(), done: false, doneDate: null });
                            collapsed.delete(foldKey(hit.zone, hit.task));
                            commit([hit.zone]);
                            render();
                        }
                    } else if (ev.key === "Escape") {
                        render();
                    }
                };
                input.onblur = () => render();
                return;
            }
            const add = closestEl(e.target, "[data-add]");
            if (add) {
                const zoneId = add.dataset.add;
                const foot = add.parentElement;
                foot.innerHTML = '<input class="pos-add-input" placeholder="任务内容，Enter 确认 / Esc 取消">';
                const input = foot.querySelector("input");
                input.focus();
                input.onkeydown = ev => {
                    if (ev.key === "Enter" && input.value.trim()) {
                        state.zones[zoneId].push(newTask(input.value.trim()));   // 追加到该分区末尾
                        commit([zoneId]);
                        render();
                    } else if (ev.key === "Escape") {
                        render();
                    }
                };
                input.onblur = () => render();   // 失焦取消
                return;
            }
            const calBtn = closestEl(e.target, "[data-cal]");
            if (calBtn) {
                if (!UI.cal) UI.cal = { y: new Date().getFullYear(), m: new Date().getMonth() };
                if (calBtn.dataset.cal === "prev") {
                    UI.cal.m--;
                    if (UI.cal.m < 0) { UI.cal.m = 11; UI.cal.y--; }
                } else {
                    UI.cal.m++;
                    if (UI.cal.m > 11) { UI.cal.m = 0; UI.cal.y++; }
                }
                render();
                return;
            }
            const vdaccToggle = closestEl(e.target, "[data-vdacc-toggle]");
            if (vdaccToggle) {
                const id = vdaccToggle.dataset.vdaccToggle;
                if (accOpen.has(id)) accOpen.delete(id); else accOpen.add(id);   // 状态入会话缓存，重渲染不丢
                render();
                return;
            }
            const capBtn = closestEl(e.target, "[data-cap]");
            if (capBtn) { quickcapSubmit(); return; }
        });

        /* 速记条 Enter（快捷输入框本身跨渲染存在，走委托） */
        root.addEventListener("keydown", e => {
            const qc = closestEl(e.target, "[data-capto]");
            if (qc && e.key === "Enter") quickcapSubmit();
        });

        /* 双击任务/子任务文字 = 行内重命名 */
        root.addEventListener("dblclick", e => {
            const tx = closestEl(e.target, ".pos-tx");
            if (!tx) return;
            const row = closestEl(e.target, "[data-drag]");
            if (!row || !row.dataset.drag) return;
            startRename(tx, row.dataset.drag);
        });

        /* ── 拖拽（原型 wireDndOnce：每分区容器都带 data-zone，
              标题、折叠条、底部按钮区、任务列表都能作为投放落点） ── */
        root.addEventListener("dragstart", e => {
            const row = closestEl(e.target, "[data-drag]");
            if (!row) return;
            dragVal = row.dataset.drag;
            e.dataTransfer.setData("text/plain", dragVal);
            row.classList.add("pos-dragging");
        });

        root.addEventListener("dragover", e => {
            const row = closestEl(e.target, "[data-drag]");
            clearDropFx();
            if (row && row.classList.contains("pos-dragging")) { dropSpec = null; return; }   // 悬在拖拽项自身 = 不可放
            if (row) {
                const c = computeSpec(row, e);
                if (c) {
                    if (c.deny) { dropSpec = null; return; }   // 禁放（防环）：禁止光标，松手无操作
                    e.preventDefault();
                    dropSpec = c.spec;
                    row.classList.add(c.fx);
                    return;
                }
            }
            const zone = closestEl(e.target, "[data-zone]");
            if (zone) {
                e.preventDefault();
                zone.classList.add("pos-over");
                const zid = zone.dataset.zone;
                /* 空白处/标题落点：已完成区按「最新在上」插顶部，其余追加末尾 */
                dropSpec = { type: "zone", zone: zid, index: zid === "done" ? 0 : (state.zones[zid] || []).length };
            } else {
                dropSpec = null;
            }
        });

        root.addEventListener("dragleave", e => {
            if (e.relatedTarget && root.contains(e.relatedTarget)) return;   // 还在应用内，交给 dragover 刷新
            clearDropFx();
            dropSpec = null;
        });

        root.addEventListener("drop", e => {
            e.preventDefault();
            const spec = dropSpec;
            const val = dragVal;
            clearDropFx();
            dropSpec = null;
            dragVal = null;
            const row = root.querySelector(".pos-dragging");
            if (row) row.classList.remove("pos-dragging");
            executeDrop(val, spec);
        });

        root.addEventListener("dragend", e => {
            const row = closestEl(e.target, "[data-drag]");
            if (row) row.classList.remove("pos-dragging");
            clearDropFx();
            dropSpec = null;
            dragVal = null;
        });
    }

    /* ── 启动流程 ─────────────────────────────────────────────────── */

    /** 项目根自定位：特征文件在 Vault 根 = ""；否则反查其所在文件夹（无尾斜杠）。
     *  使项目文件夹可改名、可在 Vault 内任意深度（拷入主 Vault 当子文件夹即用）。 */
    async function locateRoot() {
        if (app.vault.getAbstractFileByPath && app.vault.getAbstractFileByPath(ANCHOR_FILE)) return "";
        const hit = (app.vault.getFiles ? app.vault.getFiles() : []).find(f => f && f.path === ANCHOR_FILE);
        if (!hit) throw new Error("找不到 " + ANCHOR_FILE + "：项目文件夹不完整或已改名");
        return hit.path.slice(0, -ANCHOR_FILE.length - 1);
    }

    async function main() {
        /* 项目根自定位（文件夹可改名、可放任意深度，即插即用） */
        const ROOT = await locateRoot();
        const join = f => ROOT ? ROOT + "/" + f : f;

        /* 数据层接线（SPEC §5.2）：new Function 加载服务工厂 + vault adapter io */
        const serviceSource = await app.vault.adapter.read(join(ANCHOR_FILE));
        const createTaskService = new Function("return " + serviceSource)();
        svc = createTaskService({
            read: p => app.vault.adapter.read(p),
            write: (p, c) => app.vault.adapter.write(p, c),
            root: ROOT ? ROOT + "/" : ""     // service 内部按 root 前缀拼分区文件路径
        });

        /* 页面每次执行先整读六分区文件（手编文件即生效，SPEC §2） */
        state = { zones: await svc.loadAll() };

        /* 背景图：不能用 CSS 相对路径，取 app:// 资源 URL */
        try { heroUrl = app.vault.adapter.getResourcePath(join("工作台内部/Assets/Hero/hero.jpg")); } catch (_) { heroUrl = ""; }
        bgmode = readBgmode();

        /* 根元素：清理同容器旧根（防自动刷新叠加）；dv.view 注入的 <style> 不受影响 */
        Array.from(dv.container.children).forEach(child => {
            if (child && child.classList && child.classList.contains("pos-dash")) child.remove();
        });
        root = document.createElement("div");
        root.className = "pos-dash personal-dashboard";
        root.dataset.bgmode = bgmode;
        dv.container.appendChild(root);

        /* 样式随包注入：项目自带完整设计系统（工作台内部/Styles/dashboard.css），
           主 Vault 无需配置 css snippet——拷入即用。
           每执行注入一次（id 去重），替换旧版以同步改动。 */
        try {
            const themeCss = await app.vault.adapter.read(join("工作台内部/Styles/dashboard.css"));
            const STYLE_ID = "mytaskos-dashboard-theme";
            const old = document.getElementById(STYLE_ID);
            if (old) old.remove();
            const styleEl = document.createElement("style");
            styleEl.id = STYLE_ID;
            styleEl.textContent = themeCss;
            document.head.appendChild(styleEl);
        } catch (_) { /* 样式缺失不阻断功能，页面裸奔可辨 */ }

        bindEvents();

        /* 清扫（打开/切回页面触发）→ 首渲染 → 报数 toast；0 条不 toast（幂等）。
           UI.lastSweep：本次执行的清扫条数（每次模块执行重写一次，页内重渲染不改写）
           ——「清扫仅在模块执行期调用一次」的可观测探针（T07 验收），兼作调试信息。 */
        const sweptCount = runSweep();
        UI.lastSweep = sweptCount;
        render();
        if (sweptCount > 0) toast("隔夜归档：已扫入 " + sweptCount + " 条到「已完成」");
    }

    /** 兜底：加载失败在容器内给出可见错误，不留空白 */
    function showFatal(err) {
        console.error("[MyTask-OS] 工作台视图加载失败", err);
        try {
            Array.from(dv.container.children).forEach(child => {
                if (child && child.classList && child.classList.contains("pos-dash")) child.remove();
            });
            const pre = document.createElement("pre");
            pre.className = "pos-dash pos-fatal";
            pre.textContent = "工作台加载失败：" + (err && err.message ? err.message : String(err));
            dv.container.appendChild(pre);
        } catch (_) { /* 忽略 */ }
    }

    main().catch(showFatal);
})();
