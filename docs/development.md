# S7 DB Monitor Development Guide

[简体中文](zh-CN/development.md)

## Goal

S7 DB Monitor connects to Siemens S7 PLCs from VS Code and monitors DB block variables based on TIA Portal exported `.db` source files. A file may contain multiple DB blocks and same-file UDT definitions. The extension parses the DB layout, displays variables in a tree table, reads a full DB byte range for the selected DB block, and decodes values locally by variable address and type.

## Current Status

- `.db` files are registered as a VS Code custom text editor with view type `s7DbMonitor.dbEditor`.
- The monitor can also be opened from commands or the Explorer context menu.
- The Webview UI uses English labels and VS Code theme colors.
- DB blocks are shown in a resizable left list instead of a top tab strip.
- Each DB block has an editable actual DB number used for PLC reads.
- The active DB block can be read once or continuously.
- Connection parameters and DB numbers are saved per file in `workspaceState`.
- Write operations are not implemented yet.

## User Flow

1. The user opens a `.db` file.
2. VS Code opens the file with the S7 DB Monitor custom editor.
3. The extension parses DB block names, optional block numbers, variable trees, offsets, diagnostics and read sizes.
4. The user sets actual DB block numbers when the exported file does not include them.
5. The user enters PLC connection parameters in the title bar.
6. The user connects to the PLC.
7. The user selects one DB block from the left list and reads it once or continuously.
8. The status bar shows connection state, last read time, DB statistics and active continuous read state.

## Modules

### Extension Host

- `src/extension.ts`: registers commands and the custom editor provider.
- `src/monitorPanel.ts`: creates the Webview, handles messages, stores DB profiles and manages UI state.
- `src/dbParser.ts`: parses TIA Portal DB source files and outputs hierarchical variable models.
- `src/s7Service.ts`: manages S7 connections and reads selected DB byte ranges.
- `src/valueDecoder.ts`: decodes raw DB bytes by variable type and offset.

### Webview

- `media/monitor.css`: layout and VS Code theme integration.
- `media/monitor.js`: DB list, resizable sidebar, tree table, DB number editing, single read, continuous read and status rendering.

## Variable Model

Variable IDs are hierarchical and stable for the parsed file:

```text
db:<parsedBlockNumberOrBlockName>/<pathSegment>/<pathSegment>
```

Example:

```text
db:20/UDT1/BoolTest_0
```

Fields:

- `id`: globally unique variable identifier used for selection, reading, writing and expansion state.
- `name`: current-level display name.
- `path`: variable path array.
- `type`: TIA type name.
- `offset.byte`: byte offset.
- `offset.bit`: bit offset, only used by `Bool`.
- `size`: byte size.
- `children`: structure or array children.

The manually entered actual DB number is stored on the DB block and is used for PLC reads. It does not rewrite variable IDs that were created from a name-only exported DB.

## DB Parsing Strategy

The parser focuses on common non-optimized access DB source files:

- `DATA_BLOCK "Name"` or `DATA_BLOCK DB20`
- `{ S7_Optimized_Access := 'FALSE' }`
- `TYPE "UDT"` blocks in the same file
- `STRUCT ... END_STRUCT`
- `name : Bool;`
- `name : Array[0..9] of Bool;`
- `name : String[10];`
- nested `STRUCT` and UDT references

Layout rules currently used:

- `Bool` values are packed by bit.
- Non-`Bool` fields and structures are aligned to a word boundary.
- Array elements are laid out continuously.
- `Array[...] of Bool` is packed by bit and then aligned to the next byte before the next sibling field.
- `String[n]` uses `n + 2` bytes.
- `WString[n]` uses `n * 2 + 4` bytes.

Unsupported types are emitted as readable `false` zero-byte placeholders and a diagnostic is added to the DB block.

## Value Decoding

`src/valueDecoder.ts` flattens readable leaf variables and decodes them from the full DB buffer. Multi-byte values use big-endian S7 byte order.

Supported decoded categories:

- Binary numbers: `Bool`, `Byte`, `Word`, `DWord`, `LWord`
- Integers: `SInt`, `Int`, `DInt`, `USInt`, `UInt`, `UDInt`, `LInt`, `ULInt`
- Floating point: `Real`, `LReal`
- Date/time: `Date`, `Time`, `TOD`, `Time_Of_Day`, `LTOD`, `LTime_Of_Day`, `DT`, `Date_And_Time`, `LDT`, `DTL`
- Characters and strings: `Char`, `WChar`, `String[n]`, `WString[n]`

## S7 Communication Strategy

The service uses `nodes7`. For the selected DB block it builds an absolute byte-array address:

```text
DB<dbNumber>,B0.<readSize>
```

For example, `DB20,B0.300` reads 300 bytes from DB20 starting at byte 0. The result is converted to a `Buffer` and decoded by `valueDecoder`.

If the exported `.db` file does not contain DB block numbers, the UI shows editable DB number fields in the left DB block list. Reads only use those actual block numbers.

The service allows one active continuous read block at a time. Starting continuous read for another block stops the previous loop. The loop interval comes from the current connection options.

PLC-side access settings are documented in [plc-setup.md](plc-setup.md). For S7-1200/S7-1500, the expected setup is full access, PUT/GET access and non-optimized global DBs.

## Saved Profiles

The extension stores monitor parameters per `.db` file path in VS Code `workspaceState`.

Stored data:

- connection options: `host`, `rack`, `slot`, `pollIntervalMs`
- DB block numbers keyed by DB block name

The profile key format is:

```text
s7DbMonitor.fileProfile:<absoluteDbFilePath>
```

This keeps project files clean. Profiles are local to the current VS Code workspace storage.

The Webview sidebar width is separate UI state saved with `vscode.setState`, so it survives Webview reloads while the editor is retained.

## Layout

- Title bar: PLC connection parameters, connect and disconnect.
- Left panel: resizable DB block list with actual DB number inputs.
- Main area: current DB information, missing DB number notice, read actions and variable tree table.
- Status bar: connection state, last read time, DB counts and error summary.

## Extension Contributions

- Custom editor: `s7DbMonitor.dbEditor` for `*.db` files.
- Commands:
  - `s7DbMonitor.openMonitor`
  - `s7DbMonitor.openDbFile`
- Explorer context menu: `s7DbMonitor.openDbFile` for `.db` files.
- Settings:
  - `s7DbMonitor.defaultHost`
  - `s7DbMonitor.defaultRack`
  - `s7DbMonitor.defaultSlot`
  - `s7DbMonitor.pollIntervalMs`

## Development Commands

```powershell
npm install
npm run check
npm run compile
npm run watch
npm test
npm run package
```

Press `F5` in VS Code to launch the Extension Development Host.

Use `npm run package` when you need to generate a local VSIX package.

## Roadmap

1. Improve DB/UDT parser coverage with more exported TIA samples.
2. Add write support: boolean toggles, numeric inputs and string editors.
3. Improve parser diagnostics for offset conflicts and unsupported exported syntax.
4. Add optional import of external UDT files.
5. Add more parser samples and UI smoke tests.
