import * as assert from 'assert';
import { parseDbBlocks, parseDbSource } from '../dbParser';
import { decodeVariable } from '../valueDecoder';

const source = `
DATA_BLOCK "MonitorDb"
{ S7_BlockNumber := '20' }
VERSION : 0.1
STRUCT
  char : Array[0..1] of Char;
  flag : Bool;
  flag2 : Bool;
  value : Int;
  UDT1 : STRUCT
    bool : Bool;
    int : Int;
    text : String[10];
  END_STRUCT;
  test : Byte;
END_STRUCT;
BEGIN
END_DATA_BLOCK
`;

const block = parseDbSource(source, 'MonitorDb.db');

assert.strictEqual(block.number, 20);
assert.strictEqual(block.name, 'MonitorDb');
assert.strictEqual(block.diagnostics.length, 0);
assert.ok(block.readSize > 0);

const byName = new Map(block.variables.map((variable) => [variable.name, variable]));
assert.strictEqual(byName.get('char')?.children.length, 2);
assert.strictEqual(byName.get('flag')?.offset.byte, 2);
assert.strictEqual(byName.get('flag')?.offset.bit, 0);
assert.strictEqual(byName.get('flag2')?.offset.bit, 1);
assert.strictEqual(byName.get('value')?.offset.byte, 4);

const udt = byName.get('UDT1');
assert.ok(udt);
assert.strictEqual(udt.children[0]?.id, 'db:20/UDT1/bool');
assert.strictEqual(udt.children[2]?.type, 'String[10]');

const multiBlockSource = `
TYPE "UDT1"
VERSION : 0.1
STRUCT
  flag : Bool;
  value : Int;
END_STRUCT;
END_TYPE

TYPE "UDT2"
VERSION : 0.1
STRUCT
  Udt1Array : Array[0..1] of "UDT1";
  boolArray : Array[0..10] of Bool;
  bool_0 : Bool;
END_STRUCT;
END_TYPE

DATA_BLOCK "DB_A"
STRUCT
  chars : Array[0..19] of Char;
  flag : Bool;
  udt : "UDT1";
  udt2 : "UDT2";
END_STRUCT;
BEGIN
END_DATA_BLOCK

DATA_BLOCK "DB_B"
STRUCT
  flag : Bool;
  value : Int;
END_STRUCT;
BEGIN
END_DATA_BLOCK
`;

const blocks = parseDbBlocks(multiBlockSource, 'Multi.db');
assert.strictEqual(blocks.length, 2);
assert.strictEqual(blocks[0]?.name, 'DB_A');
assert.strictEqual(blocks[1]?.name, 'DB_B');
assert.strictEqual(blocks[0]?.variables[0]?.size, 20);
assert.strictEqual(blocks[0]?.variables[1]?.offset.byte, 20);
assert.strictEqual(blocks[0]?.variables[2]?.offset.byte, 22);
assert.strictEqual(blocks[0]?.variables[2]?.children[1]?.offset.byte, 24);
assert.strictEqual(blocks[0]?.variables[3]?.offset.byte, 26);
assert.strictEqual(blocks[0]?.variables[3]?.children[1]?.offset.byte, 34);
assert.strictEqual(blocks[0]?.variables[3]?.children[1]?.children[10]?.offset.byte, 35);
assert.strictEqual(blocks[0]?.variables[3]?.children[1]?.children[10]?.offset.bit, 2);
assert.strictEqual(blocks[0]?.variables[3]?.children[2]?.offset.byte, 36);
assert.strictEqual(blocks[0]?.variables[3]?.children[2]?.offset.bit, 0);
assert.strictEqual(blocks[1]?.variables[1]?.offset.byte, 2);

const typeSource = `
DATA_BLOCK "TypeDb"
STRUCT
  b : Byte;
  w : Word;
  dw : DWord;
  lw : LWord;
  si : SInt;
  usi : USInt;
  i : Int;
  ui : UInt;
  di : DInt;
  udi : UDInt;
  li : LInt;
  uli : ULInt;
  r : Real;
  lr : LReal;
  d : Date;
  t : Time;
  tod : Time_Of_Day;
  ltod : LTime_Of_Day;
  dt : Date_And_Time;
  ldt : LDT;
  dtl : DTL;
  c : Char;
  wc : WChar;
  s : String[4];
  ws : WString[4];
END_STRUCT;
BEGIN
END_DATA_BLOCK
`;

const typeBlock = parseDbSource(typeSource, 'TypeDb.db');
const typeVars = new Map(typeBlock.variables.map((variable) => [variable.name, variable]));
assert.strictEqual(typeVars.get('lw')?.size, 8);
assert.strictEqual(typeVars.get('li')?.size, 8);
assert.strictEqual(typeVars.get('lr')?.size, 8);
assert.strictEqual(typeVars.get('dtl')?.size, 12);
assert.strictEqual(typeVars.get('wc')?.size, 2);
assert.strictEqual(typeVars.get('s')?.size, 6);
assert.strictEqual(typeVars.get('ws')?.size, 12);

const buffer = Buffer.alloc(typeBlock.readSize);
buffer.writeUInt16BE(1, typeVars.get('d')?.offset.byte ?? 0);
buffer.writeInt32BE(3723004, typeVars.get('t')?.offset.byte ?? 0);
buffer.writeUInt32BE(3723004, typeVars.get('tod')?.offset.byte ?? 0);
buffer.writeDoubleBE(12.5, typeVars.get('lr')?.offset.byte ?? 0);
const stringByte = typeVars.get('s')?.offset.byte ?? 0;
buffer.writeUInt8(4, stringByte);
buffer.writeUInt8(2, stringByte + 1);
buffer.write('OK', stringByte + 2, 'latin1');

assert.strictEqual(decodeVariable(buffer, typeVars.get('d')!), '1990-01-02');
assert.strictEqual(decodeVariable(buffer, typeVars.get('t')!), 'T#0d_01:02:03.004');
assert.strictEqual(decodeVariable(buffer, typeVars.get('tod')!), '01:02:03.004');
assert.strictEqual(decodeVariable(buffer, typeVars.get('lr')!), 12.5);
assert.strictEqual(decodeVariable(buffer, typeVars.get('s')!), 'OK');

console.log('parser smoke test passed');
