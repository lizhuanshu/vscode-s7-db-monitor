import * as path from 'path';
import { DbVariable, ParsedDbBlock } from './model';

interface Cursor {
  byte: number;
  bit: number;
}

interface TypeInfo {
  kind: 'primitive' | 'string' | 'array' | 'struct' | 'unknown';
  size: number;
  readable: boolean;
  elementType?: TypeInfo;
  arrayStart?: number;
  arrayEnd?: number;
  displayType: string;
  fields?: Declaration[];
}

interface Declaration {
  name: string;
  typeText: string;
  structFields?: Declaration[];
}

interface UserType {
  name: string;
  fields: Declaration[];
}

interface ParserContext {
  userTypes: Map<string, UserType>;
  diagnostics: string[];
}

const primitiveSizes: Record<string, number> = {
  bool: 0,
  byte: 1,
  char: 1,
  wchar: 2,
  sint: 1,
  usint: 1,
  word: 2,
  uint: 2,
  int: 2,
  dword: 4,
  udint: 4,
  dint: 4,
  real: 4,
  lword: 8,
  ulint: 8,
  lint: 8,
  lreal: 8,
  date: 2,
  time: 4,
  tod: 4,
  timeofday: 4,
  time_of_day: 4,
  ltod: 8,
  ltimeofday: 8,
  ltime_of_day: 8,
  dt: 8,
  dateandtime: 8,
  date_and_time: 8,
  ldt: 8,
  dtl: 12
};

export function parseDbSource(source: string, sourcePath: string): ParsedDbBlock {
  return parseDbBlocks(source, sourcePath)[0] ?? createEmptyBlock(sourcePath);
}

export function parseDbBlocks(source: string, sourcePath: string): ParsedDbBlock[] {
  const cleaned = stripComments(source);
  const userTypes = parseUserTypes(cleaned);
  const sections = findNamedSections(cleaned, 'DATA_BLOCK', 'END_DATA_BLOCK');

  if (sections.length === 0) {
    return [createEmptyBlock(sourcePath, ['DATA_BLOCK declaration was not found.'])];
  }

  return sections.map((section) => parseDbSection(section, sourcePath, userTypes));
}

function parseDbSection(section: string, sourcePath: string, userTypes: Map<string, UserType>): ParsedDbBlock {
  const diagnostics: string[] = [];
  const name = parseDbName(section) ?? path.basename(sourcePath, path.extname(sourcePath));
  const number = parseDbNumber(section, name);
  const declarations = parseStaticDeclarations(section, diagnostics);
  const dbKey = number === undefined ? name : String(number);
  const context: ParserContext = { userTypes, diagnostics };
  const cursor: Cursor = { byte: 0, bit: 0 };
  const variables: DbVariable[] = [];

  for (const declaration of declarations) {
    variables.push(...buildVariable(declaration, [`db:${dbKey}`], cursor, context));
  }

  alignToWord(cursor);
  return {
    id: `db:${dbKey}`,
    name,
    number,
    sourcePath,
    variables,
    readSize: cursor.byte,
    diagnostics
  };
}

function createEmptyBlock(sourcePath: string, diagnostics: string[] = []): ParsedDbBlock {
  const name = path.basename(sourcePath, path.extname(sourcePath));
  return {
    id: `db:${name}`,
    name,
    sourcePath,
    variables: [],
    readSize: 0,
    diagnostics
  };
}

function stripComments(source: string): string {
  return source
    .replace(/\(\*[\s\S]*?\*\)/g, '')
    .replace(/\/\/.*$/gm, '');
}

function stripAttributes(source: string): string {
  return source.replace(/\{[\s\S]*?\}/g, '');
}

function parseUserTypes(source: string): Map<string, UserType> {
  const types = new Map<string, UserType>();
  for (const section of findNamedSections(source, 'TYPE', 'END_TYPE')) {
    const name = parseNamedBlockName(section, 'TYPE');
    if (!name) {
      continue;
    }
    const diagnostics: string[] = [];
    types.set(name.toLowerCase(), {
      name,
      fields: parseStaticDeclarations(section, diagnostics)
    });
  }
  return types;
}

function findNamedSections(source: string, startKeyword: string, endKeyword: string): string[] {
  const sections: string[] = [];
  const regexp = new RegExp(`\\b${startKeyword}\\b[\\s\\S]*?\\b${endKeyword}\\b`, 'gi');
  let match: RegExpExecArray | null;
  while ((match = regexp.exec(source)) !== null) {
    sections.push(match[0]);
  }
  return sections;
}

