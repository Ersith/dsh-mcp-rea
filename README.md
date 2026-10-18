# dsh-mcp-rea —— REA 的 MCP 薄壳桥

[![Featured by Awesome REA](https://raw.githubusercontent.com/reacher-z/Awesome-REA/477658fa73f6860e86cd1fc526657c2efdc25194/assets/featured-by-awesome-rea-inline.svg)](https://awesomerea.org/resources/dsh-mcp-rea/)

把 **REA**（逆向工程 CLI）以 **「精选工具面 + CLI 逃生舱」** 暴露为 MCP stdio 服务器，供 DSH（DeepSeek Harness）等支持 MCP 的宿主使用。

> 包名 `@local/mcp-rea` 是 DSH 本机 bundle 的命名约定；`private: true`，**不发布到 npm**，以仓库 / tgz 形式本机安装。

## 为什么是薄壳，不是直连 `rea --mcp`

REA 原生 MCP 面：**139 个工具 / 约 1.83 MB schema**；而 `@deepseek-ai/dsh-mcp-client` **没有工具过滤字段**（一次性全量注册，每个请求都进 prefill）。直连会把几十万字符塞进每一次请求。

本薄壳只暴露 **21 个工具 / 约 6.7 KB schema**（≈ 原生的 1/270），并保证**能力不缩水**：`rea_cli` 逃生舱可直达全部子命令，参数原样透传。

## 工具面（21）

- **环境与能力**：`rea_doctor` · `rea_capabilities`
- **应用与网页静态分析**：`rea_analyze` · `rea_inspect` · `rea_analyze_js` · `rea_analyze_web`
- **反编译与分析**：`rea_decompile` · `rea_function`
- **制品与固件**：`rea_extract_artifact` · `rea_extract_firmware`
- **网页/运行时实况**：`rea_capture_web_shot` · `rea_observe_js_runtime` · `rea_discover_webmcp` · `rea_capture_electron`
- **对比与证据**：`rea_compare_versions` · `rea_compare_web` · `rea_evidence_export` · `rea_evidence_import`
- **参考源码**：`rea_export_web_scripts` · `rea_import_reference_source`
- **逃生舱**：`rea_cli`（`{command, args[]}` 直通全部子命令；命令名白名单校验）

## 安装

1. **装 REA**（建议钉版本）：`npm i rea-agents@6.3.0`（本壳不绑定版本，只依赖 CLI 契约）。
2. **配环境变量**（可写进宿主配置，不必改系统环境）：

   | 变量 | 作用 | 示例 |
   |---|---|---|
   | `REA_ENTRY` | `rea-agents` 的 `scripts/rea.mjs` 绝对路径（**推荐**） | `C:\tools\rea\node_modules\rea-agents\scripts\rea.mjs` |
   | `REA_GHIDRA_DIR` | Ghidra 安装目录（要做原生二进制分析时） | `C:\tools\ghidra_12.1.4_PUBLIC` |
   | `REA_JAVA_HOME` | JDK 21（Ghidra headless 用） | `C:\Program Files\Java\jdk-21` |

   不设 `REA_ENTRY` 时回退到 PATH 上的 `rea`（可执行名经 `REA_CLI` 覆盖）。
3. **接到 DSH**：把 `cordis.patch.yml` 里 `args` 改成 `server.mjs` 的**绝对路径**，再用 `plugin_manager install_bundle` 装为本机 bundle（或直接把该文件的内容并入 profile patch）。
4. **自测**：`node selftest.mjs` —— 8 项断言：握手 / 工具面体积 / 真跑 REA / 逃生舱参数透传（`--token-limit` 生效）/ 逃生舱覆盖 `--format` / 非法命令拒绝 / 未知方法 -32601。

## 环境变量全表

| 变量 | 默认 | 说明 |
|---|---|---|
| `REA_ENTRY` | 空（回退 PATH 的 `rea`） | `rea.mjs` 绝对路径；**推荐**——钉版本、行为确定 |
| `REA_CLI` | `rea` | 回退模式下要调的可执行名 |
| `REA_NODE` | `process.execPath` | 跑 `rea.mjs` 的 node 可执行文件 |
| `REA_WORKSPACE` | 当前工作目录 | 子进程 cwd |
| `REA_MAX_BYTES` | `65536` | 单次输出上限（超出截断并注明字节数） |
| `REA_TIMEOUT_MS` | `120000` | 单次超时（超时强杀并注明） |
| `REA_FORMAT` | `json` | 默认输出格式；调用方显式给 `--format` 时尊重之 |
| `REA_GHIDRA_DIR` / `REA_JAVA_HOME` | 空 | 原生分析提供方；**仅在目录存在时注入**（不污染全局） |

## 行为与边界（如实）

- **进程模型**：每次工具调用现起一个 REA CLI 进程；REA 自身的 MCP 也是进程级，开销相当。
- **输出保护**：单次上限（默认 64 KB）截断并注明；超时（默认 120 s）强杀并注明；stdout 为空时回传 stderr 前 4 KB。
- **原生分析**：需要 Ghidra（见上）；**Windows 上 REA 的 Ghidra 通道只接受 PE 应用程序，不接受 DLL**（`target_role_unsupported`）——要拆 DLL 请直接用 Ghidra headless。Hopper（macOS 专有）与 IDA（商业 + 上游 MCP 配置）在 Windows 不可用。
- **安全**：回退的「PATH CLI」模式会经 shell 拼接参数，属便利路径；正式使用请用 `REA_ENTRY`（不经过 shell）。

## 许可

MIT（见 `LICENSE`）。REA 本体与 Ghidra 为各自项目的产物，遵循其各自许可。
