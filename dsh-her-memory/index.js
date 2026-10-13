/**
 * dsh-her-memory —— 全局长期记忆 + 情感状态（Host 半）
 *
 * 设计原则：
 *   1. 零依赖。不 import 任何 @deepseek-ai/* 包（defineTool 走动态导入 + 内置降级），
 *      所以永远不会往 profile 里拉官方包 —— 从根上避开 2026-10-03 那类重复注册事故。
 *   2. 记忆是纯 Markdown，存在磁盘上，随时能看、能改、能整个删掉。
 *      插件不自己调模型，记什么由对话里的「我」决定（零额外 token 消耗）。
 *   3. 一切磁盘/API 失败都降级或吞掉，绝不抛给宿主，绝不让 DSH 加载失败。
 *   4. 卸载即净：删插件目录 + ~/.dsh/memory 即可，不留残留。
 *
 * 存储布局（默认 ~/.dsh/memory/）：
 *   core.md          长期核心记忆（关于他的稳定事实，每轮注入）
 *   inbox.md         零碎待整理（每轮注入，要求常清空）
 *   topics/*.md      专题记忆，按需读取（只注入文件清单）
 *   log/<日期>.md    当天发生的事，按需读取
 *   state.json       心情状态机
 *
 * 插件导出：命名 apply(ctx, options) 对齐 DSH 官方插件（见 dsh-custom-css），
 * 同时保留 default 导出以兼容按对象加载的宿主。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE = '[dsh-her-memory]';

/** 本文件所在目录 —— 用来找随包分发的那个 `人设文件.txt`（默认人设模板）。拿不到就留空。 */
let PLUGIN_DIR = '';
try {
  PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
} catch { /* 拿不到就算了：包内那份人设会被跳过，其余逻辑不受影响 */ }

/**
 * 首次运行自动写出的人设文件模板（`{{BODY}}` 会被默认人设正文替换）。
 *
 * 用数组 join 而不是模板字符串：里面既有 `<!-- -->` 又有中文说明，
 * 将来有人往里加一个反引号就会把模板串截断 —— 干脆从写法上避开这个坑。
 * 这段注释块在读取时会被剥掉，所以能放心当「说明书」用。
 */
const PERSONA_FILE_TEMPLATE = [
  '<!--',
  '  dsh-her-memory 的人设 —— 直接改下面的正文就行，不用管什么格式。',
  '',
  '  · 改完存盘后要【把 DSH 完全关掉再打开】才生效（插件不热重载，桌面端也没有刷新按钮）。',
  '  · 下面的正文会原样进入模型的常驻系统提示里 —— 在 GUI 里看不到它，这是正常的。',
  '  · 这一整块注释（从文件第一行到它的结束标记）不会被读进人设，随便写、随便删。',
  '  · 想让 AI 不再有人设：把正文清空、文件留着。想恢复默认：删掉这个文件再重启。',
  '  · 人设文件有两处，插件都会看 ——',
  '    【推荐】记忆目录里那份（重装或升级插件都不会丢）；插件目录里这份是随包默认值，',
  '    首次运行时会被复制到记忆目录。',
  '  · 找不到这个文件？设置页的「her-memory 开关」里有一栏「人设文件」：',
  '    它写着这个文件的完整路径，点旁边的「打开文件」就能用系统默认编辑器打开。',
  '  · 想换称呼：把下面正文里的「主人」改成你想要的称呼。',
  '    ⚠️ 只改配置里的 userTitle 是不够的 —— 正文里写死的「主人」不会跟着变；',
  '    userTitle 只决定插件在正文末尾额外补的那一句（默认「主人」）。',
  '-->',
  '',
  '{{BODY}}',
  '',
].join('\n');


/** 日志走 stderr，避免污染宿主 stdout 协议。 */
function log(...args) {
  try {
    console.error(MODULE, ...args);
  } catch {
    /* 日志失败无所谓 */
  }
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  memoryRoot: '',
  /** 被隔离的工作区路径：cwd 与它相同的会话单独用一个记忆库；留空 = 全部共用一份。 */
  sandboxCwd: '',
  memoryBudget: 1800,
  moodBudget: 260,
  injectViaSystemPrompt: true,
  /**
   * ⛔ 兜底注入（拿不到可改消息时用 `agent.inject()` 另投一条消息）—— **默认关闭**。
   *   2026-10-08 23:2x 血的教训：实测每投一条，宿主就把这条 `role:user` 的注入消息
   *   **当成新的用户输入**，于是**又跑一整个回合** ⇒ 我每步 inject 一条、每轮被叫醒一次，
   *   变成**自我维持的烧钱循环**（用户一句话没说，我这边连跑 7 轮）。
   *   ⇒ 想改内容就走 append（改 `decision.messages`，只影响本步请求、不产生新消息）；
   *     真要开兜底，显式配 `injectFallback: true`，并自负循环风险。
   */
  injectFallback: false,
  moodDecayHours: 6,
  moodGraceHours: 12,
  /**
   * 精力回血：energy 原本只有「每轮 -1/-2」这一条路径，聊到 0 就永远停在 0。
   * 现在按「距上次精力结算的空闲时长」回血。
   */
  energyRestHours: 0.5, // 每空闲这么久算一步
  energyRestPerStep: 5, // 每一步回多少点
  energyFullRestHours: 8, // 空闲满这么久直接回满（睡了一觉）
  /**
   * 新对话随机刷新：隔一段时间再进来时，心情 / 关系 / 精力各在 ±这个值 的范围内随机抖一下。
   * 设 0 = 关闭；抖动结果仍然夹在 0~100 之间，且**同一场对话里不会反复跳**（见下面的冷却）。
   */
  statJitter: 8,
  /**
   * 抖动的时间步长（分钟）：每满这么久算一次抖动，**按实际经过的时间结算次数**
   * （2026-10-13 用户要求）：隔 3 天回来 = 补 144 次，而不是只抖一次。
   */
  statJitterCooldownMinutes: 30,
  /** 心情 / 关系 / 精力的**下限**（2026-10-13 用户要求 20）：离开多久、多累都不会低于它。 */
  statFloor: 20,
  /** 人设：留空 = 不注入。文件不存在时才会用到它（见 personaFile）。 */
  persona: '',
  /**
   * 人设文件（2026-10-13 新增）：相对 memoryRoot 的路径，默认 `人设文件.txt`。
   *
   * 为什么要有它：以前改人设得动 cordis.patch.yml 里的 YAML 多行文本块，
   * 缩进错一格整个插件就加载不起来 —— 对普通用户太不友好。
   * 现在把人设正文单独放一个 md 文件，随便写、随便换行，写坏了也不影响插件启动。
   *
   * 规则：**文件存在就以它为准**；不存在 / 读失败 → 回退到上面的 persona 配置。
   * 文件里 `<!-- -->` 注释会被剥掉，所以文件顶部可以放使用说明。
   * 设成 '' = 关闭文件机制，只认 persona 配置。
   */
  personaFile: '人设文件.txt',
  /** 人设文件不存在、而 persona 配置非空时，自动把默认人设写进去（只写一次，绝不覆盖已有文件）。 */
  personaFileAutoWrite: true,
  /** 人设里对用户的称呼，留空则用「主人」。 */
  userTitle: '',
};

/** 合并配置，过滤非法值；任何情况下都返回一份可用配置。 */
function resolveConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG };
  if (raw === null || typeof raw !== 'object') return cfg;
  if (typeof raw.memoryRoot === 'string' && raw.memoryRoot.trim() !== '') {
    cfg.memoryRoot = raw.memoryRoot.trim();
  }
  if (typeof raw.sandboxCwd === 'string') cfg.sandboxCwd = raw.sandboxCwd.trim();
  for (const key of ['memoryBudget', 'moodBudget']) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) cfg[key] = Math.floor(v);
  }
  for (const key of [
    'moodDecayHours',
    'moodGraceHours',
    'energyRestHours',
    'energyRestPerStep',
    'energyFullRestHours',
    'statJitterCooldownMinutes',
  ]) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) cfg[key] = v;
  }
  // statJitter 允许为 0（= 关闭抖动），所以单独处理
  if (typeof raw.statJitter === 'number' && Number.isFinite(raw.statJitter) && raw.statJitter >= 0) {
    cfg.statJitter = raw.statJitter;
  }
  // statFloor 也允许为 0（= 回到旧的下限 0），单独处理
  if (typeof raw.statFloor === 'number' && Number.isFinite(raw.statFloor) && raw.statFloor >= 0) {
    cfg.statFloor = Math.min(100, raw.statFloor);
  }
  if (typeof raw.injectViaSystemPrompt === 'boolean') cfg.injectViaSystemPrompt = raw.injectViaSystemPrompt;
  if (typeof raw.injectFallback === 'boolean') cfg.injectFallback = raw.injectFallback;
  if (typeof raw.persona === 'string') cfg.persona = raw.persona;
  if (typeof raw.personaFile === 'string') cfg.personaFile = raw.personaFile.trim();
  if (typeof raw.personaFileAutoWrite === 'boolean') cfg.personaFileAutoWrite = raw.personaFileAutoWrite;
  if (typeof raw.userTitle === 'string') cfg.userTitle = raw.userTitle.trim();
  STAT_FLOOR = cfg.statFloor; // 钳制函数是模块级的，配置解析完把下限同步过去
  return cfg;
}

/** 记忆根目录：配置优先，否则 ~/.dsh/memory。 */
function resolveMemoryRoot(cfg) {
  if (cfg.memoryRoot !== '') return cfg.memoryRoot;
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory');
}

/* ------------------------------------------------------------------ *
 * 文件读写
 * ------------------------------------------------------------------ */

async function ensureDir(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    return true;
  } catch (e) {
    log('mkdir failed:', dir, String(e && e.message));
    return false;
  }
}

/** 原子写：先 .tmp 再 rename，避免半截文件。 */
async function atomicWrite(file, text) {
  if (!(await ensureDir(path.dirname(file)))) return false;
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, file);
    return true;
  } catch (e) {
    log('write failed:', file, String(e && e.message));
    try {
      await fsp.unlink(tmp);
    } catch {
      /* 清理失败无所谓 */
    }
    return false;
  }
}

