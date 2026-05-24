# TIA Portal Supported Data Types

[简体中文](zh-CN/tia-supported-data-types.md)

TIA Portal data types define how values are represented in PLC memory. User programs can use predefined data types and can compose them into PLC data types such as UDTs.

This extension focuses on data that can be displayed and decoded from DB memory:

- Basic data types: binary numbers, integers, floating point numbers, date/time values, characters and strings.
- Complex data types: arrays, structures and strings.
- PLC data types: same-file UDT definitions.

Pointer, parameter, system and hardware data types may appear in TIA Portal projects, but they are not currently decoded as monitorable scalar values by this extension.

Actual availability depends on the PLC family, CPU firmware and whether the DB is configured for optimized or non-optimized access.

## Binary Numbers

| Type | S7-300/400 | S7-1200 | S7-1500 | Monitor support |
| --- | --- | --- | --- | --- |
| `Bool` | Yes | Yes | Yes | Yes |
| `Byte` | Yes | Yes | Yes | Yes |
| `Word` | Yes | Yes | Yes | Yes |
| `DWord` | Yes | Yes | Yes | Yes |
| `LWord` | No | No | Yes | Yes |

## Integers

| Type | S7-300/400 | S7-1200 | S7-1500 | Monitor support |
| --- | --- | --- | --- | --- |
| `SInt` | No | Yes | Yes | Yes |
| `Int` | Yes | Yes | Yes | Yes |
| `DInt` | Yes | Yes | Yes | Yes |
| `USInt` | No | Yes | Yes | Yes |
| `UInt` | No | Yes | Yes | Yes |
| `UDInt` | No | Yes | Yes | Yes |
| `LInt` | No | No | Yes | Yes |
| `ULInt` | No | No | Yes | Yes |

## Floating Point

| Type | S7-1200 | S7-1500 | Monitor support |
| --- | --- | --- | --- |
| `Real` | Yes | Yes | Yes |
| `LReal` | Yes | Yes | Yes |

## Date And Time

| Type | S7-300/400 | S7-1200 | S7-1500 | Monitor support |
| --- | --- | --- | --- | --- |
| `Date` | Yes | Yes | Yes | Yes |
| `Time` | Yes | Yes | Yes | Yes |
| `Time_Of_Day` / `TOD` | Yes | Yes | Yes | Yes |
| `LTime_Of_Day` / `LTOD` | No | No | Yes | Yes |
| `Date_And_Time` / `DT` | Yes | No | Yes | Yes |
| `LDT` | No | No | Yes | Yes |
| `DTL` | No | Yes | Yes | Yes |

## Strings And Characters

| Type | S7-300/400 | S7-1200 | S7-1500 | Monitor support |
| --- | --- | --- | --- | --- |
| `Char` | Yes | Yes | Yes | Yes |
| `WChar` | No | Yes | Yes | Yes |
| `String[n]` | Yes | Yes | Yes | Yes |
| `WString[n]` | No | Yes | Yes | Yes |

## PLC Data Types

| Type | S7-300/400 | S7-1200 | S7-1500 | Monitor support |
| --- | --- | --- | --- | --- |
| UDT | Yes | Yes | Yes | Same-file `TYPE "UDT"` definitions |
| `Struct` | Yes | Yes | Yes | Yes |
| `Array[...] of ...` | Yes | Yes | Yes | Yes |

## Other TIA Data Type Groups

TIA Portal also includes pointer types, parameter types, system data types and hardware data types. Examples include `Variant`, `Pointer`, `Any`, `Timer`, `Counter`, `Block_FC`, `Block_FB`, `IEC_Timer`, `TCON_Param`, `HW_Device`, `OB_Any` and `DB_Any`.

These types are useful in PLC programs and interfaces, but they are outside the current DB monitor decoding surface. If they appear in exported DB files, the parser should report them as unsupported instead of guessing a memory layout.

