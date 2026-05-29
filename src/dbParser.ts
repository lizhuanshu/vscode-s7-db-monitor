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
  line: number;
  comment?: string;
  structFields?: Declaration[];
}

interface DeclarationToken {
  text: string;
  line: number;
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
  const cleaned = stripBlockComments(source);
  const userTypes = parseUserTypes(cleaned);
  const sections = findNamedSections(cleaned, 'DATA_BLOCK', 'END_DATA_BLOCK');

  if (sections.length === 0) {
    if (/\bDATA_BLOCK\b/i.test(cleaned)) {
      return [createEmptyBlock(sourcePath, ['DATA_BLOCK declaration was found but END_DATA_BLOCK was missing.'])];
    }
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

  if (variables.length === 0) {
    diagnostics.push('No variables were parsed from this DB block.');
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

function stripBlockComments(source: string): string {
  return source.replace(/\(\*[\s\S]*?\*\)/g, '');
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

function tokenizeDeclarationBlock(text: string): DeclarationToken[] {
  const tokens: DeclarationToken[] = [];
  const regexp = /\/\/[^\r\n]*|"[^"]+"|'[^']*'|\.\.|:=|[^\s\[\]():;,]+|\d+|\[|\]|:|;|,/g;
  let match: RegExpExecArray | null;
  let line = 1;
  let lastIndex = 0;
  while ((match = regexp.exec(text)) !== null) {
    line += countLineBreaks(text.slice(lastIndex, match.index));
    tokens.push({ text: match[0], line });
    lastIndex = regexp.lastIndex;
  }
  return tokens;
}

function countLineBreaks(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

class DeclarationParser {
  private index = 0;

  public constructor(
    private readonly tokens: DeclarationToken[],
    private readonly diagnostics: string[]
  ) {}

  public parseRootStruct(): Declaration[] {
    const structToken = this.consumeUntilToken('STRUCT');
    if (!structToken) {
      return [];
    }
    this.consumeIf('STRUCT');
    const declarations = this.parseDeclarationsUntil('END_STRUCT');
    if (!this.peekIs('END_STRUCT')) {
      this.diagnostics.push('STRUCT declaration is missing END_STRUCT.');
      return declarations;
    }
    this.consumeIf('END_STRUCT');
    return declarations;
  }

  private parseDeclarationsUntil(endToken: string): Declaration[] {
    const declarations: Declaration[] = [];
    while (!this.isAtEnd()) {
      this.skipLineComments();
      if (this.peekIs(endToken)) {
        return declarations;
      }

      const nameToken = this.readName();
      if (!nameToken) {
        this.index++;
        continue;
      }
      const { name, line } = nameToken;

      if (!this.consumeIf(':')) {
        this.consumeUntil(';', endToken);
        this.consumeIf(';');
        this.diagnostics.push(`Variable ${name} (line ${line}) is missing a type separator.`);
        continue;
      }

      const structToken = this.consumeIf('STRUCT');
      if (structToken) {
        const comment = this.consumeTrailingLineComment(structToken.line);
        const structFields = this.parseDeclarationsUntil('END_STRUCT');
        if (!this.peekIs('END_STRUCT')) {
          this.diagnostics.push(`STRUCT ${name} (line ${line}) is missing END_STRUCT.`);
        } else {
          this.consumeIf('END_STRUCT');
        }
        this.consumeIf(';');
        declarations.push({ name, typeText: 'STRUCT', line, comment, structFields });
        continue;
      }

      const typeTokens: string[] = [];
      while (!this.isAtEnd() && !this.peekIs(';') && !this.peekIs('END_STRUCT') && !this.currentIsLineComment()) {
        const token = this.current();
        if (token) {
          typeTokens.push(token.text);
        }
        this.index++;
      }
      const semicolon = this.consumeIf(';');
      const comment = semicolon ? this.consumeTrailingLineComment(semicolon.line) : undefined;
      if (typeTokens.length === 0) {
        this.diagnostics.push(`Variable ${name} (line ${line}) is missing a type.`);
      }
      if (!semicolon) {
        this.diagnostics.push(`Variable ${name} (line ${line}) is missing a semicolon.`);
      }
      declarations.push({ name, typeText: joinTypeTokens(typeTokens), line, comment });
    }
    return declarations;
  }

  private readName(): { name: string; line: number } | undefined {
    const token = this.current();
    if (!token) {
      return undefined;
    }
    this.index++;
    return { name: stripQuotes(token.text), line: token.line };
  }

  private consumeUntil(...targets: string[]): void {
    while (!this.isAtEnd() && !targets.some((target) => this.peekIs(target))) {
      this.index++;
    }
  }

  private consumeUntilToken(token: string): DeclarationToken | undefined {
    this.consumeUntil(token);
    return this.current();
  }

  private consumeIf(token: string): DeclarationToken | undefined {
    if (this.peekIs(token)) {
      const consumed = this.current();
      this.index++;
      return consumed;
    }
    return undefined;
  }

  private peekIs(token: string): boolean {
    return this.current()?.text.toLowerCase() === token.toLowerCase();
  }

  private current(): DeclarationToken | undefined {
    return this.tokens[this.index];
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  private skipLineComments(): void {
    while (this.currentIsLineComment()) {
      this.index++;
    }
  }

  private currentIsLineComment(): boolean {
    return this.current()?.text.startsWith('//') ?? false;
  }

  private consumeTrailingLineComment(line: number): string | undefined {
    const token = this.current();
    if (!token || token.line !== line || !token.text.startsWith('//')) {
      return undefined;
    }
    this.index++;
    return token.text.slice(2).trim();
  }
}

function joinTypeTokens(tokens: string[]): string {
  return tokens.join('');
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
  return instantiateVariable(declaration.name, typeInfo, parentPath, cursor, context, declaration.comment);
}

function instantiateVariable(
  name: string,
  typeInfo: TypeInfo,
  parentPath: string[],
  cursor: Cursor,
  context: ParserContext,
  comment?: string
): DbVariable[] {
  if (typeInfo.kind === 'array' && typeInfo.elementType && typeInfo.arrayStart !== undefined && typeInfo.arrayEnd !== undefined) {
    alignBeforeArray(cursor);
    const startCursor = cloneCursor(cursor);
    const children: DbVariable[] = [];
    for (let index = typeInfo.arrayStart; index <= typeInfo.arrayEnd; index++) {
      children.push(...instantiateArrayElement(`[${index}]`, typeInfo.elementType, [...parentPath, name], cursor, context));
    }
    if (typeInfo.elementType.displayType.toLowerCase() === 'bool') {
      alignToNextByte(cursor);
    }
    const arrayVariable = createVariable(name, parentPath, typeInfo.displayType, startCursor, cursorDistance(startCursor, cursor), false, children, comment);
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
    return [createVariable(name, parentPath, typeInfo.displayType, startCursor, cursorDistance(startCursor, cursor), false, children, comment)];
  }

  alignBeforeType(cursor, typeInfo);
  const offset = cloneCursor(cursor);
  advanceCursor(cursor, typeInfo);
  return [createVariable(name, parentPath, typeInfo.displayType, offset, typeInfo.size, typeInfo.readable, [], comment)];
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
  if (!typeText) {
    context.diagnostics.push(`Variable ${declaration.name} (line ${declaration.line}) has an empty type.`);
    return {
      kind: 'unknown',
      size: 0,
      readable: false,
      displayType: 'Unknown'
    };
  }
  const arrayMatch = /^Array\s*\[\s*(\d+)\s*\.\.\s*(\d+)\s*\]\s*of\s*(.+)$/i.exec(typeText);
  if (arrayMatch) {
    const arrayStart = Number(arrayMatch[1]);
    const arrayEnd = Number(arrayMatch[2]);
    const elementDeclaration: Declaration = { name: declaration.name, typeText: arrayMatch[3]?.trim() ?? '', line: declaration.line };
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

  const unquotedType = stripQuotes(typeText).trim();
  const compactType = unquotedType.replace(/\s+/g, '');
  const userType = context.userTypes.get(unquotedType.toLowerCase()) ?? context.userTypes.get(compactType.toLowerCase());
  if (userType) {
    return {
      kind: 'struct',
      size: 0,
      readable: false,
      displayType: userType.name,
      fields: userType.fields
    };
  }

  const stringMatch = /^String(?:\[(\d+)\])?$/i.exec(compactType);
  if (stringMatch) {
    const declaredLength = stringMatch[1] ? Number(stringMatch[1]) : 254;
    return {
      kind: 'string',
      size: declaredLength + 2,
      readable: true,
      displayType: `String[${declaredLength}]`
    };
  }

  const wStringMatch = /^WString(?:\[(\d+)\])?$/i.exec(compactType);
  if (wStringMatch) {
    const declaredLength = wStringMatch[1] ? Number(wStringMatch[1]) : 254;
    return {
      kind: 'string',
      size: declaredLength * 2 + 4,
      readable: true,
      displayType: `WString[${declaredLength}]`
    };
  }

  const primitive = compactType.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(primitiveSizes, primitive)) {
    return {
      kind: 'primitive',
      size: primitiveSizes[primitive] ?? 0,
      readable: true,
      displayType: canonicalPrimitiveName(primitive)
    };
  }

  context.diagnostics.push(`Unsupported type ${typeText} for ${declaration.name} (line ${declaration.line}); it will be displayed as a zero-byte placeholder.`);
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

function alignBeforeArray(cursor: Cursor): void {
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
  children: DbVariable[],
  comment?: string
): DbVariable {
  const pathParts = [...parentPath, name];
  return {
    id: pathParts.map((part, index) => (index === 0 ? part : encodePathPart(part))).join('/'),
    name,
    path: pathParts.slice(1),
    type,
    offset: { byte: offset.byte, bit: type.toLowerCase() === 'bool' ? offset.bit : undefined },
    size,
    comment,
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
