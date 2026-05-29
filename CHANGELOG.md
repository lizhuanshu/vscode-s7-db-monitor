# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to semantic versioning before marketplace releases.

## [0.0.6] - 2026-05-29

### Added

- Added resizable variable table columns in the monitor view.
- Added parser diagnostics and comment support for DB block declarations.
- Added diagnostics for missing `END_STRUCT` in nested structures.

### Changed

- Improved monitor table rendering and column layout behavior.
- Reorganized image assets under `images/` and updated documentation references.

### Fixed

- Fixed version metadata and lockfile version alignment.

## [0.0.5] - 2026-05-25

### Changed

- Improved variable operation panel layout with flex-based responsive design.
- Improved operation feedback visibility management with CSS hidden class toggling.

## [0.0.4] - 2026-05-25

### Added

- Added an explicit notice that the project does not provide support.
- Renamed the Marketplace extension identifier to `againdo-s7-db-monitor`.
- Renamed the Marketplace display name to `S7 DB Monitor Plus`.

## [0.0.3] - 2026-05-25

### Added

- Added variable write operations for supported DB variables.
- Added Bool pulse write actions with configurable pulse duration.
- Added write support for numeric, date/time and text variable types.
- Added write value validation and operation feedback in the monitor UI.
- Added an example DB file for write and type coverage checks.
- Added demo animation and company information to the project documentation.
- Added an AgainDo website link to the monitor title bar.

### Changed

- Improved monitor rendering performance by caching DB variable metadata and batching DOM updates.
- Improved write and pulse operations by reusing per-DB variable indexes.
- Improved monitor behavior so polling updates do not overwrite fields currently being edited.

### Fixed

- Fixed byte alignment for non-Bool small data types in DB parsing.

## [0.0.2] - 2026-05-24

### Added

- Added expand-all and collapse-all controls for variable nodes.
- Highlighted the live value column for easier monitoring.

### Changed

- Improved empty text display for `Char`, `WChar`, `String` and `WString` values.
- Stopped displaying concatenated text on `Array[..] of Char` parent rows.

## [0.0.1] - 2026-05-24

### Added

- Initial VS Code extension project.
- S7 DB monitor webview with connection controls, a resizable DB block list and tree table.
- Per-file saved connection options and DB block numbers.
- Single-read and continuous-read actions for the selected DB block.
- TIA Portal `.db` parser for common non-optimized DB source declarations.
- Full DB byte-range polling via `nodes7` and local value decoding.
- Parser smoke test.