function parseDbName(source: string): string | undefined {
  return parseNamedBlockName(source, 'DATA_BLOCK');
}

function parseNamedBlockName(source: string, keyword: string): string | undefined {
  const quoted = new RegExp(`${keyword}\\s+"([^"]+)"`, 'i').exec(source);
  if (quoted?.[1]) {
    return quoted[1];
  }
  const plain = new RegExp(`${keyword}\\s+([A-Za-z_][\\w]*|DB\\d+)`, 'i').exec(source);
  return plain?.[1];
}

function parseDbNumber(source: string, name: string): number | undefined {
  const attr = /S7_BlockNumber\s*:=\s*'?(\d+)'?/i.exec(source);
  if (attr?.[1]) {
    return Number(attr[1]);
  }
  const direct = /DATA_BLOCK\s+DB(\d+)/i.exec(source);
  if (direct?.[1]) {
    return Number(direct[1]);
  }
  const nameMatch = /^DB(\d+)$/i.exec(name);
  return nameMatch?.[1] ? Number(nameMatch[1]) : undefined;
}

function parseStaticDeclarations(source: string, diagnostics: string[]): Declaration[] {
  const structStart = /\bSTRUCT\b/i.exec(source);
  if (!structStart) {
    diagnostics.push('STRUCT declaration was not found.');
    return [];
  }

  const tokens = tokenizeDeclarationBlock(stripAttributes(source.slice(structStart.index)));
  const parser = new DeclarationParser(tokens, diagnostics);
  return parser.parseRootStruct();
}

function tokenizeDeclarationBlock(text: string): string[] {
  const tokens: string[] = [];
  const regexp = /"[^"]+"|'[^']*'|\.\.|:=|[A-Za-z_][\w]*|\d+|\[|\]|:|;|,/g;
  let match: RegExpExecArray | null;
  while ((match = regexp.exec(text)) !== null) {
    tokens.push(match[0]);
  }
  return tokens;
}

class DeclarationParser {
  private index = 0;

  public constructor(
    private readonly tokens: string[],
    private readonly diagnostics: string[]
  ) {}

  public parseRootStruct(): Declaration[] {
    this.consumeUntil('STRUCT');
    if (!this.consumeIf('STRUCT')) {
      return [];
    }
    return this.parseDeclarationsUntil('END_STRUCT');
  }

  private parseDeclarationsUntil(endToken: string): Declaration[] {
    const declarations: Declaration[] = [];
    while (!this.isAtEnd() && !this.peekIs(endToken)) {
      const name = this.readName();
      if (!name) {
        this.index++;
        continue;
      }

      if (!this.consumeIf(':')) {
        this.consumeUntil(';', endToken);
        this.consumeIf(';');
        this.diagnostics.push(`Variable ${name} is missing a type separator.`);
        continue;
      }

      if (this.consumeIf('STRUCT')) {
        const structFields = this.parseDeclarationsUntil('END_STRUCT');
        this.consumeIf('END_STRUCT');
        this.consumeIf(';');
        declarations.push({ name, typeText: 'STRUCT', structFields });
        continue;
      }

      const typeTokens: string[] = [];
      while (!this.isAtEnd() && !this.peekIs(';') && !this.peekIs('END_STRUCT')) {
        const token = this.current();
        if (token) {
          typeTokens.push(token);
        }
        this.index++;
      }
      this.consumeIf(';');
      declarations.push({ name, typeText: joinTypeTokens(typeTokens) });
    }
    return declarations;
  }

  private readName(): string | undefined {
    const token = this.current();
    if (!token) {
      return undefined;
    }
    this.index++;
    return stripQuotes(token);
  }

  private consumeUntil(...targets: string[]): void {
    while (!this.isAtEnd() && !targets.some((target) => this.peekIs(target))) {
      this.index++;
    }
  }

  private consumeIf(token: string): boolean {
    if (this.peekIs(token)) {
      this.index++;
      return true;
    }
    return false;
  }

  private peekIs(token: string): boolean {
    return this.current()?.toLowerCase() === token.toLowerCase();
  }

  private current(): string | undefined {
    return this.tokens[this.index];
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }
}

function joinTypeTokens(tokens: string[]): string {
  return tokens.join('').replace(/^Array/i, 'Array').replace(/of/i, ' of ');
}

