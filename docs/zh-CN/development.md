# S7 DB Monitor 开发文档

[English](../development.md)

## 目标

S7 DB Monitor 用于在 VS Code 中通过 S7 协议连接西门子 PLC，并基于博图导出的 `.db` 源文件监控 DB 块变量。一个文件可以包含多个 DB 块和同文件 UDT 定义。插件会解析 DB 布局，以树形表格显示变量，对当前选中的 DB 块整块读取字节，并根据变量地址和类型在本地解码。

## 当前状态

- `.db` 文件注册为 VS Code 自定义文本编辑器，view type 为 `s7DbMonitor.dbEditor`。
- 监控页面也可以通过命令或资源管理器右键菜单打开。
- Webview 界面使用英文标签，并适配 VS Code 主题色。
- DB 块使用可拖拽宽度的左侧列表显示，而不是顶部选项卡。
- 每个 DB 块都有可编辑的实际 DB 块号，用于 PLC 读取。
- 当前选中的 DB 块可以单次读取或连续读取。
- 连接参数和 DB 块号会按文件保存到 `workspaceState`。
- 变量写入功能尚未实现。

## 用户流程

1. 用户打开 `.db` 文件。
2. VS Code 使用 S7 DB Monitor 自定义编辑器打开文件。
3. 插件解析 DB 块名称、可选块号、变量树、偏移、诊断信息和读取范围。
4. 如果导出文件没有包含 DB 块号，用户手动设置实际块号。
5. 用户在顶部输入 PLC 连接参数。
6. 用户连接 PLC。
7. 用户从左侧列表选择一个 DB 块，并进行单次读取或连续读取。
8. 底部状态栏展示连接状态、最近读取时间、DB 统计和当前连续读取状态。

## 模块

- `src/extension.ts`：注册命令和自定义编辑器。
- `src/monitorPanel.ts`：创建 Webview、处理消息、保存 DB 配置并管理 UI 状态。
- `src/dbParser.ts`：解析博图 DB 源文件，输出层级变量模型。
- `src/s7Service.ts`：管理 S7 连接并读取当前选中的 DB 字节区。
- `src/valueDecoder.ts`：根据变量类型和偏移解析原始字节。
- `media/monitor.css`：页面布局和 VS Code 主题适配。
- `media/monitor.js`：DB 列表、可拖拽侧边栏、树形表格、块号编辑、单次读取、连续读取和状态渲染。

## 变量模型

变量 ID 使用解析文件中的层级组合：

```text
db:<parsedBlockNumberOrBlockName>/<pathSegment>/<pathSegment>
```

示例：

```text
db:20/UDT1/BoolTest_0
```

主要字段：

- `id`：全局唯一变量标识，用于选择、读写和展开状态。
- `name`：当前层级显示名。
- `path`：变量层级路径数组。
- `type`：TIA 类型名。
- `offset.byte`：字节偏移。
- `offset.bit`：位偏移，仅 `Bool` 使用。
- `size`：占用字节数。
- `children`：结构或数组子项。

手动输入的实际 DB 块号保存在 DB 块对象上，并用于 PLC 读取。对于导出文件中没有块号的 DB，手动设置块号不会重写已经按名称生成的变量 ID。

## DB 解析策略

当前优先支持常见非优化访问 DB 源文件：

- `DATA_BLOCK "Name"` 或 `DATA_BLOCK DB20`
- `{ S7_Optimized_Access := 'FALSE' }`
- 同文件中的 `TYPE "UDT"` 块
- `STRUCT ... END_STRUCT`
- `name : Bool;`
- `name : Array[0..9] of Bool;`
- `name : String[10];`
- 嵌套 `STRUCT` 和 UDT 引用

布局规则：

- `Bool` 按 bit 打包。
- 非 `Bool` 字段和结构按字边界对齐。
- 数组元素连续布局。
- `Array[...] of Bool` 按 bit 打包，数组结束后对齐到下一个字节。
- `String[n]` 占 `n + 2` 字节。
- `WString[n]` 占 `n * 2 + 4` 字节。

