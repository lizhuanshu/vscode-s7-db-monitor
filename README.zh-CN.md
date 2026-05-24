# S7 DB Monitor

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.md) | 简体中文

S7 DB Monitor 是一个 VS Code 插件，用于基于博图导出的 `.db` 源文件监控西门子 S7 PLC 的 DB 块变量。插件会将 `.db` 文件打开为自定义监控视图，解析 DB 布局，通过 S7 协议读取 DB 字节，并在本地解码变量值。

## 功能

- 直接打开博图导出的 `.db` 文件作为监控视图。
- 支持同一文件中多个 `DATA_BLOCK`。
- 支持解析同文件中的 PLC 数据类型（`TYPE "UDT"`）、数组和嵌套结构。
- 以类似博图的树形表格展示 DB 变量。
- 使用左侧 DB 块列表，适合一个文件中包含较多 DB 块的场景。
- 当导出文件不包含实际 DB 块号时，可手动设置 PLC 中的实际块号。
- 按 `.db` 文件在当前 VS Code 工作区中记住连接参数和 DB 块号。
- 可对当前选中的 DB 块进行单次读取或连续读取。
- 通讯时整块读取 DB 字节，再根据变量地址和类型在本地解析值。

## PLC 要求

连接 PLC 前，请确认 PLC 和 DB 块允许 S7 DB 访问：

- PLC 必须能被运行 VS Code 的电脑访问。
- TCP `102` 端口必须可访问。
- 对于 S7-1200/S7-1500，需要在 CPU 保护设置中启用 full access 和 PUT/GET 访问。
- 使用全局 DB，并关闭优化块访问。
- 将对应 DB 下载到 PLC 后，再从 TIA Portal 导出 `.db` 源文件。

完整 PLC 设置请看 [docs/zh-CN/plc-setup.md](https://github.com/lizhuanshu/vscode-s7-db-monitor/blob/main/docs/zh-CN/plc-setup.md)。

## 使用监控页面

1. 在 VS Code 中打开 TIA Portal 导出的 `.db` 文件。
2. 如果文件中包含多个 DB 块，在左侧列表选择需要监控的 DB 块。
3. 如果导出文件没有包含实际 PLC DB 块号，在左侧 DB 块列表中输入块号。
4. 在顶部输入 PLC IP、rack、slot 和读取周期。
5. 点击 `Connect`。
6. 使用 `Read Once` 单次读取，或使用 `Continuous` 循环读取当前选中的 DB 块。

左侧 DB 块列表可以拖动分隔条调整宽度。

## 参数保存

插件会按 `.db` 文件，在当前 VS Code 工作区中记住：

- PLC 连接参数
- 手动输入的 DB 块号

项目文件不会被修改。

## 支持的数据

- 二进制数：`Bool`、`Byte`、`Word`、`DWord`、`LWord`
- 整数：`SInt`、`Int`、`DInt`、`USInt`、`UInt`、`UDInt`、`LInt`、`ULInt`
- 浮点数：`Real`、`LReal`
- 日期和时间：`Date`、`Time`、`TOD`、`LTOD`、`DT`、`LDT`、`DTL`
- 字符串：`Char`、`WChar`、`String[n]`、`WString[n]`
- PLC 数据类型：同文件中的 `UDT` 定义

详见 [docs/zh-CN/tia-supported-data-types.md](https://github.com/lizhuanshu/vscode-s7-db-monitor/blob/main/docs/zh-CN/tia-supported-data-types.md)。

## 命令和设置

- `S7 DB Monitor: Open Monitor`：打开一个空监控面板。
- `S7 DB Monitor: Open DB File`：用监控页面打开选中的 `.db` 文件。
- `.db` 文件资源管理器右键菜单：用 S7 DB Monitor 打开文件。
- `s7DbMonitor.defaultHost`：默认 PLC IP 地址，默认值 `192.168.0.1`。
- `s7DbMonitor.defaultRack`：默认 S7 rack 号，默认值 `0`。
- `s7DbMonitor.defaultSlot`：默认 S7 slot 号，默认值 `1`。
- `s7DbMonitor.pollIntervalMs`：默认连续读取周期，单位毫秒，默认值 `1000`。

## 故障排查

- 连接失败：检查 PLC IP、rack、slot、网络路由和 `102` 端口。
- S7-1200/S7-1500 无法读取：检查 full access、PUT/GET 访问和优化块访问设置。
- 值为空或不正确：确认 PLC 中下载的 DB 与导出的 `.db` 文件一致。
- 页面提示需要 DB 块号：在左侧 DB 列表输入 PLC 中的实际 DB 块号。
- 暂不解析外部 UDT 文件；建议尽量把 UDT 定义放在同一个导出文件中。
- 当前尚未实现变量写入。

## 更多文档

- [PLC 设置说明](https://github.com/lizhuanshu/vscode-s7-db-monitor/blob/main/docs/zh-CN/plc-setup.md)
- [支持的 TIA Portal 数据类型](https://github.com/lizhuanshu/vscode-s7-db-monitor/blob/main/docs/zh-CN/tia-supported-data-types.md)
- [开发文档](https://github.com/lizhuanshu/vscode-s7-db-monitor/blob/main/docs/zh-CN/development.md)

## 仓库

GitHub: <https://github.com/lizhuanshu/vscode-s7-db-monitor>

## 许可证

MIT © liming
