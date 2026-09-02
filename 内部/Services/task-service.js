(function createTaskService(io) {
    /**
     * MyTask-OS 数据层：六分区纯文本任务文件（SPEC §2 数据契约 / §5.1 代码改造要点）
     *
     * 文件形态：整体是一个 JS 表达式（工厂），供视图层加载：
     *   const createTaskService = new Function("return " + src)();
     *   const taskService = createTaskService({
     *     read:  (path) => app.vault.adapter.read(path),
     *     write: (path, content) => app.vault.adapter.write(path, content)
     *   });
     * 注意：首行必须是表达式本体——return 与表达式之间若隔着含换行的注释，
     * new Function("return " + src) 会因自动分号插入（ASI）变成 "return;" 而得到 undefined。
     *
     * 存储模型：六个分区 markdown 文件是唯一事实源，无任何行内元数据。
     *   顶级：  - [ ] 任务文字   /  - [x] 任务文字 ✅ YYYY-MM-DD
     *   子任务：缩进 4 个空格、仅一级嵌套
     * 解析容错：只认复选框行，其余行（空行、普通文字、标题）一律忽略；
     *   [x] 无 ✅ 容忍为无完成日期；未勾选行带 ✅ 视为脏数据并剥离；
     *   重复文字行各自独立成任务（身份仅存在于内存 id）。
     */
    if (!io || typeof io.read !== "function" || typeof io.write !== "function") {
        throw new Error("createTaskService(io)：io 适配器必须提供 read(path) 与 write(path, content)");
    }

    /** 六个分区（顺序即页面顺序，不可增删排序）。
     *  io.root：可选的项目根前缀（自定位注入，如 "MyProject/"），
     *  使项目文件夹在 Vault 内可改名、可放任意深度（拷入主 Vault 即用）。 */
    const ROOT_PREFIX = io && typeof io.root === "string" ? io.root : "";
    const ZONES = [
        { id: "today",   file: "内部/01 Tasks/今日任务.md", name: "今日任务" },
        { id: "temp",    file: "内部/01 Tasks/临时任务.md", name: "临时任务" },
        { id: "near",    file: "内部/01 Tasks/近期任务.md", name: "近期任务" },
        { id: "long",    file: "内部/01 Tasks/长期任务.md", name: "长期任务" },
        { id: "someday", file: "内部/01 Tasks/未安排.md",   name: "未安排" },
        { id: "done",    file: "内部/01 Tasks/已完成.md",   name: "已完成" }
    ].map(zone => Object.freeze({
        ...zone,
        path: ROOT_PREFIX + zone.file      // 视图/调用方使用的实际读写路径
    }));

    /** 复选框行：`- [ ]` / `* [x]` 等（工单规定的唯一认行口径） */
    const CHECKBOX_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
    /** 行尾 ✅ 完成日期后缀（日期允许缺失，容忍手编脏数据） */
    const DONE_SUFFIX = /\s*✅\s*(\d{4}-\d{2}-\d{2})?\s*$/;
    const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
    const SUB_INDENT = "    ";

    /** 串行写入队列：Promise 链防并发（同 Personal-OS 思路） */
    let writeQueue = Promise.resolve();
    let idSeq = 0;

    /** 生成内存态唯一 id：crypto.randomUUID 优先，降级时间戳+随机串 */
    function taskId() {
        idSeq += 1;
        const cryptoRef = typeof globalThis !== "undefined" ? globalThis.crypto : null;
        if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
            return cryptoRef.randomUUID();
        }
        return `t-${Date.now().toString(36)}-${idSeq.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    /** 任务文字清洗：压平换行（防破坏行结构）、去首尾空白 */
    function normalizeText(value) {
        return String(value ?? "")
            .replace(/\s*[\r\n]+\s*/g, " ")
            .trim();
    }

    /**
     * 剥离行尾 ✅ 后缀，返回 { text, doneDate }。
     * 有日期取日期；孤立 ✅（无日期）丢弃；两处 ✅ 均不留在 text 中。
     */
    function stripDoneSuffix(raw) {
        const source = String(raw ?? "");
        const match = source.match(DONE_SUFFIX);
        if (!match) return { text: normalizeText(source), doneDate: null };
        const text = normalizeText(source.slice(0, match.index));
        const doneDate = match[1] && DATE_SHAPE.test(match[1]) ? match[1] : null;
        return { text, doneDate };
    }

    /**
     * 解析单个分区文本 → Task[]。
     * - 只认复选框行；非复选框行/空行忽略；空文字（空标题）拒绝
     * - 缩进 >0 的行归入其上方最近的顶级任务的 subs（再深的缩进拍平为一级）
     * - 缩进行上方没有顶级任务时容错升级为顶级
     */
    function parseZone(text) {
        const tasks = [];
        let current = null;
        for (const line of String(text ?? "").split(/\r\n|\r|\n/)) {
            const match = line.match(CHECKBOX_LINE);
            if (!match) continue;
            const { text: itemText, doneDate } = stripDoneSuffix(match[2]);
            if (!itemText) continue;
            const done = match[1].toLowerCase() === "x";
            const indent = (line.match(/^[ \t]*/) || [""])[0].length;
            if (indent > 0) {
                const sub = { id: taskId(), text: itemText, done, doneDate: done ? doneDate : null };
                if (current) current.subs.push(sub);
                else tasks.push({ ...sub, subs: [] }); // 孤儿子行容错升级为顶级，须补齐 subs
            } else {
                const task = { id: taskId(), text: itemText, done, doneDate: done ? doneDate : null, subs: [] };
                tasks.push(task);
                current = task;
            }
        }
        return tasks;
    }

    /** 单行序列化；空标题拒绝（返回 null），完成日期仅在勾选且格式合法时写入 */
    function itemLine(item, indent) {
        const text = normalizeText(item && item.text);
        if (!text) return null;
        const done = Boolean(item && item.done);
        const rawDate = item ? item.doneDate : null;
        const dateSuffix = done && typeof rawDate === "string" && DATE_SHAPE.test(rawDate)
            ? ` ✅ ${rawDate}`
            : "";
        return `${indent}- [${done ? "x" : " "}] ${text}${dateSuffix}`;
    }

    /**
     * 序列化 Task[] → 分区文件文本。
     * 子任务固定 4 空格缩进；未勾选行绝不带 ✅；末尾单换行；空列表 → 空字符串。
     */
    function serializeZone(tasks) {
        const lines = [];
        for (const task of Array.isArray(tasks) ? tasks : []) {
            const top = itemLine(task, "");
            if (!top) continue;
            lines.push(top);
            const subs = task && Array.isArray(task.subs) ? task.subs : [];
            for (const sub of subs) {
                const line = itemLine(sub, SUB_INDENT);
                if (line) lines.push(line);
            }
        }
        return lines.length ? `${lines.join("\n")}\n` : "";
    }

    function zoneById(zoneId) {
        const zone = ZONES.find(candidate => candidate.id === zoneId);
        if (!zone) {
            throw new Error(`未知分区：${String(zoneId)}（合法值：${ZONES.map(z => z.id).join("、")}）`);
        }
        return zone;
    }

    /**
     * 写入队列：无论上一次成功或失败都按序执行下一个操作；
     * 单次失败向上抛给该次调用的调用方，但不阻塞后续写入。
     */
    function enqueue(operation) {
        const next = writeQueue.then(operation, operation);
        writeQueue = next.catch(() => undefined);
        return next;
    }

    /** 读单分区；文件缺失/读取失败按空分区处理（手编友好） */
    async function readZoneText(zone) {
        try {
            const content = await io.read(zone.path);
            return typeof content === "string" ? content : "";
        } catch (error) {
            return "";
        }
    }

    /** 读六文件 → { today, temp, near, long, someday, done } */
    async function loadAll() {
        const all = {};
        for (const zone of ZONES) {
            all[zone.id] = parseZone(await readZoneText(zone));
        }
        return all;
    }

    /** 整文件重写单分区（经串行写入队列） */
    function saveZone(zoneId, tasks) {
        return enqueue(async () => {
            const zone = zoneById(zoneId);
            await io.write(zone.path, serializeZone(tasks));
        });
    }

    /** 批量写六分区：逐个入队（队列内串行执行）；任一失败在此暴露但不阻塞其余写入 */
    async function saveAll(all) {
        const writes = ZONES.map(zone =>
            saveZone(zone.id, all && Array.isArray(all[zone.id]) ? all[zone.id] : [])
        );
        await Promise.all(writes);
    }

    return Object.freeze({
        ZONES,
        taskId,
        parseZone,
        serializeZone,
        loadAll,
        saveZone,
        saveAll
    });
})