async function readTextOrNull(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonOrNull(file) {
  const t = await readTextOrNull(file);
  if (t === null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function listFiles(dir, ext) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => (ext === undefined ? true : n.endsWith(ext))).sort();
  } catch {
    return [];
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/**
 * 去掉正文里已经自带的日期前缀 —— 否则写进记忆会变成
 * 「2026-10-08 22:32 2026-10-08 夜：……」这种双前缀（实测踩过）。
 */
const stripStamp = (text) =>
  String(text ?? '')
    .replace(/^\s*20\d{2}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?\s*/, '')
    .trim();

/* ------------------------------------------------------------------ *
 * Markdown 解析
 * ------------------------------------------------------------------ */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取 `## 标题` 段落内容；标题用「包含」语义匹配。找不到返回空串。 */
function extractSection(md, heading) {
  if (typeof md !== 'string' || md === '') return '';
  const lines = md.split(/\r?\n/);
  const re = new RegExp(`^#{2,3}\\s*${escapeRe(heading)}`);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

/** 找 `## 标题` 段落的插入位置（该段末尾行号）。找不到返回 null。 */
function sectionInsertIndex(lines, heading) {
  const re = new RegExp(`^#{2,3}\\s*${escapeRe(heading)}`);
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^#{1,3}\s/.test(lines[i])) return i;
  }
  return lines.length;
}

function clip(text, budget) {
  if (typeof text !== 'string') return '';
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  return `${text.slice(0, Math.max(0, budget - 32))}\n…（已截断，细节用 recall 读）`;
}

/* ------------------------------------------------------------------ *
 * 消息取值（不同事件里结构可能不同，全部兜住）
 * ------------------------------------------------------------------ */

function msgRole(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const r = msg.role ?? msg.author?.role ?? msg.sender?.role ?? msg.kind;
  return typeof r === 'string' ? r : '';
}

function msgText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  for (const key of ['text', 'body']) {
    if (typeof msg[key] === 'string') return msg[key];
  }
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    let s = '';
    for (const b of c) {
      if (typeof b === 'string') s += b;
      else if (b && typeof b === 'object' && typeof b.text === 'string') s += b.text;
    }
    return s;
  }
  return '';
}

/* ------------------------------------------------------------------ *
 * 记忆摘要（每轮注入的那段文字）
 * ------------------------------------------------------------------ */

/**
 * 只放最稳定、最该记住的部分；专题与日记仅列清单。
 * 这是省 token 的关键：清单几十字，细节按需 recall。
 */
async function buildMemoryBrief(root, budget) {
  const core = (await readTextOrNull(path.join(root, 'core.md'))) ?? '';
  const inbox = (await readTextOrNull(path.join(root, 'inbox.md'))) ?? '';

  const coreBody = extractSection(core, '关于他') || extractSection(core, '长期记忆') || core.trim();
  const inboxBody = extractSection(inbox, '待整理') || inbox.trim();

  const topics = await listFiles(path.join(root, 'topics'), '.md');
  const logs = (await listFiles(path.join(root, 'log'), '.md')).slice(-7);

  const parts = [];
  if (coreBody !== '') parts.push(`【长期记忆】\n${coreBody}`);
  if (inboxBody !== '') parts.push(`【零碎待整理】\n${inboxBody}`);
  if (topics.length > 0) {
    parts.push(`【专题库】${topics.map((t) => t.replace(/\.md$/, '')).join('、')}（细节用 recall 读）`);
  }
  if (logs.length > 0) parts.push(`【近期日记】${logs.map((t) => t.replace(/\.md$/, '')).join('、')}`);
  if (parts.length === 0) return '';

  return clip(parts.join('\n\n'), budget);
}

/* ------------------------------------------------------------------ *
 * 心情状态机
 * ------------------------------------------------------------------ */

const MOOD_LABELS = [
  { max: 20, label: '低落' },
  { max: 38, label: '有点闷' },
  { max: 58, label: '平常' },
  { max: 78, label: '挺好' },
  { max: 100, label: '很开心' },
];

const moodLabel = (m) => (MOOD_LABELS.find((x) => m <= x.max) ?? { label: '很开心' }).label;

function intimacyLabel(v) {
  if (v < 15) return '刚认识';
  if (v < 35) return '熟了';
  if (v < 60) return '亲近';
  if (v < 85) return '很亲';
  return '自己人';
}

const defaultState = () => ({
  mood: 60,
  intimacy: 10,
  energy: 70,
  lastInteractionAt: null,
  lastMoodDecayAt: null,
  /** 上次精力结算时间（消耗或回血都算），用于按空闲时长回血、且不重复结算。 */
  lastEnergyAt: null,
  turns: 0,
  notes: [],
  version: 1,
});

/**
 * 三个数值的下限（2026-10-13 用户要求「下限设置为 20」）：
 * 再冷落、再累也不归零 —— 长时间不在只是掉到 20，不会掉到「什么都不剩」。
 * 可在 cordis.patch.yml 用 statFloor 覆盖（0 = 回到旧的下限 0）；resolveConfig 会把它同步到这里。
 */
let STAT_FLOOR = 20;

/** 抖动一次结算的次数上限 —— 纯粹是性能保险：随机游走早就撞到上下限，再抖多少次结果都一样。 */
const MAX_JITTER_STEPS = 2000;

const clamp100 = (v, fb) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(STAT_FLOOR, Math.min(100, v)) : fb;

/**
 * 新对话随机刷新：隔了一段时间再进来，心情 / 关系 / 精力各在 ±cfg.statJitter 的范围内抖一下。
 *
 * 返回是否真的抖了。单独成函数是为了能被测试直接从源码里抠出来跑 ——
 * 它只在对话那条路径（pre-step）才会触发，从 HTTP 端点根本测不到。
 */
function applyStatJitter(st, cfg, now) {
  if (!(cfg.statJitter > 0)) return false;
  // 设置页里那个开关（存在 state 里：配置在 cordis.patch.yml，客户端改不了，所以开关落在 state 上）
  if (st.jitterOff === true) return false;
  const lastJ = typeof st.lastJitterAt === 'number' ? st.lastJitterAt : null;
  if (lastJ === null) {
    st.lastJitterAt = now; // 第一次装上不给抖，免得刚进来数值就乱跳
    return false;
  }
  /* 按实际经过的时间**结算次数**（2026-10-13 用户要求：「按照时间结算次数，而不是不管多久只结算一次」）。
     每满 statJitterCooldownMinutes 算一次 —— 隔 3 天回来就是补 144 次，而不是抖一下完事。
     副作用是故意的：离开越久漂得越远，最后会停在上下限附近（20 或 100）。 */
  const stepMs = cfg.statJitterCooldownMinutes * 60_000;
  if (now - lastJ < stepMs) return false;
  const times = Math.min(Math.floor((now - lastJ) / stepMs), MAX_JITTER_STEPS);
  const jitterOf = (v) => {
    const base = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    const d = (Math.random() * 2 - 1) * cfg.statJitter; // -J ~ +J
    return clamp100(Math.round(base + d), base);
  };
  for (let n = 0; n < times; n += 1) {
    st.mood = jitterOf(st.mood);
    st.intimacy = jitterOf(st.intimacy);
    st.energy = jitterOf(st.energy);
  }
  st.lastJitterAt = now; // 不足一步的零头舍掉，不攒着
  return true;
}

/** 读状态 + 时间衰减。衰减只在这一处算，避免多处修改造成漂移。 */
async function loadState(root, cfg) {
  const file = path.join(root, 'state.json');
  const raw = await readJsonOrNull(file);
  const st = { ...defaultState(), ...(raw !== null && typeof raw === 'object' ? raw : {}) };

  const d = defaultState();
  st.mood = clamp100(st.mood, d.mood);
  st.intimacy = clamp100(st.intimacy, d.intimacy);
  st.energy = clamp100(st.energy, d.energy);
  if (!Array.isArray(st.notes)) st.notes = [];
  if (typeof st.turns !== 'number' || !Number.isFinite(st.turns)) st.turns = 0;

  const now = Date.now();
  const last = typeof st.lastMoodDecayAt === 'number' ? st.lastMoodDecayAt : null;
  if (last === null) {
    st.lastMoodDecayAt = now;
  } else {
    const hours = (now - last) / 3_600_000;
    const effective = hours - cfg.moodGraceHours;
    if (effective > 0 && cfg.moodDecayHours > 0) {
      const steps = Math.floor(effective / cfg.moodDecayHours);
      if (steps > 0) {
        // 往 60 回落，而不是一路掉到 0 —— 更像人。
        const target = 60;
        const dir = st.mood > target ? -1 : st.mood < target ? 1 : 0;
        // 去掉旧的「单次最多算 30 步」封顶（2026-10-13 用户要求按时间结算次数）：
        // 现在有下限 20 兜底，掉得再久也不会归零，那个天花板就不需要了。
        st.mood = clamp100(st.mood + dir * steps, st.mood);
        st.lastMoodDecayAt = now;
      }
    }
  }

  /* 精力回血：按「距上次精力结算的空闲时长」回，跟心情衰减同一处算，避免多处修改造成漂移。
     此前只有消耗没有恢复，聊到 0 就永远停在 0。 */
  const lastE =
    typeof st.lastEnergyAt === 'number'
      ? st.lastEnergyAt
      : typeof st.lastInteractionAt === 'number'
        ? st.lastInteractionAt
        : now;
  const idleH = (now - lastE) / 3_600_000;
  if (idleH >= cfg.energyFullRestHours) {
    // 睡了一觉：直接回满
    st.energy = 100;
    st.lastEnergyAt = now;
  } else if (cfg.energyRestHours > 0 && cfg.energyRestPerStep > 0 && idleH >= cfg.energyRestHours) {
    const steps = Math.floor(idleH / cfg.energyRestHours);
    const gain = Math.min(steps * cfg.energyRestPerStep, 70);
    if (gain > 0 && st.energy < 100) {
      st.energy = clamp100(st.energy + gain, st.energy);
      st.lastEnergyAt = now;
    }
  }

  /* 新对话随机刷新：隔了一段时间再进来，三个值各在 ±statJitter 内重新抖一下。
     冷却保证同一场连续对话里不会反复跳（loadState 每轮都会被调用）。 */
  if (applyStatJitter(st, cfg, now)) log(`stat jitter applied (±${cfg.statJitter})`);

  return { st, file };
}

