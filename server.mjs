#!/usr/bin/env node
// server.mjs —— @local/mcp-rea：把 REA（逆向工程 CLI）以「精选小工具面 + CLI 逃生舱」暴露为 MCP stdio 服务器。
// 为什么不让宿主直连 `rea --mcp`：REA 原生 MCP 面有 139 个工具 / 约 1.8 MB schema，且 dsh-mcp-client 无工具过滤字段，
// 会让每个请求的 prefill 塞进几十万字符。这里只暴露 10 个高频工具 + 1 个通用逃生舱（schema 共约 10 KB）。
// 后端：钉版 rea-agents（建议 pin 版本；路径经 REA_ENTRY 指定），每次调用现起 CLI 进程（REA 自身的 MCP 也是进程级，开销相当）。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

// —— 配置（全部可经环境变量覆盖；默认走 PATH 上的 rea，便于跨机器）——
// REA_ENTRY：rea-agents 的 scripts/rea.mjs 绝对路径（推荐——钉版本、跨机器一致）；
//            不设则退化为调用 PATH 上的 rea CLI（可执行名经 REA_CLI 覆盖）。
const REA_ENTRY = process.env.REA_ENTRY || '';
const REA_CLI = process.env.REA_CLI || 'rea';
const NODE_BIN = process.env.REA_NODE || process.execPath;
const WORKSPACE = process.env.REA_WORKSPACE || process.cwd();
const MAX_BYTES = Number(process.env.REA_MAX_BYTES || 65536);
const TIMEOUT_MS = Number(process.env.REA_TIMEOUT_MS || 120000);
const FORMAT = process.env.REA_FORMAT || 'json';
// 原生分析提供方（Ghidra）：直接注入子进程环境——宿主进程往往比「你改环境变量」起得更早，
// 写在这里立即生效，且不污染全局 JAVA_HOME。
const GHIDRA_DIR = process.env.REA_GHIDRA_DIR || '';
const JAVA_HOME = process.env.REA_JAVA_HOME || process.env.JAVA_HOME || '';
const PROVIDER_ENV = {
  ...(GHIDRA_DIR && existsSync(GHIDRA_DIR) ? { GHIDRA_INSTALL_DIR: GHIDRA_DIR } : {}),
  ...(JAVA_HOME && existsSync(JAVA_HOME) ? { JAVA_HOME } : {}),
};

