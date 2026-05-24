# PLC 设置说明

[English](../plc-setup.md)

本插件通过 S7 协议读取西门子 PLC 的 DB 字节区。使用前请先完成 PLC 侧设置，尤其是 S7-1200 和 S7-1500 CPU。

参考：[S7NetPlus S7-1200/1500 notes](https://github.com/S7NetPlus/s7netplus/wiki/S7-1200-1500-Notes)。

## 支持的 DB 形态

- 使用全局 DB。
- 使用非优化访问 DB。
- 从 TIA Portal 导出 DB 源文件 `.db`。
- 尽量把 UDT 定义放在同一个导出文件中，因为插件当前还不会解析外部 UDT 导入。

## 配置 DB 块

对每个需要监控的 DB 块：

1. 在 TIA Portal 中打开项目。
2. 在 `Program blocks` 中选择 DB。
3. 打开 `Properties`。
4. 关闭 `Optimized block access`。
5. 编译并下载 DB 到 PLC。
6. 导出 DB 源文件，并在 VS Code 中打开 `.db` 文件。

如果启用了优化访问，监控值可能为空或不正确，因为实际字节布局可能和导出的 `.db` 文件不一致。

## 配置 CPU 访问

对于 S7-1200 和 S7-1500 CPU：

1. 在 TIA Portal 中选择 CPU。
2. 打开 `Properties`。
3. 进入 `Protection & Security` 或 `Protection` 页面。
4. 将访问级别设置为 full access。
5. 启用允许远程伙伴使用 PUT/GET 通讯访问。
6. 将硬件配置下载到 PLC。

不同 TIA Portal 版本和 CPU 固件中的文字可能略有差异。

## 检查网络参数

- PLC 必须能被运行 VS Code 的电脑访问。
- TCP `102` 端口必须可访问。
- S7-1200/S7-1500 常见默认连接参数通常是：
  - Rack：`0`
  - Slot：`1`
- 部分较老的 S7-300/S7-400 项目可能使用 Slot `2`。

## DB 块号

TIA Portal 导出的文件可能只有符号 DB 名称，没有实际运行时 DB 块号。遇到这种情况：

1. 在 S7 DB Monitor 中打开 `.db` 文件。
2. 在左侧列表找到对应 DB 块。
3. 输入 PLC 中的实际 DB 块号，例如 `DB20` 对应输入 `20`。
4. 连接后使用 `Read Once` 或 `Continuous` 读取。

输入的 DB 块号会按 `.db` 文件保存到 VS Code 工作区存储中。

## 故障排查

- `PLC is not connected.`：需要先连接 PLC 再读取。
- `Set DB number for ...`：需要在左侧 DB 列表输入实际 DB 块号。
- 值为空或不正确：检查是否关闭了优化块访问，并确认 PLC 中下载的 DB 和导出的 `.db` 文件一致。
- 连接失败：检查 PLC IP、rack、slot、网络路由和 `102` 端口。
- S7-1200/S7-1500 读取失败：检查 CPU 保护设置中的 full access 和 PUT/GET 访问。