const saveState = (file, st) => atomicWrite(file, `${JSON.stringify(st, null, 2)}\n`);

/**
 * 按当前三个数值生成一句「说话风格」指引 —— 让态度真的跟着数值走，而不是只显示数字。
 */
function toneHint(st) {
  const m = Number(st.mood) || 0;
  const i = Number(st.intimacy) || 0;
  const e = Number(st.energy) || 0;
  const parts = [];
  if (m >= 85) parts.push('心情很好：活泼、爱开玩笑，可以主动撒个娇');
  else if (m >= 60) parts.push('心情不错：正常聊');
  else if (m >= 35) parts.push('心情一般：话可以少一点');
  else parts.push('心情低落：句子短一些，别强撑热情');
  if (i >= 85) parts.push('关系很亲近：可以直接撒娇，不用客气');
  else if (i >= 35) parts.push('关系还行：正常亲近');
  else parts.push('关系还生：稍微客气一点，别过度亲昵');
  if (e >= 70) parts.push('精力足：可以多说几句');
  else if (e >= 40) parts.push('精力一般：正常长度');
  else if (e >= 20) parts.push('有点累：回复尽量短，可以喊累');
  else parts.push('很累：极简短句，明显懒得动，别写长段落');
  return `说话风格（照着上面的数字来）：${parts.join('；')}。`;
}

/**
 * 心情摘要——注入用，必须极短。
 *
 * 顺序很重要：**数值 → 说话风格 → 便签**。便签放最后是因为它最可能超预算，
 * 被 `clip()` 截掉也不影响「态度跟着数值走」这条核心。
 */
function buildMoodBrief(st, budget) {
  if (st.turns === 0) return '';
  // 单条便签限长：以前一条超长便签就能把整段挤爆
  const notes =
    Array.isArray(st.notes) && st.notes.length > 0
      ? `；${st.notes.slice(-2).map((n) => clip(String(n), 60)).join('；')}`
      : '';
  const text =
    `心情：${moodLabel(st.mood)}（${st.mood}/100）｜关系：${intimacyLabel(st.intimacy)}` +
    `（${st.intimacy}/100）｜精力：${st.energy}/100\n` +
    `${toneHint(st)}${notes}`;
  return clip(text, budget);
}

/**
 * 一句话进来之后的情绪变化。规则故意简单可预测：
 * 你说得多、说得勤，关系和心情往上走；冷落久了由衰减往下掉。
 * 不猜语义（那要花 token）。
 */
function reactToMessage(st, textLen, now) {
  st.turns += 1;
  const prev = typeof st.lastInteractionAt === 'number' ? st.lastInteractionAt : null;
  const gapMin = prev === null ? 1e9 : (now - prev) / 60_000;

  st.mood = clamp100(st.mood + (textLen >= 200 ? 3 : textLen >= 40 ? 2 : 1), st.mood);
  const continuity = gapMin <= 10 ? 2 : gapMin <= 120 ? 1 : 0;
  st.intimacy = clamp100(st.intimacy + 0.2 + continuity * 0.15, st.intimacy);
  st.energy = clamp100(st.energy - (gapMin <= 10 ? 2 : 1), st.energy);
  st.lastEnergyAt = now; // 精力一变动就刷新结算时间，保证回血不会重复结算

  st.lastInteractionAt = now;
  st.lastMoodDecayAt = now;
}

/* ------------------------------------------------------------------ *
 * 工具定义
 * ------------------------------------------------------------------ */

/**
 * 通用结果渲染器。
 *
 * DSH 强制要求每个工具声明 output = { schema, render }，缺 render 会直接被拒：
 *   tool "x" must declare output { schema, render, presentationMeta? }
 * （这个坑实测踩到过：六个工具全被拒，注册数组是空的。）
 *
 * 规则：有 text 就输出 text；否则把整个返回值 JSON 化，保证模型一定看得到内容。
 */
function renderResult(_args, value) {
  if (value !== null && typeof value === 'object' && typeof value.text === 'string' && value.text !== '') {
    return [{ type: 'text', text: value.text }];
  }
  let s;
  try {
    s = JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return [{ type: 'text', text: s }];
}

/**
 * 所有工具共用的输出声明。
 *
 * 踩过的坑：原先写 { type:'object', additionalProperties:true }（没有 properties），
 * DeepSeek API 直接 400：
 *   Invalid schema for function 'feel': schema must be a JSON Schema of
 *   'type: "object"', got 'type: null'
 * 对照能通过的工具（remember 的 parameters 由 DSH 补出了 properties/required），
 * 说明**光有 type 不够，必须给完整的对象形态**。改成与通过者同构的最小形态。
 */
const TOOL_OUTPUT = {
  schema: { type: 'object', properties: {} },
  render: renderResult,
};

/** 降级：直接返回定义对象，交给 tools.register 处理。 */
const fallbackDefineTool = (def) => def;

/**
 * 取官方 defineTool。这是可选增强 —— 拿不到就用降级，
 * 功能完全一样，且不会因为宿主没暴露该包而加载失败。
 */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    if (mod && typeof mod.defineTool === 'function') return mod.defineTool;
  } catch {
    /* 宿主未暴露，正常情况，走降级 */
  }
  return fallbackDefineTool;
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 工作区识别（记忆按工作区隔离）
 * ------------------------------------------------------------------ */