function stripQuotes(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function buildVariable(
  declaration: Declaration,
  parentPath: string[],
  cursor: Cursor,
  context: ParserContext
): DbVariable[] {
  const typeInfo = parseTypeInfo(declaration, context);
  return instantiateVariable(declaration.name, typeInfo, parentPath, cursor, context);
}

function instantiateVariable(
  name: string,
  typeInfo: TypeInfo,
  parentPath: string[],
  cursor: Cursor,
  context: ParserContext
): DbVariable[] {
  if (typeInfo.kind === 'array' && typeInfo.elementType && typeInfo.arrayStart !== undefined && typeInfo.arrayEnd !== undefined) {
    alignBeforeType(cursor, typeInfo.elementType);
    const startCursor = cloneCursor(cursor);
    const children: DbVariable[] = [];
    for (let index = typeInfo.arrayStart; index <= typeInfo.arrayEnd; index++) {
      children.push(...instantiateArrayElement(`[${index}]`, typeInfo.elementType, [...parentPath, name], cursor, context));
    }
    if (typeInfo.elementType.displayType.toLowerCase() === 'bool') {
      alignToNextByte(cursor);
    }
    const arrayVariable = createVariable(name, parentPath, typeInfo.displayType, startCursor, cursorDistance(startCursor, cursor), false, children);
    return [arrayVariable];
  }

  if (typeInfo.kind === 'struct' && typeInfo.fields) {
    alignToWord(cursor);
    const startCursor = cloneCursor(cursor);
    const children: DbVariable[] = [];
    for (const field of typeInfo.fields) {
      children.push(...buildVariable(field, [...parentPath, name], cursor, context));
    }
    alignToWord(cursor);
    return [createVariable(name, parentPath, typeInfo.displayType, startCursor, cursorDistance(startCursor, cursor), false, children)];
  }

  alignBeforeType(cursor, typeInfo);
  const offset = cloneCursor(cursor);
  advanceCursor(cursor, typeInfo);
  return [createVariable(name, parentPath, typeInfo.displayType, offset, typeInfo.size, typeInfo.readable, [])];
}

function instantiateArrayElement(
  name: string,
  typeInfo: TypeInfo,
  parentPath: string[],
  cursor: Cursor,
  context: ParserContext
): DbVariable[] {
  if (typeInfo.kind === 'struct' || typeInfo.kind === 'array') {
    return instantiateVariable(name, typeInfo, parentPath, cursor, context);
  }

  const offset = cloneCursor(cursor);
  advanceArrayElementCursor(cursor, typeInfo);
  return [createVariable(name, parentPath, typeInfo.displayType, offset, typeInfo.size, typeInfo.readable, [])];
}

function parseTypeInfo(declaration: Declaration, context: ParserContext): TypeInfo {
  if (declaration.structFields) {
    return {
      kind: 'struct',
      size: 0,
      readable: false,
      displayType: declaration.typeText,
      fields: declaration.structFields
    };
  }

  const typeText = declaration.typeText.trim();
  const normalized = typeText.replace(/\s+/g, '');
  const arrayMatch = /^Array\[(\d+)\.\.(\d+)\]of(.+)$/i.exec(normalized);
  if (arrayMatch) {
    const arrayStart = Number(arrayMatch[1]);
    const arrayEnd = Number(arrayMatch[2]);
    const elementDeclaration: Declaration = { name: declaration.name, typeText: arrayMatch[3] ?? '' };
    const elementType = parseTypeInfo(elementDeclaration, context);
    return {
      kind: 'array',
      size: 0,
      readable: false,
      elementType,
      arrayStart,
      arrayEnd,
      displayType: `Array[${arrayStart}..${arrayEnd}] of ${elementType.displayType}`
    };
  }

  const unquotedType = stripQuotes(normalized);
  const userType = context.userTypes.get(unquotedType.toLowerCase());
  if (userType) {
    return {
      kind: 'struct',
      size: 0,
      readable: false,
      displayType: userType.name,
      fields: userType.fields
    };
  }

  const stringMatch = /^String(?:\[(\d+)\])?$/i.exec(unquotedType);
  if (stringMatch) {
    const declaredLength = stringMatch[1] ? Number(stringMatch[1]) : 254;
    return {
      kind: 'string',
      size: declaredLength + 2,
      readable: true,
      displayType: `String[${declaredLength}]`
    };
  }

  const wStringMatch = /^WString(?:\[(\d+)\])?$/i.exec(unquotedType);
  if (wStringMatch) {
    const declaredLength = wStringMatch[1] ? Number(wStringMatch[1]) : 254;
    return {
      kind: 'string',
      size: declaredLength * 2 + 4,
      readable: true,
      displayType: `WString[${declaredLength}]`
    };
  }

  const primitive = unquotedType.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(primitiveSizes, primitive)) {
    return {
      kind: 'primitive',
      size: primitiveSizes[primitive] ?? 0,
      readable: true,
      displayType: canonicalPrimitiveName(primitive)
    };
  }

  context.diagnostics.push(`Unsupported type ${typeText}; it will be displayed as a zero-byte placeholder.`);
  return {
    kind: 'unknown',
    size: 0,
    readable: false,
    displayType: stripQuotes(typeText) || 'Unknown'
  };
}