不支持的类型会以 `readable: false` 的零字节占位变量显示，并在 DB 块诊断信息中记录。

## 值解析

`src/valueDecoder.ts` 会展开所有可读取的叶子变量，并从完整 DB 字节缓冲区中解码变量值。多字节值使用 S7 的大端字节序。

当前支持解析的类别：

- 二进制数：`Bool`、`Byte`、`Word`、`DWord`、`LWord`
- 整数：`SInt`、`Int`、`DInt`、`USInt`、`UInt`、`UDInt`、`LInt`、`ULInt`
- 浮点数：`Real`、`LReal`
- 日期时间：`Date`、`Time`、`TOD`、`Time_Of_Day`、`LTOD`、`LTime_Of_Day`、`DT`、`Date_And_Time`、`LDT`、`DTL`
- 字符和字符串：`Char`、`WChar`、`String[n]`、`WString[n]`

## S7 通讯策略

通讯层使用 `nodes7`。对当前选中的 DB 块构造绝对字节数组地址：

```text
DB<dbNumber>,B0.<readSize>
```

例如 `DB20,B0.300` 表示从 DB20 的字节 0 开始读取 300 个字节。读取结果转换为 `Buffer` 后交给 `valueDecoder` 解码。

如果 `.db` 文件没有包含 DB 块号，页面会在左侧 DB 列表显示可编辑 DB 号输入框。读取时只使用这些实际块号。

通讯层同一时间只允许一个 DB 块处于连续读取状态。为另一个 DB 块开启连续读取时，会停止之前的循环。循环周期来自当前连接参数。

PLC 侧访问设置请看 [plc-setup.md](plc-setup.md)。对于 S7-1200/S7-1500，预期设置是 full access、PUT/GET 访问，以及非优化访问的全局 DB。

## 参数保存

插件按 `.db` 文件路径将监控参数保存到 VS Code 的 `workspaceState`。

保存内容：

- 连接参数：`host`、`rack`、`slot`、`pollIntervalMs`
- 按 DB 块名称保存的实际块号

保存 key 格式：

```text
s7DbMonitor.fileProfile:<absoluteDbFilePath>
```

这种方式不会污染项目文件，但数据只保存在当前 VS Code 工作区存储中。

Webview 的左侧栏宽度是独立 UI 状态，通过 `vscode.setState` 保存，因此在编辑器保持期间 Webview 重新加载也能保留宽度。

## 页面布局

- 顶部：PLC 连接参数、连接和断开。
- 左侧：可拖拽宽度的 DB 块列表和实际块号输入。
- 主区域：当前 DB 信息、未设置 DB 块号提示、读取操作和变量树表格。
- 底部：连接状态、最近读取时间、DB 数量和错误摘要。

## 插件贡献点

- 自定义编辑器：`s7DbMonitor.dbEditor`，匹配 `*.db` 文件。
- 命令：
  - `s7DbMonitor.openMonitor`
  - `s7DbMonitor.openDbFile`
- 资源管理器右键菜单：对 `.db` 文件显示 `s7DbMonitor.openDbFile`。
- 设置项：
  - `s7DbMonitor.defaultHost`
  - `s7DbMonitor.defaultRack`
  - `s7DbMonitor.defaultSlot`
  - `s7DbMonitor.pollIntervalMs`

## 开发命令

```powershell
npm install
npm run check
npm run compile
npm run watch
npm test
npm run package
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

需要生成本地 VSIX 安装包时，使用 `npm run package`。

## 路线图

1. 使用更多博图导出样例增强 DB/UDT 解析覆盖率。
2. 增加变量写入：布尔切换、数值输入和字符串编辑。
3. 改进偏移冲突和不支持导出语法的解析诊断。
4. 支持可选导入外部 UDT 文件。
5. 增加更多解析样例和 UI 冒烟测试。