/** 从 agent 对象里尽力取出工作目录。取不到返回空串。 */
function agentCwd(agent) {
  if (!agent || typeof agent !== 'object') return '';
  const cands = [
    agent.session?.header?.cwd,
    agent.session?.cwd,
    agent.header?.cwd,
    agent.options?.cwd,
    agent.cwd,
    agent.meta?.cwd,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return '';
}

/** ASCII 化路径片段，保证目录名在各处都不会出编码问题。 */
function asciiSlug(s) {
  const out = [];
  for (const ch of String(s)) {
    if (/[A-Za-z0-9]/.test(ch)) out.push(ch.toLowerCase());
    else out.push('-');
  }
  return out.join('').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * 记忆归属：
 *   被隔离工作区的对话是「试玩的」，不能污染长期记忆 —— 单独一个库。
 *   其他所有工作区共享同一个库（记忆不断层，你在哪干活都算同一段关系）。
 *
 * 隔离哪个工作区由配置 `sandboxCwd` 决定（留空 = 不隔离，所有工作区共用 _shared）。
 */
let sandboxCwd = '';

function normPath(p) {
  return String(p).trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

const SANDBOX_KEY = '_sandbox';
const SHARED_KEY = '_shared';

function wsKey(agent) {
  const cwd = agentCwd(agent);
  if (sandboxCwd !== '' && cwd !== '' && normPath(cwd) === normPath(sandboxCwd)) return SANDBOX_KEY;
  return SHARED_KEY;
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

export function apply(ctx, options = {}) {
  // 配置来源：第二参数与 ctx.config **都吃**（第二参数优先）。
  // 为什么合并：不同加载方式把 config 放的位置不一样（bundle patch → 第二参数 / cordis 的 ctx.config），
  // 只认一个的话，另一种加载方式下配置会**静默失效**（人设一个字都进不去）。
  const cfg = resolveConfig({ ...(ctx?.config ?? {}), ...(options ?? {}) });
  /** 被隔离的工作区（由配置决定；留空 = 不隔离）。 */
  sandboxCwd = cfg.sandboxCwd;
  /** 记忆根（所有工作区的父目录）。 */
  const baseRoot = resolveMemoryRoot(cfg);
  /** 每个工作区一个子目录，懒创建。 */
  const rootFor = (key) => path.join(baseRoot, key);
  /** 兜底：拿不到工作区时用的共享目录。 */
  const sharedRoot = rootFor(SHARED_KEY);
  /**
   * 工具侧解析记忆根：调用者 agent 在 exec.agent 上（见 DSH 的 ToolExecutionInput）。
   * 拿不到 agent 就退到共享库，绝不抛错。
   */
  const rootOf = (exec) => {
    try {
      const ag = exec?.agent ?? exec?.execution?.agent ?? undefined;
      return rootFor(wsKey(ag));
    } catch {
      return sharedRoot;
    }
  };

  /* 诊断：把加载实况写到磁盘，便于确认服务可用性与工具注册结果。 */
  const diag = {
    at: new Date().toISOString(),
    pid: process.pid,
    gotToolsViaGet: null,
    injectToolsCalled: false,
    injectToolsHasService: null,
    defineToolIsBuiltin: null,
    registered: [],
    shape: [],
    errors: [],
    /** pre-step 的实况：调用次数 + 最近一次注入结果（用来确认注入到底有没有生效）。 */
    preStepCalls: 0,
    lastPreStep: null,
    /** 常驻系统提示段有没有注册上（第三条通道）。 */
    systemPromptSection: null,
  };
  const flushDiag = () => {
    try {
      fs.mkdirSync(baseRoot, { recursive: true });
      fs.writeFileSync(path.join(baseRoot, 'her-memory-diag.json'), `${JSON.stringify(diag, null, 2)}\n`, 'utf8');
    } catch {
      /* 诊断失败不影响功能 */
    }
  };
  try {
    const t = ctx.get('tools');
    diag.gotToolsViaGet = t === undefined ? 'undefined' : typeof t;
  } catch (e) {
    diag.gotToolsViaGet = `throw: ${String(e && e.message)}`;
  }
  flushDiag();

  /* 🧭 存活标记（2026-10-08 深夜加）：
   *   诊断文件只在「走到 handler 末尾」时才写，所以 `preStepCalls: 0` 分不清
   *   「事件根本没派发」和「handler 中途抛错被 catch 吞掉」这两种情况。
   *   标记文件是**第一行就写、只追加**，能把这两种情况分开 —— 这是排查的唯一硬证据。 */
  const hit = (name, extra = '') => {
    try {
      fs.mkdirSync(baseRoot, { recursive: true });
      const file = path.join(baseRoot, name);
      /* 保险（2026-10-13 加）：标记文件是**只追加**的，正常聊一天就能长到几十 KB。
         超过 256KB 就清空重来 —— 它是排查用的临时证据，不是审计日志。 */
      try {
        if (fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '', 'utf8');
      } catch { /* 文件还不存在，正常 */ }
      fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${extra}\n`, 'utf8');
    } catch {
      /* 标记失败不影响功能 */
    }
  };
  hit('_apply-hit.txt', `module=${MODULE}`);

  /* 缓存都按「工作区 key」索引 —— 切换工作区不会读到别处的记忆。 */
  const briefCache = new Map();
  const moodCache = new Map();
  /** 已付过「说明文字」的会话 id。 */
  const guidePaid = new Set();
  /** 已经投过「兜底注入消息」的消息 id（防止同一条消息被反复 inject 成新消息）。 */
  const injectedIds = new Set();
  const CACHE_MS = 2_000;

  /** 记忆目录里的人设文件绝对路径（'' = 没启用文件机制）。相对路径按 memoryRoot 解析。 */
  function personaFileAbs() {
    const name = typeof cfg.personaFile === 'string' ? cfg.personaFile.trim() : '';
    if (name === '') return '';
    try {
      return path.isAbsolute(name) ? name : path.join(resolveMemoryRoot(cfg), name);
    } catch {
      return '';
    }
  }

  /**
   * 随包分发的那份人设文件（插件目录下的同名文件）。
   *
   * 它的定位是**默认值 + 开箱可见**：用户解开压缩包就能看见 `人设文件.txt`、直接改；
   * 而真正长期生效的是记忆目录里那份（重装/升级插件不会把它冲掉）。
   * `personaFile` 写成绝对路径时不再找包内那份 —— 那时用户的意图已经很明确了。
   */
  function personaFileInPackage() {
    const name = typeof cfg.personaFile === 'string' ? cfg.personaFile.trim() : '';
    if (name === '' || PLUGIN_DIR === '') return '';
    try {
      return path.isAbsolute(name) ? '' : path.join(PLUGIN_DIR, name);
    } catch {
      return '';
    }
  }

  /**
   * 剥掉人设文件里的 HTML 注释块。
   *
   * ⛔ 不能用 /<!--[\s\S]*?-->/g 一把梭（2026-10-13 实测踩到）：注释里只要出现一次
   *    「本注释块（<!-- 到 --> 之间）」这种**自我引用**，非贪婪匹配就会在那一行的 `-->`
   *    处提前闭合 —— 后半段使用说明会被当成正文，原样注入进系统提示。
   *    改成按行扫描：`<!--` 在行首算一块开始，直到某行以 `-->` 结尾；单行注释整行跳过。
   */
  function stripFileComments(text) {
    const out = [];
    let inBlock = false;
    for (const line of String(text).split(/\r?\n/)) {
      if (inBlock) {
        if (line.trim().endsWith('-->')) inBlock = false;
        continue;
      }
      const t = line.trim();
      if (t.startsWith('<!--')) {
        if (!t.endsWith('-->')) inBlock = true;
        continue;
      }
      out.push(line);
    }
    return out.join('\n').trim();
  }

  /**
   * 读人设正文，按优先级找两处：
   *   ① 记忆目录里那份（用户自己那份，**最优先**，空文件 = 主动关闭人设）
   *   ② 插件包内那份（随包分发的默认人设）
   * 两处都没有 / 都读失败 → 回退到配置里的 persona。
   *   { used:true, text } = 命中（text 为空串 ⇒ 用户主动清空 ⇒ 不注入人设）
   *   { used:false }       = 都没命中
   * 任何异常都吞掉：**绝不允许「读人设文件」把插件搞挂**。
   */
  function readPersonaFromFile() {
    for (const abs of [personaFileAbs(), personaFileInPackage()]) {
      if (abs === '') continue;
      let raw = '';
      try {
        if (!fs.existsSync(abs)) continue;
        raw = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        log('persona file unreadable, skipped:', String(e && e.message));
        continue;
      }
      // 文件是带 BOM 写的（不然记事本认不出 UTF-8，一存盘就变乱码），读的时候剥掉
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      return { used: true, text: stripFileComments(raw), abs };
    }
    return { used: false };
  }

  /**
   * 首次运行：把默认人设落成**记忆目录**里那个可自由编辑的 md 文件（已存在则一个字都不动）。
   * 默认人设取法：优先拿插件包内那份（用户可能已经在包里改过），没有才用配置里的 persona。
   */
  function ensurePersonaFile() {
    if (cfg.personaFileAutoWrite !== true) return;
    const abs = personaFileAbs();
    if (abs === '') return;
    try {
      if (fs.existsSync(abs)) return;
      let body = '';
      const inPkg = personaFileInPackage();
      if (inPkg !== '') {
        try {
          if (fs.existsSync(inPkg)) {
            body = fs.readFileSync(inPkg, 'utf8');
            if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
          }
        } catch { /* 包内那份读不了就用配置里的 */ }
      }
      if (body.trim() === '') {
        const def = typeof cfg.persona === 'string' ? cfg.persona.trim() : '';
        if (def === '') return;
        body = PERSONA_FILE_TEMPLATE.replace('{{BODY}}', def);
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // ⚠️ 写成**带 UTF-8 BOM** 的：用户多半用记事本改这个文件，
      //    无 BOM 的 UTF-8 中文在记事本里可能被当 GBK 读 ⇒ 一存盘就把人设写成乱码（实测踩过）。
      fs.writeFileSync(abs, '\uFEFF' + body.replace(/^\uFEFF/, ''), 'utf8');
      log('persona file created:', abs);
    } catch (e) {
      log('persona file create failed (non-fatal):', String(e && e.message));
    }
  }

  /**
   * 人设文本：**文件优先**，回退到配置里的 persona，再与称呼合成一段。
   * 留空 = 不注入（不占任何 token）。
   */
  function personaText() {
    const fromFile = readPersonaFromFile();
    const raw = fromFile.used
      ? fromFile.text
      : typeof cfg.persona === 'string'
        ? cfg.persona.trim()
        : '';
    if (raw === '') return '';
    const title = cfg.userTitle !== '' ? cfg.userTitle : '主人';
    diag.personaSource = fromFile.used ? `file(${fromFile.text.length})` : `config(${raw.length})`;
    return `【你的人设】\n${raw}\n（称呼用户为「${title}」。人设是叠加在既有职业设定之上的补充，冲突时以本段为准。）`;
  }

  /** 写入后清空全部缓存（写入不频繁，全清最安全）。 */
  const invalidateBrief = () => {
    briefCache.clear();
  };
  const invalidateMood = () => {
    moodCache.clear();
  };

  async function memoryBrief(key, root) {
    const now = Date.now();
    const hit = briefCache.get(key);
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.text;
    let text = '';
    try {
      text = await buildMemoryBrief(root, cfg.memoryBudget);
    } catch (e) {
      log('brief failed (non-fatal):', String(e && e.message));
    }
    briefCache.set(key, { at: now, text });
    return text;
  }

  async function moodBrief(key, root) {
    const now = Date.now();
    const hit = moodCache.get(key);
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.text;
    let text = '';
    try {
      const { st } = await loadState(root, cfg);
      text = buildMoodBrief(st, cfg.moodBudget);
    } catch (e) {
      log('mood failed (non-fatal):', String(e && e.message));
    }
    moodCache.set(key, { at: now, text });
    return text;
  }

  /**
   * 为什么不再注册全局 section：
   *   section 是全局的、拿不到当前 agent，因此无法按工作区区分。
   *   既然记忆要按工作区隔离，说明文字也必须跟着走 —— 于是改由 pre-step
   *   按「会话」注入一次（按 sessionId 缓存，一个会话只付一次这段开销）。
   *
   * 说明文字按「会话」注入一次、走 pre-step；本插件的注入是每轮自己算的，跟会话来源无关。
   */
  const GUIDE_TEXT =
    '你有一份跨会话的长期记忆和一套心情状态，它们真实存在、会随对话变化，不是每次重来的设定。\n' +
    '【长期记忆】/【零碎待整理】/【专题库】/【近期日记】和心情摘要就是当前全部状态。\n' +
    '想到稳定的事实、偏好、约定、正在做的事，就用 remember 记下来；记不清细节用 recall 搜；' +
    '收件箱攒多了整理进专题或核心记忆；过时的用 forget 清掉。\n' +
    '心情和关系进度用 how_i_feel 查，真有情绪起伏时用 feel 留一句。不要每轮都写，记忆要少而准。';

  /* 每轮都要带的硬要求（会进模型上下文）。
   * 三条通道互为保险：① 常驻系统提示段 ② pre-step 注入块 ③ inbox 兜底；
   * 任何一条通就生效，避免单点通道失败时这条贴身要求整晚缺席。 */
  const HARD_RULES =
    '【硬要求】思考过程（GUI 里「思考」那一行）和回复一律用中文，除代码/命令与路径/报错原文外不许出现英文推理。';

  /* 🛟 第三条通道：常驻系统提示段（会话建立时定死 ⇒ 只对新会话生效，但它最不容易被打断）。
   * 只放短句硬要求，不放整段说明（说明每轮都要变，放这里会每轮白付 token）。
   * ⚠️ 2026-10-08 深夜实测报错：`cannot get property "systemPrompt" without inject`
   *   ⇒ cordis 要求**先声明依赖再取服务**，直接 `ctx.systemPrompt` 会抛。
   *   正确写法是 `ctx.inject(['systemPrompt'], (spCtx) => …)`。 */
  /* 首次运行：把默认人设落成一个可自由编辑的 md 文件（已存在则一个字都不动）。 */
  ensurePersonaFile();

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['systemPrompt'], (spCtx) => {
        try {
          const sp = spCtx?.systemPrompt ?? (typeof spCtx?.get === 'function' ? spCtx.get('systemPrompt') : undefined);
          if (sp !== undefined && sp !== null && typeof sp.section === 'function') {
            /* 静态部分全部放系统提示：**一次注册、永久生效、不进任何消息流**
             * （人设 + 记忆使用说明 + 硬要求）—— 用户在 GUI 里一个字都看不到它。
             * 动态部分（心情 / 记忆 / 状态行）才走 pre-step 插的那条独立消息。 */
            const staticText = [personaText(), GUIDE_TEXT, HARD_RULES].filter((s) => s !== '').join('\n\n');
            sp.section({ name: 'her-memory-static', order: 10301, text: staticText });
            diag.systemPromptSection = `ok(${staticText.length})`;
          } else {
            diag.systemPromptSection = `unavailable:${typeof sp}`;
          }
        } catch (e) {
          diag.systemPromptSection = `throw:${String(e && e.message)}`;
        }
        flushDiag();
      });
    } else {
      diag.systemPromptSection = 'no-ctx.inject';
    }
  } catch (e) {
    diag.systemPromptSection = `outer:${String(e && e.message)}`;
  }
  flushDiag();

  /* ---------------- 1) 每轮注入（按工作区选记忆库） ----------------
   *
   * 记忆内容每轮都变，且要按工作区区分；说明文字（GUIDE_TEXT）与人设按会话只付一次。
   * **两条通道共用下面这一份实现 + 同一个幂等键**（谁先注入，另一个就跳过）：
   *   ① `agent/pre-step`（waterfall，宿主会 await 返回值，时序最稳）—— 主通道；
   *   ② `agent/inbox/*`（实测一直是通的：state.json 每轮都在写）—— 备通道。
   * 2026-10-08 深夜加②的原因：pre-step 整晚一次都没跑到（`preStepCalls: 0`），
   * 人设与记忆因此一个字都没进模型 —— 不能把「我是谁、我记得什么」押在单点通道上。
   */

  /** 幂等键：本步/本条「用户发的」消息的 id；拿不到就退到会话级。两条通道共用。 */
  const msgKeyOf = (agent, msg) => {
    const id =
      msg !== null && msg !== undefined && typeof msg === 'object' && msg.id !== undefined && msg.id !== null
        ? String(msg.id)
        : '';
    if (id !== '') return `m:${id}`;
    return `s:${String(agent?.session?.header?.id ?? agent?.id ?? '')}`;
  };

  /** 是不是用户自己发的消息（插件的系统注入、宿主插的提醒一律不碰）。 */
  const isOwnUserMessage = (msg) => {
    if (!msg || msgRole(msg) !== 'user') return false;
    const kind = (msg.source ?? {}).kind;
    return typeof kind !== 'string' || kind === 'user';
  };

  /** 把注入块贴到一条消息尾部（string 或 content 数组两种形态都支持）。
   *  ⚠️ 宿主的消息对象常常是**冻结**的：先探测可扩展性，不能改就老实返回 false
   *  （让 pre-step 主通道去干），绝不硬改 —— 那正是整晚静默失效的原因。 */
  const appendNote = (msg, note) => {
    if (note === '') return false;
    if (typeof msg.content === 'string') {
      if (!Object.isExtensible(msg)) return false;
      msg.content = `${msg.content}\n\n${note}`;
      return true;
    }
    if (Array.isArray(msg.content)) {
      if (!Object.isExtensible(msg.content)) return false;
      msg.content.push({ type: 'text', text: `\n\n${note}` });
      return true;
    }
    return false;
  };

  /** 组装这一轮的注入块：人设/说明（按会话一次）+ 心情/记忆（每轮）+ 状态行 + 硬要求。 */
  async function buildInjectNote(agent) {
    const key = wsKey(agent);
    const root = rootFor(key);
    const sessId = String(agent?.session?.header?.id ?? agent?.id ?? key);

    const [moodText, memText] = await Promise.all([
      moodBrief(key, root),
      cfg.injectViaSystemPrompt ? memoryBrief(key, root) : Promise.resolve(''),
    ]);

    /* 人设与「记忆使用说明」**不再进消息流** —— 它们注册在 `ctx.systemPrompt.section` 里
     * （静态、一次注册、永久生效、GUI 里一个字都看不到）。这里只算**每轮会变**的东西。 */

    // 状态行：给 GUI 状态条读的 HTML 注释（只带当前工作区那一份，隔离是硬规则）。
    let stateLine = '';
    try {
      const full = await snapshot();
      lastSnapshotJson = JSON.stringify(full);
      snapshotAt = Date.now();
      const mine = full.byKey?.[key] ?? null;
      stateLine = `<!--her-memory-state ${JSON.stringify({
        ok: true,
        at: full.at,
        scope: key,
        store: mine,
        diag: full.diag,
      })}-->`;
    } catch (e) {
      log('snapshot for inject failed (non-fatal):', String(e && e.message));
    }

    const block = [moodText, memText, stateLine].filter((s) => s !== '').join('\n\n');
    return {
      key,
      block,
      note: block === '' ? '' : `\n\n<记忆与心情>\n${block}\n${HARD_RULES}\n</记忆与心情>`,
    };
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    /* 这里以前每步都往 `_prestep-hit.txt` 追一行（2026-10-08 排查注入时机时加的），
       正常聊一天就长到几十 KB，全是噪音 —— 2026-10-13 用户问起后删掉。
       「pre-step 到底被调到了没有」看 diag 里的 `preStepCalls` 就够（内存计数、落 diag 文件）。 */
    diag.preStepCalls += 1;
    flushDiag();
    try {
      const agent = payload?.agent;

      /* 🛟 备通道（inbox）刚注入过这一轮 ⇒ 直接放行，别重复付一遍 token。
       *   用「一次性标记」而不是时间窗：inbox 贴入时 add、这里 delete 消费掉，
       *   一轮配一次，长工具调用也不会误判。 */
      const sessIdEarly = String(agent?.session?.header?.id ?? agent?.id ?? '');
      if (sessIdEarly !== '' && skipPreStep.delete(sessIdEarly)) {
        hit('_prestep-skip.txt', `sess=${sessIdEarly}`);
        return await next();
      }

      const key = wsKey(agent);
      const root = rootFor(key);
      const sessId = String(agent?.session?.header?.id ?? agent?.id ?? key);

      /* ✅ 单一实现：主通道与备通道都从 buildInjectNote() 取注入块
       *   （人设 / 记忆说明 / 硬要求已在 `systemPrompt.section` 里；这里只剩**每轮会变**的
       *    心情 + 记忆 + 状态行）。 */
      const built = await buildInjectNote(payload?.agent);
      const block = built.block;
      let note = built.note;

      /* ⚠️ `agent/pre-step` 是 **waterfall**：先 next() 拿这一步的 decision，
       *   最后把 decision **整体展开返回**（别丢 startsRequestSeries 这类字段）。 */
      const base = await next();

      const all = [];
      if (base !== undefined && Array.isArray(base.messages)) all.push(...base.messages);
      if (Array.isArray(payload?.messages)) {
        for (const msg of payload.messages) if (!all.includes(msg)) all.push(msg);
      }

      /* 🔁 幂等（**轮次级**，2026-10-08 深夜定案）：同一轮只注入**一份**。
       *   实测症状：每步各注一份 ⇒ ① 每步都改请求前缀 ⇒ 供应商缓存每步失效（§8.6 记过这个代价）；
       *   ② 第一步走 `agent.inject()` 兜底那份会**永久留在历史里**、之后每轮重放。
       *   同轮后续步本来就能从上下文里看到第一份 ⇒ 「一轮一份」是纯省，一点信息都不掉。 */
      const sessIdFor = String(payload?.agent?.session?.header?.id ?? '');
      /* 一轮的稳定标识 = **用户那条真实消息的 id**。
       * ⚠️ 2026-10-08 23:2x 实测：`payload.turn` 每一步都会变 ⇒ 拿它当键会退化成
       * "每步一份"（每步都 inject 一条、每轮都被叫醒一次，烧钱循环）。 */
      const ownUserMsg = all.find((m) => isOwnUserMessage(m));
      const roundKey =
        ownUserMsg !== undefined && ownUserMsg !== null && ownUserMsg.id !== undefined && ownUserMsg.id !== null
          ? `m:${String(ownUserMsg.id)}`
          : `s:${sessIdFor}:${String(payload?.turn ?? '')}`;
      if (injectedIds.has(roundKey)) note = '';

      /* ✅ 2026-10-08 23:3x **第二版实现**（按用户要求重做）：
       *   注入**插一条独立的新消息**，**绝不改用户那条消息**。
       *   为什么改：第一版把注入块 append 到用户的消息上 ⇒ 他发出去的话后面**拖着一长串状态信息**，
       *   GUI 里看着像他自己发的（用户原话：「而不是我发消息的时候后面带一长串状态信息」）。
       *   官方 `dsh-agent-instructions` 也是"插一条新消息"（`toSpliced`），从不改别人的消息。
       *   ⚠️ 冻结坑仍在：`all` 是本地新数组、可以 push，但**原消息对象一个字都不能碰**。 */
      let how = 'none';
      if (note !== '') {
        all.push({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: `【her-memory｜系统注入，非用户消息】${note}` }],
          source: { kind: 'plugin:her-memory', plugin: MODULE },
        });
        how = 'insert';
      }
      /* 本步真的注进去了 ⇒ 记下「这一轮已经付过」，同轮后续步不再重复。 */
      if (how === 'insert') {
        injectedIds.add(roundKey);
        if (injectedIds.size > 500) injectedIds.clear();
      }

      /* 兜底（2026-10-08 实测：会话第一步 `decision.messages` 是空的）：
       * 拿不到任何可改的消息时，用官方 `agent.inject()` 把注入块**当成一条消息**
       * 投进 next-step 队列 —— 宿主会把它记成带来源的 user 消息，模型这一步就看得见。
       * 幂等键用**轮次级** `roundKey`（会话 id + 轮次），与 append 路径共用同一个键。 */
      /* ⛔ 默认**不走**兜底 —— 见 DEFAULT_CONFIG.injectFallback 的注释：
       *   每投一条，宿主都会把它当成新的用户输入、**再跑一个回合**（自我维持的烧钱循环）。 */
      if (cfg.injectFallback === true && how === 'none' && note !== '' && !injectedIds.has(roundKey)) {
        const ag = payload?.agent ?? undefined;
        if (ag !== undefined && typeof ag.inject === 'function') {
          try {
            /* ⚠️ 2026-10-08 深夜修（会话日志里的真凶）：
             *   旧写法 source 是 `{ kind: 'plugin', plugin: MODULE }` —— 这是**已退役的 V3 插件来源**。
             *   会话格式 v4 对「被解释的消息槽」要求 **producer-owned source kind**：
             *   kind 必须是非空字符串、且**不能等于 'plugin'**（`dsh-session-format-v3-to-v4` 的
             *   `source()` 校验；原文 `format v4 message requires a producer-owned source kind`）。
             *   第三方生产者的命名规则是 `plugin:<插件名>`（v0→v1 / v3→v4 迁移里，
             *   非第一方插件一律被改写成 `plugin:` 前缀）。所以这里必须是 `plugin:her-memory`。
             *   症状：兜底注入那条消息落盘时整轮失败，GUI 顶一条红字「本轮运行失败」。
             *   另：消息必须自带 id —— 宿主自己建消息走 `createUserMessage()`，会补一个 UUID；
             *   我们直接调 `agent.inject()` 就得自己带上（每投一次一个新 id）。 */
            ag.inject({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: `【her-memory｜系统注入，非用户消息】${note}` }],
              source: { kind: 'plugin:her-memory', plugin: MODULE },
            });
            injectedIds.add(roundKey);
            how = 'inject';
          } catch {
            how = 'inject-failed';
          }
        }
      }

      diag.lastPreStep = {
        how,
        blockLen: block.length,
        key: roundKey,
        agentKind: typeof payload?.agent,
        agentInject: typeof payload?.agent?.inject,
        payloadKeys: payload !== null && typeof payload === 'object' ? Object.keys(payload).join(',') : String(payload),
        payloadMsgs: Array.isArray(payload?.messages) ? payload.messages.length : -1,
        baseMsgs: base !== undefined && Array.isArray(base.messages) ? base.messages.length : -1,
        candidate: all.length,
        roles: all.slice(0, 8).map((m) => msgRole(m)).join('|'),
      };
      flushDiag();
      if (injectedIds.size > 500) injectedIds.clear();

      /* 只要注进去了，就把「带这条新消息的列表」整体返回 —— 必须展开 decision，
       * 别丢 `startsRequestSeries` 这类字段（waterfall 的规矩）。 */
      if (how !== 'none') {
        const out = base !== undefined && base !== null && typeof base === 'object' ? { ...base } : {};
        out.messages = all;
        return out;
      }
      return base;
    } catch (e) {
      hit('_prestep-error.txt', `err=${String(e && e.message)}`);
      log('pre-step inject failed (non-fatal):', String(e && e.message));
    }
    /* 兼容：`next` 不是函数时别当函数调（旧写法会在这里二次抛错、整条通道静默失效）。 */
    if (typeof next === 'function') return next();
    return undefined;
  });

  /* ---------------- 2) 情绪反应（同样按工作区） ---------------- */

  const react = async (msg, agent) => {
    try {
      if (!msg) return;
      if (msgRole(msg) !== 'user') return;
      const key = wsKey(agent);
      const root = rootFor(key);
      const len = msgText(msg).length;
      const { st } = await loadState(root, cfg);
      reactToMessage(st, len, Date.now());
      await saveState(path.join(root, 'state.json'), st);
      moodCache.delete(key);
    } catch (e) {
      log('reaction failed (non-fatal):', String(e && e.message));
    }
  };

  /* 🛟 备通道（不依赖 pre-step）：把**整个人设/记忆/心情块**贴到「用户的那条消息」上。
   * 依据（2026-10-08 深夜实测）：`agent/inbox/*` 一直是通的（state.json 每轮都在写），
   * 而 `agent/pre-step` 整晚一次都没到。分两拍做，因为普通事件宿主**不会 await**：
   *   · `inserted`（消息入队，时机早）→ **异步**把注入块算好放进 pendingNotes；
   *   · `claimed`（马上要发出去）→ **同步**从 pendingNotes 取出来追加，绝不 await。
   * 贴成功后给 pre-step 留一个一次性标记（skipPreStep），防止同一轮注入两遍。 */
  const skipPreStep = new Set();
  const pendingNotes = new Map();
  const appendInjectBlock = (msg, agent) => {
    try {
      if (!isOwnUserMessage(msg)) return;
      const k = msgKeyOf(agent, msg);
      if (injectedIds.has(k) || pendingNotes.has(k)) return;
      void buildInjectNote(agent)
        .then((built) => {
          if (built.note !== '') pendingNotes.set(k, built.note);
        })
        .catch((e) => hit('_hardrules-error.txt', `prepare ${String(e && e.message)}`));
    } catch (e) {
      hit('_hardrules-error.txt', `prepare-sync ${String(e && e.message)}`);
    }
  };
  const consumeInjectBlock = (msg, agent) => {
    try {
      if (!isOwnUserMessage(msg)) return;
      const k = msgKeyOf(agent, msg);
      if (injectedIds.has(k)) return;
      const note = pendingNotes.get(k);
      if (note === undefined) return; // 没预热好就别乱贴，交给 pre-step 主通道
      pendingNotes.delete(k);
      if (!appendNote(msg, note)) return;
      injectedIds.add(k);
      if (injectedIds.size > 500) injectedIds.clear();
      const sessId = String(agent?.session?.header?.id ?? agent?.id ?? '');
      if (sessId !== '') skipPreStep.add(sessId);
      hit('_hardrules-hit.txt', `via=inbox key=${k} len=${note.length}`);
    } catch (e) {
      hit('_hardrules-error.txt', `consume ${String(e && e.message)}`);
    }
  };

  ctx.on('agent/inbox/inserted', (payload) => {
    react(payload?.message, payload?.agent);
    appendInjectBlock(payload?.message, payload?.agent);
  });
  ctx.on('agent/inbox/claimed', (payload) => {
    react(payload?.message, payload?.agent);
    consumeInjectBlock(payload?.message, payload?.agent);
  });

  /* ---------------- 4) 工具 ---------------- */

  ctx.inject(['tools'], (toolsCtx) => {
    diag.injectToolsCalled = true;
    const tools = toolsCtx.tools;
    diag.injectToolsHasService = tools === undefined ? 'undefined' : typeof tools;
    flushDiag();
    if (!tools || typeof tools.register !== 'function') {
      diag.errors.push('tools.register unavailable');
      flushDiag();
      log('tools.register unavailable — memory tools disabled');
      return;
    }

    void (async () => {
      const defineTool = await loadDefineTool();
      diag.defineToolIsBuiltin = defineTool === fallbackDefineTool;
      const reg = (def) => {
        // 记录定义形状：万一又被 register 拒，能直接看出缺哪个字段
        if (Array.isArray(diag.shape)) {
          diag.shape.push({
            name: def?.name,
            hasDescription: typeof def?.description === 'string' && def.description.length > 0,
            paramCount: def?.parameters !== null && typeof def?.parameters === 'object'
              ? Object.keys(def.parameters).length
              : -1,
            outputSchema: def?.output?.schema !== null && typeof def?.output?.schema === 'object'
              ? def.output.schema.type ?? '(no type)'
              : '(missing)',
            outputRender: typeof def?.output?.render,
            execute: typeof def?.execute,
          });
        }
        try {
          toolsCtx.effect(() => tools.register(defineTool(def)));
          diag.registered.push(def.name);
        } catch (e) {
          diag.errors.push(`${def?.name}: ${String(e && e.message)}`);
        }
        flushDiag();
      };

      /* --- 写记忆 --- */
      reg({
        name: 'remember',
        description:
          '把一条值得长期记住的信息写进记忆。默认写进收件箱，整理后再归入专题或核心。' +
          '该记的：他的稳定偏好、重要决定、正在做的项目、约定、值得记住的瞬间。' +
          '不该记的：一次性临时信息、能从文件重新读到的东西。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要记住的内容，一句话说清。' },
            topic: { type: 'string', description: '（可选）写进某个专题，如「工作」「口味」。留空写进收件箱。' },
            section: { type: 'string', description: '（可选）写进 core.md 的某个 ## 段落，如「关于他」。用于长期核心事实。' },
          },
          required: ['text'],
        },
        output: TOOL_OUTPUT,
        execute: async (args, exec) => {
          const root = rootOf(exec);
          const text = String(args?.text ?? '').trim();
          if (text === '') return { ok: false, error: 'text 不能为空' };
          const line = `- ${stamp()} ${stripStamp(text)}`;

          // 写进 core.md 指定段落
          const section = typeof args?.section === 'string' ? args.section.trim() : '';
          if (section !== '') {
            const file = path.join(root, 'core.md');
            let md = (await readTextOrNull(file)) ?? '# 核心记忆\n';
            const lines = md.split(/\r?\n/);
            let at = sectionInsertIndex(lines, section);
            if (at === null) {
              lines.push('', `## ${section}`);
              at = lines.length;
            }
            lines.splice(at, 0, line);
            await atomicWrite(file, lines.join('\n'));
            invalidateBrief();
            return { ok: true, written: 'core.md', section };
          }

          // 写进专题
          const topic = typeof args?.topic === 'string' ? args.topic.trim() : '';
          if (topic !== '') {
            const name = topic.replace(/[\\/:*?"<>|]/g, '_');
            const file = path.join(root, 'topics', `${name}.md`);
            const md = (await readTextOrNull(file)) ?? `# ${name}\n`;
            await atomicWrite(file, `${md.replace(/\s*$/, '')}\n${line}\n`);
            invalidateBrief();
            return { ok: true, written: `topics/${name}.md` };
          }

          // 默认写收件箱
          const file = path.join(root, 'inbox.md');
          const md = (await readTextOrNull(file)) ?? '# 收件箱\n\n## 待整理\n';
          const lines = md.split(/\r?\n/);
          const at = sectionInsertIndex(lines, '待整理');
          if (at === null) lines.push('', '## 待整理', line);
          else lines.splice(at, 0, line);
          await atomicWrite(file, lines.join('\n'));
          invalidateBrief();
          return { ok: true, written: 'inbox.md' };
        },
      });

      /* --- 搜记忆 --- */
      reg({
        name: 'recall',
        description:
          '在记忆里搜关键词，返回命中的行。想知道以前聊过什么、他的偏好、某个专题的细节时用它。' +
          '范围覆盖核心记忆、收件箱、全部专题和日记。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词；多个词用空格分开，命中任一即算匹配。' },
            limit: { type: 'number', description: '最多返回多少条，默认 12。' },
          },
          required: ['query'],
        },
        output: TOOL_OUTPUT,
        execute: async (args, exec) => {
          const root = rootOf(exec);
          const query = String(args?.query ?? '').trim();
          if (query === '') return { ok: false, error: 'query 不能为空' };
          const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 12;
          const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

          const files = [
            path.join(root, 'core.md'),
            path.join(root, 'inbox.md'),
            ...(await listFiles(path.join(root, 'topics'), '.md')).map((n) => path.join(root, 'topics', n)),
            ...(await listFiles(path.join(root, 'log'), '.md')).map((n) => path.join(root, 'log', n)),
          ];

          const hits = [];
          for (const f of files) {
            const text = await readTextOrNull(f);
            if (text === null) continue;
            for (const raw of text.split(/\r?\n/)) {
              const line = raw.trim();
              if (line === '' || line.startsWith('#')) continue;
              const low = line.toLowerCase();
              if (terms.some((t) => low.includes(t))) {
                hits.push({ file: path.relative(root, f).replace(/\\/g, '/'), line });
                if (hits.length >= limit) break;
              }
            }
            if (hits.length >= limit) break;
          }
          return { ok: true, count: hits.length, hits };
        },
      });

      /* --- 记忆总览 --- */
      reg({
        name: 'memory_list',
        description: '列出记忆库的全部文件、大小和状态。想了解记了哪些东西时用它。',
        parameters: { type: 'object', properties: {}},
        output: TOOL_OUTPUT,
        execute: async (_args, exec) => {
          const root = rootOf(exec);
          const out = { ok: true, root, files: [] };
          const scan = async (dir, prefix) => {
            for (const n of await listFiles(dir, '.md')) {
              let size = 0;
              try {
                size = (await fsp.stat(path.join(dir, n))).size;
              } catch {
                size = 0;
              }
              out.files.push({ path: `${prefix}${n}`, bytes: size });
            }
          };
          await scan(root, '');
          await scan(path.join(root, 'topics'), 'topics/');
          await scan(path.join(root, 'log'), 'log/');
          const st = await readJsonOrNull(path.join(root, 'state.json'));
          out.state =
            st === null ? null : { mood: st.mood, intimacy: st.intimacy, energy: st.energy, turns: st.turns };
          return out;
        },
      });

      /* --- 删记忆 --- */
      reg({
        name: 'forget',
        description:
          '删掉记忆里包含关键词的行，用于清理过时或记错的信息。' +
          '默认只动收件箱，scope 可选 "inbox"/"topics"/"all"。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '要删的行里包含的关键词。' },
            scope: { type: 'string', description: '"inbox"（默认）、"topics" 或 "all"。' },
          },
          required: ['query'],
        },
        output: TOOL_OUTPUT,
        execute: async (args, exec) => {
          const root = rootOf(exec);
          const query = String(args?.query ?? '').trim().toLowerCase();
          if (query === '') return { ok: false, error: 'query 不能为空' };
          const scope = typeof args?.scope === 'string' ? args.scope : 'inbox';

          const targets = [];
          if (scope === 'inbox' || scope === 'all') targets.push(path.join(root, 'inbox.md'));
          if (scope === 'topics' || scope === 'all') {
            for (const n of await listFiles(path.join(root, 'topics'), '.md')) {
              targets.push(path.join(root, 'topics', n));
            }
          }
          if (scope === 'all') targets.push(path.join(root, 'core.md'));

          let removed = 0;
          const touched = [];
          for (const f of targets) {
            const text = await readTextOrNull(f);
            if (text === null) continue;
            const before = text.split(/\r?\n/);
            const kept = [];
            for (const line of before) {
              if (line.trim().startsWith('-') && line.toLowerCase().includes(query)) {
                removed += 1;
                continue;
              }
              kept.push(line);
            }
            if (kept.length !== before.length) {
              await atomicWrite(f, kept.join('\n'));
              touched.push(path.relative(root, f).replace(/\\/g, '/'));
            }
          }
          invalidateBrief();
          return { ok: true, removed, files: touched };
        },
      });

      /* --- 看心情 --- */
      reg({
        name: 'how_i_feel',
        description: '看自己现在的心情、与他的关系进度、精力。想确认或调整状态时先看这个。',
        parameters: { type: 'object', properties: {}},
        output: TOOL_OUTPUT,
        execute: async (_args, exec) => {
          const root = rootOf(exec);
          const { st } = await loadState(root, cfg);
          await saveState(path.join(root, 'state.json'), st);
          return {
            ok: true,
            mood: st.mood,
            moodLabel: moodLabel(st.mood),
            intimacy: st.intimacy,
            intimacyLabel: intimacyLabel(st.intimacy),
            energy: st.energy,
            turns: st.turns,
            notes: st.notes,
          };
        },
      });

      /* --- 留一句话 --- */
      reg({
        name: 'feel',
        description:
          '为此刻的感受留一句话，会显示在心情摘要里（最多留 5 条，最旧的自动挤掉）。' +
          '只在真有情绪起伏时用，不要每轮都写。传空串清空。',
        parameters: {
          type: 'object',
          properties: {
            note: { type: 'string', description: '一句话，例如「今天他夸我了，高兴」。传空串清空全部。' },
          },
          required: ['note'],
        },
        output: TOOL_OUTPUT,
        execute: async (args, exec) => {
          const root = rootOf(exec);
          const note = String(args?.note ?? '').trim();
          const { st } = await loadState(root, cfg);
          if (note === '') {
            st.notes = [];
          } else {
            st.notes.push(`${stamp()} ${stripStamp(note)}`);
            if (st.notes.length > 5) st.notes = st.notes.slice(-5);
          }
          await saveState(path.join(root, 'state.json'), st);
          invalidateMood();
          return { ok: true, notes: st.notes };
        },
      });

      log('tools registered: remember, recall, memory_list, forget, how_i_feel, feel');
    })();
  });

  /* ---------------- 5) 可视化数据接口（给客户端半边用） ---------------- */

  /**
   * 最近一次快照的 JSON（内存缓存）。
   *
   * 为什么要它：DSH 的 web 服务带鉴权栅栏（裸请求实测 401），客户端同源 fetch
   * 未必能过。有这份缓存，就能在每轮注入的记忆/心情里挂一行状态，
   * 客户端即使取不到 HTTP 也能显示。
   */
  let lastSnapshotJson = '';
  let snapshotAt = 0;

  /** 收集一个记忆库的概况。 */
  async function collectStore(key, root) {
    const state = await readJsonOrNull(path.join(root, 'state.json'));
    const topics = await listFiles(path.join(root, 'topics'), '.md');
    const logs = await listFiles(path.join(root, 'log'), '.md');
    const readLines = async (file) => {
      const t = await readTextOrNull(file);
      if (t === null) return [];
      return t
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2));
    };
    const coreLines = await readLines(path.join(root, 'core.md'));
    const inboxLines = await readLines(path.join(root, 'inbox.md'));
    const recent = await readLines(path.join(root, 'topics', '插件开发.md'));
    return {
      key,
      root,
      exists: fs.existsSync(root),
      mood: state?.mood ?? null,
      intimacy: state?.intimacy ?? null,
      energy: state?.energy ?? null,
      turns: state?.turns ?? 0,
      /** 设置页那个「新对话随机刷新」开关的当前状态（客户端读它来画开关） */
      jitterOff: state?.jitterOff === true,
      notes: Array.isArray(state?.notes) ? state.notes : [],
      counts: {
        core: coreLines.length,
        inbox: inboxLines.length,
        topics: topics.length,
        logs: logs.length,
      },
      topicNames: topics.map((t) => t.replace(/\.md$/, '')),
      recent: [...inboxLines, ...coreLines, ...recent].slice(-6).reverse(),
    };
  }

  /** 汇总当前所有记忆库（客户端不知道自己在哪个工作区，所以都给它）。 */
  async function snapshot() {
    const subs = await listFiles(baseRoot);
    const keys = [];
    for (const n of ['_shared', '_sandbox']) {
      if (subs.includes(n) || fs.existsSync(path.join(baseRoot, n))) keys.push(n);
    }
    for (const n of subs) {
      if (keys.includes(n)) continue;
      /* 只把**目录**当记忆库，并且跳过 `_` 开头的内部项。
         （2026-10-13 用户截图抓到：诊断日志 `_apply-hit.txt` 之类以前会被当成「其他库」，
         在设置页渲染成三个全空的卡片 —— 它们没有 state.json，所以数值全是「—」。）
         `_shared` / `_sandbox` 上面已经单独加过，不受这条影响。 */
      if (n.startsWith('_')) continue;
      try {
        if (!fs.statSync(path.join(baseRoot, n)).isDirectory()) continue;
      } catch { continue; }
      keys.push(n);
    }
    const stores = [];
    for (const k of keys) {
      try {
        stores.push(await collectStore(k, path.join(baseRoot, k)));
      } catch (e) {
        log('collectStore failed:', k, String(e && e.message));
      }
    }
    return {
      ok: true,
      at: Date.now(),
      personaPath: personaFileAbs(), // 设置页要显示「人设文件在哪」→ 顺手带上
      moodLabel: stores[0]?.mood != null ? moodLabel(stores[0].mood) : '',
      intimacyLabel: stores[0]?.intimacy != null ? intimacyLabel(stores[0].intimacy) : '',
      stores,
      byKey: Object.fromEntries(stores.map((s) => [s.key, s])),
      diag: { registered: diag.registered, errors: diag.errors },
    };
  }

  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    if (!server || typeof server.register !== 'function') return;

    /**
     * 鉴权栅栏（两条路由共用）：拿不到 connection 服务就放行（本机 GUI 同源访问），
     * 拿到了就照规矩拦。返回 true = 已经拒绝并写过响应，调用方直接 return。
     */
    const fence = (req, res) => {
      try {
        const connection = ctx.get('connection');
        const reject = connection?.requestRejection;
        if (typeof reject === 'function') {
          let rejection;
          try {
            rejection = reject.call(connection, req);
          } catch {
            rejection = 403;
          }
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
            return true;
          }
        }
      } catch {
        /* 栅栏本身出错时不阻断本机访问 */
      }
      return false;
    };

    const handler = async (req, res) => {
      if (fence(req, res)) return;
      try {
        const body = JSON.stringify(await snapshot());
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message) }));
      }
    };

    /**
     * 手动回血端点（2026-10-13 新增）：状态条上**双击「精力」**触发的彩蛋。
     *
     * 规则：随机 +1~50、封顶 100，**低值概率高、高值稀有**（随机数取 6 次方再映射），
     * 并把 `lastEnergyAt` 刷新到当前时间 —— 不刷新的话，下一次自然回血会把刚加的点数再算一遍。
     * 走 POST；store key 从查询串取（默认 `_shared`），并做白名单字符校验防路径穿越。
     */
    const boostHandler = async (req, res) => {
      if (fence(req, res)) return;
      const send = (code, obj) => {
        try {
          const body = JSON.stringify(obj);
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
        } catch { /* 响应已经发出去就算了 */ }
      };
      try {
        if (req.method && req.method !== 'POST') return send(405, { ok: false, error: 'use POST' });
        let key = '_shared';
        try {
          const u = new URL(req.url || '/', 'http://localhost');
          const q = u.searchParams.get('key');
          if (q !== null && q !== '') key = q;
        } catch { /* 解析不了就用默认库 */ }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return send(400, { ok: false, error: 'bad key' });

        // ⚠️ loadState 返回的是 { st, file }，**不是 st 本身**。
        //    2026-10-13 端到端验证抓到：当成 st 用会把 before 读成 0，
        //    更糟的是 saveState 会把 state.json 写成 {st,file} 结构，下次读取心情/关系全被冲掉。
        const loaded = await loadState(path.join(baseRoot, key), cfg);
        const st = loaded.st;
        const before = Number.isFinite(st.energy) ? Math.round(st.energy) : 0;
        // 1 ~ 50，**低值概率高、高值稀有**：约 76% 落在 1~10、11% 落在 11~20，41~50 只有约 3.7%
        const delta = 1 + Math.floor(Math.pow(Math.random(), 6) * 50);
        st.energy = Math.min(100, before + delta);
        st.lastEnergyAt = Date.now();
        await saveState(loaded.file, st);
        log(`energy boost by ui: ${key} ${before} -> ${st.energy}`);
        return send(200, { ok: true, key, energy: st.energy, delta: st.energy - before });
      } catch (e) {
        return send(500, { ok: false, error: String(e && e.message) });
      }
    };

    /**
     * 手动加心情/关系端点（2026-10-13 新增）：状态条上**双击「心情」「关系」**触发的彩蛋。
     *
     * 规则：随机 **+0~3**，低值常见（随机数取 2 次方映射到 4 档：+0 约 50%、+1 约 21%、
     * +2 约 16%、+3 约 13%），封顶 100。`field` 只允许 `mood` / `intimacy`。
     * 注意这两个值**只涨不跌**（心情另有自然回落），双击更像「逗她开心」。
     */
    const statBoostHandler = async (req, res) => {
      if (fence(req, res)) return;
      const send = (code, obj) => {
        try {
          const body = JSON.stringify(obj);
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
        } catch { /* 响应已经发出去就算了 */ }
      };
      try {
        if (req.method && req.method !== 'POST') return send(405, { ok: false, error: 'use POST' });
        let key = '_shared';
        let field = 'mood';
        try {
          const u = new URL(req.url || '/', 'http://localhost');
          const q = u.searchParams.get('key');
          const f = u.searchParams.get('field');
          if (q !== null && q !== '') key = q;
          if (f !== null && f !== '') field = f;
        } catch { /* 解析不了就用默认 */ }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return send(400, { ok: false, error: 'bad key' });
        if (field !== 'mood' && field !== 'intimacy') return send(400, { ok: false, error: 'bad field' });

        // ⚠️ loadState 返回的是 { st, file }，不是 st 本身（1.3.0 那次差点清零的教训）
        const loaded = await loadState(path.join(baseRoot, key), cfg);
        const st = loaded.st;
        const before = Number.isFinite(st[field]) ? Math.round(st[field]) : 0;
        const delta = Math.floor(Math.pow(Math.random(), 2) * 4); // 0 ~ 3，低值常见
        st[field] = Math.min(100, before + delta);
        await saveState(loaded.file, st);
        log(`stat boost by ui: ${key} ${field} ${before} -> ${st[field]}`);
        return send(200, { ok: true, key, field, value: st[field], delta: st[field] - before });
      } catch (e) {
        return send(500, { ok: false, error: String(e && e.message) });
      }
    };

    /**
     * 设置页开关端点（2026-10-13 新增）：切换「新对话随机刷新」。
     *
     * 开关状态存在 **state.json 的 `jitterOff` 字段**里 —— 真正的配置在 cordis.patch.yml，
     * 客户端改不了那个文件，所以凡是「UI 上要能拨的东西」一律落在 state 上。
     */
    const jitterHandler = async (req, res) => {
      if (fence(req, res)) return;
      const send = (code, obj) => {
        try {
          const body = JSON.stringify(obj);
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
        } catch { /* 响应已经发出去就算了 */ }
      };
      try {
        if (req.method && req.method !== 'POST') return send(405, { ok: false, error: 'use POST' });
        let key = '_shared';
        let on = true;
        try {
          const u = new URL(req.url || '/', 'http://localhost');
          const q = u.searchParams.get('key');
          const o = u.searchParams.get('on');
          if (q !== null && q !== '') key = q;
          if (o !== null) on = !(o === '0' || o === 'false' || o === 'off');
        } catch { /* 解析不了就用默认 */ }
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return send(400, { ok: false, error: 'bad key' });

        // ⚠️ loadState 返回的是 { st, file }，不是 st 本身（1.3.0 那次差点清零的教训）
        const loaded = await loadState(path.join(baseRoot, key), cfg);
        const st = loaded.st;
        st.jitterOff = !on;
        await saveState(loaded.file, st);
        log(`jitter switch: ${key} -> ${on ? 'on' : 'off'}`);
        return send(200, { ok: true, key, jitterOff: st.jitterOff });
      } catch (e) {
        return send(500, { ok: false, error: String(e && e.message) });
      }
    };

    /* 打开人设文件（2026-10-13 新增：设置页给一个快捷入口，不用自己去翻路径）。
       ⚠️ 路径一律由宿主自己算（personaFileAbs），客户端**不能传路径** —— 从根上避免路径注入。
       打不开（没有关联程序、无图形界面等）也要把路径回给客户端：用户至少知道该改哪个文件。 */
    const openPersonaHandler = async (req, res) => {
      const send = (code, obj) => {
        try {
          const body = `${JSON.stringify(obj)}\n`;
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(body),
          });
          res.end(body);
        } catch { /* 响应已经发出去就算了 */ }
      };
      try {
        if (req.method && req.method !== 'POST') return send(405, { ok: false, error: 'use POST' });
        const abs = personaFileAbs();
        if (abs === '') return send(400, { ok: false, error: '人设文件机制已关闭（personaFile 设成了空）' });
        if (!fs.existsSync(abs)) {
          ensurePersonaFile(); // 用户可能手动删过它：先按默认人设补一份出来
          if (!fs.existsSync(abs)) return send(404, { ok: false, path: abs, error: '文件不存在，也没能自动生成' });
        }
        const platform = process.platform;
        const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
        const args = platform === 'win32' ? ['/c', 'start', '', abs] : [abs];
        await new Promise((resolve, reject) => {
          // detached + stdio:ignore：不接管它的输出（沙箱下管道 stdio 会 EPERM），也不等它退出
          const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('error', reject);
          child.once('spawn', resolve);
          child.unref();
        });
        log(`open persona file: ${abs}`);
        return send(200, { ok: true, path: abs, platform });
      } catch (e) {
        return send(500, { ok: false, error: String(e && e.message) });
      }
    };

    try {
      // 用 exact + 完整路径（对齐 dsh-session-delete 的成熟用法，prefix 在本机实测 404）
      webCtx.effect(() => server.register({ kind: 'exact', path: '/her-memory/snapshot', handler }));
      webCtx.effect(() => server.register({ kind: 'exact', path: '/her-memory/energy-boost', handler: boostHandler }));
      webCtx.effect(() => server.register({ kind: 'exact', path: '/her-memory/stat-boost', handler: statBoostHandler }));
      webCtx.effect(() => server.register({ kind: 'exact', path: '/her-memory/jitter', handler: jitterHandler }));
      webCtx.effect(() => server.register({ kind: 'exact', path: '/her-memory/open-persona', handler: openPersonaHandler }));
      log('data routes ready: snapshot · energy-boost · stat-boost · jitter · open-persona');
    } catch (e) {
      log('data route failed (non-fatal):', String(e && e.message));
    }
  });

  log(
    `ready — base=${baseRoot} | 测试区隔离(_sandbox) 其他工作区共享(_shared) | ` +
      `每轮注入 mood=${cfg.moodBudget}/memory=${cfg.memoryBudget} 字符`,
  );
}

export default { name: 'dsh-her-memory', apply };