// —— 精选工具表：name → { desc, props, required, argv } ——
// argv(args) 返回 [reaCommand, ...cliArgs]；一律附加 --format <FORMAT>。
const TOOLS = [
  { name: 'rea_doctor', desc: '检查本机 REA 环境是否就绪（引擎/提供方可用性）。', props: {}, argv: () => ['doctor'] },
  { name: 'rea_capabilities', desc: '列出 REA 各分析提供方及其能力与副作用。', props: {}, argv: () => ['capabilities'] },
  { name: 'rea_analyze', desc: '概览一个应用（本地路径或包）的整体结构。', props: { target: { type: 'string', description: '目标路径/标识' } }, required: ['target'], argv: (a) => ['analyze', a.target] },
  { name: 'rea_analyze_js', desc: '静态重建本地 JavaScript/Electron 应用的模块与图（Web 前端/Electron 适用，Windows 无需 Ghidra）。', props: { path: { type: 'string', description: '应用目录（建议先复制到干净目录，勿含 node_modules）' } }, required: ['path'], argv: (a) => ['analyze-javascript-application', a.path] },
  { name: 'rea_analyze_web', desc: '抓取并静态分析一个网页 bundle（给定来源 URL/页面）。', props: { url: { type: 'string', description: '目标 URL' } }, required: ['url'], argv: (a) => ['analyze-web-bundle', a.url] },
  { name: 'rea_inspect', desc: '带证据地检视一个应用概览（比 analyze 更结构化）。', props: { target: { type: 'string' } }, required: ['target'], argv: (a) => ['inspect', a.target] },
  { name: 'rea_decompile', desc: '把应用的一部分当代码读出来（反编译）。', props: { target: { type: 'string', description: '符号/地址/模块标识' } }, required: ['target'], argv: (a) => ['decompile', a.target] },
  { name: 'rea_function', desc: '带证据地分析单个完整函数。', props: { target: { type: 'string' } }, required: ['target'], argv: (a) => ['function', a.target] },
  { name: 'rea_extract_artifact', desc: '安全提取某个制品（包/归档）的全部常规内容。', props: { path: { type: 'string' } }, required: ['path'], argv: (a) => ['extract-artifact', a.path] },
  { name: 'rea_extract_firmware', desc: '按范围提取固件字节并返回已校验文件与出处。', props: { path: { type: 'string' }, args: { type: 'array', items: { type: 'string' }, description: '额外 CLI 参数（范围等）' } }, required: ['path'], argv: (a) => ['extract-firmware', a.path, ...(a.args ?? [])] },

  // —— 第二批（2026-10-10 扩展：10 → 20）——参数按各命令 `--schema` 实录，其余细节走 args 透传 ——
  {
    name: 'rea_capture_web_shot',
    desc: '抓取一个可见页面视口（CDP：endpoint + targetId 来自 list-browser-targets）。',
    props: { endpoint: { type: 'string', description: '本机回环 CDP HTTP 端点' }, targetId: { type: 'string', description: 'list-browser-targets 得到的 target id' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['endpoint', 'targetId'], argv: (a) => ['capture-web-screenshot', a.endpoint, a.targetId, ...(a.args ?? [])],
  },
  {
    name: 'rea_export_web_scripts',
    desc: '把已保存的页面/场景捕获里的脚本导出到指定目录（静态分析用）。',
    props: { capturePath: { type: 'string', description: '已保存捕获 JSON 的绝对路径' }, outputDirectory: { type: 'string', description: '不存在的输出目录绝对路径' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['capturePath', 'outputDirectory'], argv: (a) => ['export-web-scripts', a.capturePath, a.outputDirectory, ...(a.args ?? [])],
  },
  {
    name: 'rea_observe_js_runtime',
    desc: '被动观察一个 Node/Electron Inspector 目标（endpoint + targetId 来自 list-javascript-runtime-targets）。',
    props: { endpoint: { type: 'string', description: '回环 Inspector 端点' }, targetId: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['endpoint', 'targetId'], argv: (a) => ['observe-javascript-runtime', a.endpoint, a.targetId, ...(a.args ?? [])],
  },
  {
    name: 'rea_discover_webmcp',
    desc: '被动发现页面声明的 WebMCP 工具（CDP：endpoint + targetId）。',
    props: { endpoint: { type: 'string' }, targetId: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['endpoint', 'targetId'], argv: (a) => ['discover-webmcp-tools', a.endpoint, a.targetId, ...(a.args ?? [])],
  },
  {
    name: 'rea_compare_versions',
    desc: '比较两个已认证的 JavaScript 应用图版本（workflow JSON：内联或文件路径）。',
    props: { inputJson: { type: 'string', description: '内联 workflow JSON 或 JSON 文件路径' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['inputJson'], argv: (a) => ['compare-application-versions', a.inputJson, ...(a.args ?? [])],
  },
  {
    name: 'rea_compare_web',
    desc: '归一化比较两次网页捕获（各自 JSON：内联或路径）。',
    props: { beforeJson: { type: 'string' }, afterJson: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['beforeJson', 'afterJson'], argv: (a) => ['compare-web-captures', a.beforeJson, a.afterJson, ...(a.args ?? [])],
  },
  {
    name: 'rea_evidence_export',
    desc: '校验并原子导出规范 Evidence JSON（source → output）。',
    props: { source: { type: 'string', description: '现有证据包 JSON 路径' }, output: { type: 'string', description: '规范输出 JSON 路径' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['source', 'output'], argv: (a) => ['evidence-export', a.source, a.output, ...(a.args ?? [])],
  },
  {
    name: 'rea_evidence_import',
    desc: '校验并导入一个有界的本地 Evidence 包。',
    props: { path: { type: 'string', description: '证据包 JSON 路径' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['path'], argv: (a) => ['evidence-import', a.path, ...(a.args ?? [])],
  },
  {
    name: 'rea_import_reference_source',
    desc: '把一份源代码树作为历史参考导入（仅参考，不执行）。',
    props: { root: { type: 'string', description: '本地源码目录' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['root'], argv: (a) => ['import-reference-source', a.root, ...(a.args ?? [])],
  },
  {
    name: 'rea_capture_electron',
    desc: '运行一次专属 Electron 场景捕获（inputJson：内联或文件）。',
    props: { inputJson: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['inputJson'], argv: (a) => ['capture-electron-scenario', a.inputJson, ...(a.args ?? [])],
  },
  {
    name: 'rea_cli',
    desc: '逃生舱：直接调用任意 REA 命令（如需完整能力面/未精选命令）。未知用法时先跑 rea_capabilities 或带 --help。',
    props: { command: { type: 'string', description: 'REA 子命令名，如 compare / function / analyze-web-bundle' }, args: { type: 'array', items: { type: 'string' }, description: '命令参数（按 CLI 顺序）；--help 可查用法' } },
    required: ['command'],
    argv: (a) => { if (!/^[a-z][a-z0-9-]*$/.test(String(a.command))) throw new Error('非法命令名'); return [String(a.command), ...(a.args ?? []).map(String)]; },
  },
];

function jsonSchema(tool) {
  return { type: 'object', properties: tool.props, required: tool.required ?? [], additionalProperties: false };
}

function runRea(command, cliArgs) {
  return new Promise((resolve) => {
    // 尊重调用方显式给出的 --format；否则补默认（json）。--token-limit / --filter-output 等原样透传。
    const args = [command, ...cliArgs];
    if (!cliArgs.includes('--format')) args.push('--format', FORMAT);
    // 两种启动方式：① REA_ENTRY（node + rea.mjs，推荐）；② PATH 上的 rea CLI（Windows 的 .cmd 需 shell）。
    // 注：② 会经 shell 拼接参数，仅图方便用；正式环境建议用 ①。
    const useEntry = Boolean(REA_ENTRY);
    const argv = useEntry ? [REA_ENTRY, ...args] : args;
    let child;
    try {
      child = spawn(useEntry ? NODE_BIN : REA_CLI, argv, {
        cwd: WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ...PROVIDER_ENV }, shell: useEntry ? false : process.platform === 'win32',
      });
    }
    catch (e) { resolve('spawn 失败：' + String(e?.message ?? e)); return; }
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill(); } catch { /* ignore */ } }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { if (out.length < MAX_BYTES * 3) out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (err.length < 8192) err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve('spawn 错误：' + String(e?.message ?? e)); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let text = out.trim();
      const notes = ['exit=' + code];
      if (killed) notes.push('已超时 ' + TIMEOUT_MS + 'ms 强杀');
      if (text.length > MAX_BYTES) { text = text.slice(0, MAX_BYTES); notes.push('输出截断至 ' + MAX_BYTES + ' 字节'); }
      if (!text) text = err.trim().slice(0, 4000) || '(无输出)';
      resolve(text + '\n\n[' + notes.join(' | ') + ']');
    });
  });
}

// —— MCP stdio 主循环 ——
const rl = createInterface({ input: process.stdin, terminal: false });
const send = (msg) => {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); }
  catch (e) { /* 同步写失败（罕见）：无法回信，忽略以免连锁 */ void e; }
};

// 2026-10-10 加固（与 akasha core/mcp.mjs 同族）：客户端先退 ⇒ 写 stdout 会以**异步 'error' 事件**抛 EPIPE，
// 未挂处理即未捕获异常 → 整条 REA 桥死。标准流挂 error → 安静退出；stdin 关 → 收尾。
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
rl.on('close', () => process.exit(0));

rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '解析失败：不是合法 JSON' } });
    return;
  }
  // 2026-10-10 加固：形状校验必须在**解构之前**——合法 JSON 但形状不对（null/数字/字符串/数组/缺 method）
  // 时回 JSON-RPC 错误，而不是解构抛错（在 async handler 里会变成未处理拒绝，直接终结进程）。
  if (req === null || typeof req !== 'object' || Array.isArray(req) || typeof req.method !== 'string') {
    send({ jsonrpc: '2.0', id: (req && typeof req === 'object' && 'id' in req) ? req.id : null, error: { code: -32600, message: '无效的 JSON-RPC 请求（需要含 method 的对象）' } });
    return;
  }
  const { id, method, params } = req;
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'rea-shim', version: '0.1.2' } } });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.desc, inputSchema: jsonSchema(t) })) } });
      return;
    }
    if (method === 'resources/list' || method === 'prompts/list') { send({ jsonrpc: '2.0', id, result: { resources: [], prompts: [] } }); return; }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) { send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '未知工具：' + String(params?.name) }] } }); return; }
      let argv;
      try { argv = tool.argv(params?.arguments ?? {}); }
      catch (e) { send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '参数错误：' + String(e?.message ?? e) }] } }); return; }
      const out = await runRea(argv[0], argv.slice(1));
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      return;
    }
    if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未实现的方法：' + String(method) } });
  } catch (e) {
    if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});