function alignBeforeType(cursor: Cursor, typeInfo: TypeInfo): void {
  if (typeInfo.displayType.toLowerCase() === 'bool') {
    return;
  }

  if (typeInfo.size <= 1) {
    alignToNextByte(cursor);
    return;
  }

  alignToWord(cursor);
}

function advanceCursor(cursor: Cursor, typeInfo: TypeInfo): void {
  if (typeInfo.displayType.toLowerCase() === 'bool') {
    cursor.bit++;
    if (cursor.bit > 7) {
      cursor.byte++;
      cursor.bit = 0;
    }
    return;
  }

  alignToNextByte(cursor);
  cursor.byte += typeInfo.size;
}

function advanceArrayElementCursor(cursor: Cursor, typeInfo: TypeInfo): void {
  if (typeInfo.displayType.toLowerCase() === 'bool') {
    advanceCursor(cursor, typeInfo);
    return;
  }

  alignToNextByte(cursor);
  cursor.byte += typeInfo.size;
}

function alignToWord(cursor: Cursor): void {
  alignToNextByte(cursor);
  if (cursor.byte % 2 !== 0) {
    cursor.byte++;
  }
}

function alignToNextByte(cursor: Cursor): void {
  if (cursor.bit > 0) {
    cursor.byte++;
    cursor.bit = 0;
  }
}

function cloneCursor(cursor: Cursor): Cursor {
  return { byte: cursor.byte, bit: cursor.bit };
}

function cursorDistance(start: Cursor, end: Cursor): number {
  const endByte = end.byte + (end.bit > 0 ? 1 : 0);
  return Math.max(0, endByte - start.byte);
}

function createVariable(
  name: string,
  parentPath: string[],
  type: string,
  offset: Cursor,
  size: number,
  readable: boolean,
  children: DbVariable[]
): DbVariable {
  const pathParts = [...parentPath, name];
  return {
    id: pathParts.map((part, index) => (index === 0 ? part : encodePathPart(part))).join('/'),
    name,
    path: pathParts.slice(1),
    type,
    offset: { byte: offset.byte, bit: type.toLowerCase() === 'bool' ? offset.bit : undefined },
    size,
    children,
    readable
  };
}

function encodePathPart(part: string): string {
  return encodeURIComponent(part).replace(/%5B/g, '[').replace(/%5D/g, ']');
}

function canonicalPrimitiveName(type: string): string {
  const names: Record<string, string> = {
    bool: 'Bool',
    byte: 'Byte',
    char: 'Char',
    wchar: 'WChar',
    sint: 'SInt',
    usint: 'USInt',
    word: 'Word',
    uint: 'UInt',
    int: 'Int',
    dword: 'DWord',
    udint: 'UDInt',
    dint: 'DInt',
    real: 'Real',
    lword: 'LWord',
    ulint: 'ULInt',
    lint: 'LInt',
    lreal: 'LReal',
    date: 'Date',
    time: 'Time',
    tod: 'TOD',
    timeofday: 'Time_Of_Day',
    time_of_day: 'Time_Of_Day',
    ltod: 'LTOD',
    ltimeofday: 'LTime_Of_Day',
    ltime_of_day: 'LTime_Of_Day',
    dt: 'DT',
    dateandtime: 'Date_And_Time',
    date_and_time: 'Date_And_Time',
    ldt: 'LDT',
    dtl: 'DTL'
  };
  return names[type] ?? type;
}
