import { EventEmitter } from 'events';
import { DbVariable, ParsedDbBlock, PlcConnectionOptions, MonitorStatus, VariablePulseRequest, VariableValueUpdate, VariableWriteRequest } from './model';
import { decodeVariables, flattenVariables } from './valueDecoder';

// nodes7 does not publish TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Nodes7 = require('nodes7') as Nodes7Constructor;

type NodeS7Connection = {
  initiateConnection: (options: Record<string, unknown>, callback: (error?: Error) => void) => void;
  dropConnection: (callback?: () => void) => void;
  addItems: (items: string | string[]) => void;
  removeItems: (items?: string | string[]) => void;
  readAllItems: (callback: (error: boolean, values: Record<string, unknown>) => void) => void;
  writeItems: (items: string | string[], values: unknown | unknown[], callback: (error: boolean) => void) => number;
};

interface Nodes7Constructor {
  new (): NodeS7Connection;
}

export class S7Service extends EventEmitter {
  private connection?: NodeS7Connection;
  private options?: PlcConnectionOptions;
  private blocks: ParsedDbBlock[] = [];
  private continuousBlockId?: string;
  private timer?: NodeJS.Timeout;
  private polling = false;

  public async connect(options: PlcConnectionOptions, blocks: ParsedDbBlock[]): Promise<void> {
    this.options = options;
    this.blocks = blocks;
    this.stopContinuousRead();
    this.emitStatus('connecting', `Connecting to ${options.host}...`);

    const connection = new Nodes7();
    this.connection = connection;

    await new Promise<void>((resolve, reject) => {
      connection.initiateConnection(
        {
          host: options.host,
          port: 102,
          rack: options.rack,
          slot: options.slot
        },
        (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      );
    });

    this.emitStatus('connected', `Connected to ${options.host}`);
  }

  public disconnect(message = 'Disconnected'): void {
    this.stopContinuousRead();
    if (this.connection) {
      this.connection.dropConnection();
      this.connection = undefined;
    }
    this.emitStatus('disconnected', message);
  }

  public setBlocks(blocks: ParsedDbBlock[]): void {
    this.blocks = blocks;
  }

  public async readBlockOnce(dbId: string): Promise<void> {
    const block = this.getReadableBlock(dbId);
    if (!block) {
      return;
    }
    await this.pollBlock(block);
  }

  public async writeVariable(request: VariableWriteRequest): Promise<void> {
    if (this.polling) {
      this.emitStatus('error', 'PLC read/write is in progress.');
      return;
    }

    try {
      const block = this.getReadableBlock(request.dbId);
      if (!block || block.number === undefined) {
        return;
      }

      const variable = flattenVariables(block.variables).find((item) => item.id === request.variableId);
      if (!variable) {
        this.emitStatus('error', 'Variable was not found.');
        return;
      }

      this.polling = true;
      const write = createVariableWrite(block.number, variable, request.value, request.radix);
      await this.writeItem(write.address, write.value);
      this.emitStatus('connected', `Write completed: ${variable.path.join('.')}`);
      this.polling = false;
      await this.pollBlock(block);
    } catch (error) {
      this.polling = false;
      const message = error instanceof Error ? error.message : String(error);
      this.emitStatus('error', message);
    }
  }

  public async pulseBoolVariable(request: VariablePulseRequest): Promise<void> {
    if (this.polling) {
      this.emitStatus('error', 'PLC read/write is in progress.');
      return;
    }

    try {
      const block = this.getReadableBlock(request.dbId);
      if (!block || block.number === undefined) {
        return;
      }

      const variable = flattenVariables(block.variables).find((item) => item.id === request.variableId);
      if (!variable) {
        this.emitStatus('error', 'Variable was not found.');
        return;
      }
      if (normalizeType(variable.type) !== 'bool') {
        this.emitStatus('error', 'Pulse write is only supported for Bool variables.');
        return;
      }

      const pulseMs = parsePulseMilliseconds(request.pulseMs);
      const values = boolPulseValues(request.pattern);
      this.polling = true;
      for (let index = 0; index < values.length; index++) {
        const write = createVariableWrite(block.number, variable, values[index] ?? false);
        await this.writeItem(write.address, write.value);
        if (index < values.length - 1) {
          await delay(pulseMs);
        }
      }
      this.emitStatus('connected', `Pulse completed: ${variable.path.join('.')}`);
      this.polling = false;
      await this.pollBlock(block);
    } catch (error) {
      this.polling = false;
      const message = error instanceof Error ? error.message : String(error);
      this.emitStatus('error', message);
    }
  }

  public setContinuousRead(dbId: string, enabled: boolean): void {
    this.stopContinuousRead();
    if (!enabled) {
      this.emitStatus(this.connection ? 'connected' : 'disconnected', 'Continuous read stopped');
      return;
    }

    const block = this.getReadableBlock(dbId);
    if (!block || !this.options) {
      return;
    }

    this.continuousBlockId = dbId;
    void this.pollBlock(block);
    this.timer = setInterval(() => {
      const currentBlock = this.blocks.find((item) => item.id === this.continuousBlockId);
      if (currentBlock) {
        void this.pollBlock(currentBlock);
      }
    }, this.options.pollIntervalMs);
    this.emitStatus('connected', `Continuous read: ${block.name}`);
  }

  public getContinuousBlockId(): string | undefined {
    return this.continuousBlockId;
  }

  public override on(event: 'status', listener: (status: MonitorStatus) => void): this;
  public override on(event: 'values', listener: (update: VariableValueUpdate) => void): this;
  public override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  private getReadableBlock(dbId: string): ParsedDbBlock | undefined {
    if (!this.connection) {
      this.emitStatus('error', 'PLC is not connected.');
      return undefined;
    }

    const block = this.blocks.find((item) => item.id === dbId);
    if (!block) {
      this.emitStatus('error', 'DB block was not found.');
      return undefined;
    }
    if (block.number === undefined) {
      this.emitStatus('error', `Set DB number for: ${block.name}`);
      return undefined;
    }
    if (block.readSize <= 0) {
      this.emitStatus('error', `${block.name} has no readable bytes.`);
      return undefined;
    }
    return block;
  }

  private async pollBlock(block: ParsedDbBlock): Promise<void> {
    if (!this.connection || this.polling || block.number === undefined) {
      return;
    }

    this.polling = true;
    try {
      this.connection.removeItems();
      const address = createBlockReadAddress(block.number, block.readSize);
      this.connection.addItems(address);
      const values = await this.readAll();
      const data = values[address];
      this.emit('values', {
        dbId: block.id,
        values: decodeVariables(toBuffer(data, block.readSize), block.variables),
        updatedAt: new Date().toISOString()
      });
      this.emitStatus('connected', `Read completed: ${block.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitStatus('error', message);
    } finally {
      this.polling = false;
    }
  }

  private async readAll(): Promise<Record<string, unknown>> {
    if (!this.connection) {
      throw new Error('PLC is not connected.');
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.connection?.readAllItems((error, values) => {
        if (error) {
          reject(new Error('Failed to read PLC items.'));
          return;
        }
        resolve(values);
      });
    });
  }

  private async writeItem(address: string, value: unknown): Promise<void> {
    if (!this.connection) {
      throw new Error('PLC is not connected.');
    }

    return new Promise<void>((resolve, reject) => {
      const scheduled = this.connection?.writeItems(address, value, (error) => {
        if (error) {
          reject(new Error('Failed to write PLC item.'));
          return;
        }
        resolve();
      });
      if (scheduled !== 0) {
        reject(new Error('PLC write is already in progress.'));
      }
    });
  }

  private stopContinuousRead(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.continuousBlockId = undefined;
  }

  private emitStatus(state: MonitorStatus['state'], message: string): void {
    this.emit('status', {
      state,
      message,
      updatedAt: new Date().toISOString()
    });
  }
}

function createBlockReadAddress(dbNumber: number, readSize: number): string {
  return `DB${dbNumber},B0.${readSize}`;
}

function createByteArrayAddress(dbNumber: number, byteOffset: number, byteLength: number): string {
  return `DB${dbNumber},B${byteOffset}.${byteLength}`;
}

function createByteAddress(dbNumber: number, byteOffset: number): string {
  return `DB${dbNumber},B${byteOffset}`;
}

function byteArrayWriteValue(bytes: Buffer): number | number[] {
  return bytes.length === 1 ? bytes[0] ?? 0 : [...bytes];
}

export interface VariableWrite {
  address: string;
  value: boolean | number | number[];
}

interface NumericWriteType {
  size: number;
  min: number;
  max: number;
  write: (buffer: Buffer, value: number) => void;
}

const integerWriteTypes: Record<string, NumericWriteType> = {
  byte: { size: 1, min: 0, max: 0xff, write: (buffer, value) => buffer.writeUInt8(value, 0) },
  usint: { size: 1, min: 0, max: 0xff, write: (buffer, value) => buffer.writeUInt8(value, 0) },
  sint: { size: 1, min: -0x80, max: 0x7f, write: (buffer, value) => buffer.writeInt8(value, 0) },
  word: { size: 2, min: 0, max: 0xffff, write: (buffer, value) => buffer.writeUInt16BE(value, 0) },
  uint: { size: 2, min: 0, max: 0xffff, write: (buffer, value) => buffer.writeUInt16BE(value, 0) },
  int: { size: 2, min: -0x8000, max: 0x7fff, write: (buffer, value) => buffer.writeInt16BE(value, 0) },
  dword: { size: 4, min: 0, max: 0xffffffff, write: (buffer, value) => buffer.writeUInt32BE(value, 0) },
  udint: { size: 4, min: 0, max: 0xffffffff, write: (buffer, value) => buffer.writeUInt32BE(value, 0) },
  dint: { size: 4, min: -0x80000000, max: 0x7fffffff, write: (buffer, value) => buffer.writeInt32BE(value, 0) }
};

interface BigIntWriteType {
  min: bigint;
  max: bigint;
  write: (buffer: Buffer, value: bigint) => void;
}

const bigIntWriteTypes: Record<string, BigIntWriteType> = {
  lword: { min: 0n, max: 0xffffffffffffffffn, write: (buffer, value) => buffer.writeBigUInt64BE(value, 0) },
  ulint: { min: 0n, max: 0xffffffffffffffffn, write: (buffer, value) => buffer.writeBigUInt64BE(value, 0) },
  lint: { min: -0x8000000000000000n, max: 0x7fffffffffffffffn, write: (buffer, value) => buffer.writeBigInt64BE(value, 0) }
};

const floatWriteTypes: Record<string, NumericWriteType> = {
  real: { size: 4, min: -Infinity, max: Infinity, write: (buffer, value) => buffer.writeFloatBE(value, 0) },
  lreal: { size: 8, min: -Infinity, max: Infinity, write: (buffer, value) => buffer.writeDoubleBE(value, 0) }
};

export function createVariableWrite(
  dbNumber: number,
  variable: DbVariable,
  rawValue: string | number | boolean,
  radix?: number
): VariableWrite {
  if (!variable.readable) {
    throw new Error('This variable cannot be written.');
  }

  const type = normalizeType(variable.type);
  if (type === 'bool') {
    if (typeof rawValue !== 'boolean') {
      throw new Error('Bool variables require a boolean value.');
    }
    return {
      address: `DB${dbNumber},X${variable.offset.byte}.${variable.offset.bit ?? 0}`,
      value: rawValue
    };
  }

  const integerType = integerWriteTypes[type];
  if (integerType) {
    const value = parseIntegerValue(rawValue, radix);
    assertInRange(value, integerType.min, integerType.max, variable.type);
    const bytes = Buffer.alloc(integerType.size);
    integerType.write(bytes, value);
    return {
      address: bytes.length === 1 ? createByteAddress(dbNumber, variable.offset.byte) : createByteArrayAddress(dbNumber, variable.offset.byte, bytes.length),
      value: byteArrayWriteValue(bytes)
    };
  }

  const bigIntType = bigIntWriteTypes[type];
  if (bigIntType) {
    const value = parseBigIntegerValue(rawValue, radix);
    assertBigIntInRange(value, bigIntType.min, bigIntType.max, variable.type);
    const bytes = Buffer.alloc(8);
    bigIntType.write(bytes, value);
    return {
      address: createByteArrayAddress(dbNumber, variable.offset.byte, bytes.length),
      value: byteArrayWriteValue(bytes)
    };
  }

  const floatType = floatWriteTypes[type];
  if (floatType) {
    const value = parseFloatValue(rawValue);
    const bytes = Buffer.alloc(floatType.size);
    floatType.write(bytes, value);
    return {
      address: createByteArrayAddress(dbNumber, variable.offset.byte, bytes.length),
      value: byteArrayWriteValue(bytes)
    };
  }

  const bytes = createDateTimeWriteBytes(type, rawValue) ?? createTextWriteBytes(type, rawValue);
  if (bytes) {
    return {
      address: bytes.length === 1 ? createByteAddress(dbNumber, variable.offset.byte) : createByteArrayAddress(dbNumber, variable.offset.byte, bytes.length),
      value: byteArrayWriteValue(bytes)
    };
  }

  throw new Error(`${variable.type} write is not supported.`);
}

function normalizeType(type: string): string {
  return type.trim().replace(/\s+/g, '').toLowerCase();
}

function parseIntegerValue(rawValue: string | number | boolean, radix = 10): number {
  if (typeof rawValue === 'boolean') {
    throw new Error('Numeric variables require a numeric value.');
  }

  if (typeof rawValue === 'number') {
    if (!Number.isInteger(rawValue)) {
      throw new Error('Integer variables require an integer value.');
    }
    return rawValue;
  }

  const normalizedRadix = [2, 8, 10, 16].includes(radix) ? radix : 10;
  const text = rawValue.trim().replace(/_/g, '');
  const sign = text.startsWith('-') ? -1 : 1;
  const unsigned = text.replace(/^[+-]/, '').replace(/^0x/i, '').replace(/^16#/i, '').replace(/^2#/i, '').replace(/^8#/i, '');
  if (!unsigned || !isValidIntegerDigits(unsigned, normalizedRadix)) {
    throw new Error('Enter a valid integer value.');
  }

  return sign * parseInt(unsigned, normalizedRadix);
}

function parseBigIntegerValue(rawValue: string | number | boolean, radix = 10): bigint {
  if (typeof rawValue === 'boolean') {
    throw new Error('Numeric variables require a numeric value.');
  }

  if (typeof rawValue === 'number') {
    if (!Number.isInteger(rawValue)) {
      throw new Error('Integer variables require an integer value.');
    }
    return BigInt(rawValue);
  }

  const normalizedRadix = [2, 8, 10, 16].includes(radix) ? radix : 10;
  const text = rawValue.trim().replace(/_/g, '');
  const sign = text.startsWith('-') ? -1n : 1n;
  const unsigned = text.replace(/^[+-]/, '').replace(/^0x/i, '').replace(/^16#/i, '').replace(/^2#/i, '').replace(/^8#/i, '');
  if (!unsigned || !isValidIntegerDigits(unsigned, normalizedRadix)) {
    throw new Error('Enter a valid integer value.');
  }

  return sign * parseUnsignedBigInt(unsigned, normalizedRadix);
}

function parseUnsignedBigInt(text: string, radix: number): bigint {
  if (radix === 16) {
    return BigInt(`0x${text}`);
  }
  if (radix === 8) {
    return BigInt(`0o${text}`);
  }
  if (radix === 2) {
    return BigInt(`0b${text}`);
  }
  return BigInt(text);
}

function isValidIntegerDigits(text: string, radix: number): boolean {
  if (radix === 2) {
    return /^[01]+$/i.test(text);
  }
  if (radix === 8) {
    return /^[0-7]+$/i.test(text);
  }
  if (radix === 16) {
    return /^[0-9a-f]+$/i.test(text);
  }
  return /^\d+$/i.test(text);
}

function parseFloatValue(rawValue: string | number | boolean): number {
  if (typeof rawValue === 'boolean') {
    throw new Error('Numeric variables require a numeric value.');
  }

  const value = typeof rawValue === 'number' ? rawValue : Number(rawValue.trim());
  if (!Number.isFinite(value)) {
    throw new Error('Enter a valid numeric value.');
  }
  return value;
}

function parsePulseMilliseconds(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 600000) {
    throw new Error('Pulse time must be between 0 and 600000 ms.');
  }
  return value;
}

function boolPulseValues(pattern: VariablePulseRequest['pattern']): boolean[] {
  if (pattern === 'false-true-false') {
    return [false, true, false];
  }
  if (pattern === 'true-false-true') {
    return [true, false, true];
  }
  throw new Error('Unsupported Bool pulse pattern.');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createDateTimeWriteBytes(type: string, rawValue: string | number | boolean): Buffer | undefined {
  if (type === 'date') {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(parseDateDays(rawValue), 0);
    return bytes;
  }
  if (type === 'time') {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(parseDurationMilliseconds(rawValue), 0);
    return bytes;
  }
  if (type === 'tod' || type === 'time_of_day' || type === 'timeofday') {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(parseTimeOfDayMilliseconds(rawValue), 0);
    return bytes;
  }
  if (type === 'ltod' || type === 'ltime_of_day' || type === 'ltimeofday') {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(parseTimeOfDayNanoseconds(rawValue), 0);
    return bytes;
  }
  if (type === 'dt' || type === 'date_and_time' || type === 'dateandtime') {
    return encodeDateAndTime(rawValue);
  }
  if (type === 'ldt') {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(parseLDateTimeNanoseconds(rawValue), 0);
    return bytes;
  }
  if (type === 'dtl') {
    return encodeDtl(rawValue);
  }
  return undefined;
}

function createTextWriteBytes(type: string, rawValue: string | number | boolean): Buffer | undefined {
  if (type === 'char') {
    return encodeChar(rawValue);
  }
  if (type === 'wchar') {
    return encodeWChar(rawValue);
  }
  if (type.startsWith('string[')) {
    return encodeString(rawValue, parseStringLength(type));
  }
  if (type.startsWith('wstring[')) {
    return encodeWString(rawValue, parseStringLength(type));
  }
  return undefined;
}

function parseDateDays(rawValue: string | number | boolean): number {
  if (typeof rawValue === 'boolean') {
    throw new Error('Date variables require a date value.');
  }
  if (typeof rawValue === 'number') {
    assertInRange(rawValue, 0, 0xffff, 'Date');
    return rawValue;
  }

  const text = rawValue.trim().replace(/^(date|d)#/i, '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new Error('Enter a Date value as YYYY-MM-DD.');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  const date = new Date(time);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Enter a valid Date value.');
  }

  const days = Math.floor((time - dateEpoch) / millisecondsPerDay);
  assertInRange(days, 0, 0xffff, 'Date');
  return days;
}

function parseDurationMilliseconds(rawValue: string | number | boolean): number {
  if (typeof rawValue === 'boolean') {
    throw new Error('Time variables require a duration value.');
  }
  if (typeof rawValue === 'number') {
    assertInRange(rawValue, -0x80000000, 0x7fffffff, 'Time');
    return rawValue;
  }

  const text = rawValue.trim();
  const colonValue = parseColonDurationMilliseconds(text);
  const value = colonValue ?? parseUnitDurationMilliseconds(text);
  assertInRange(value, -0x80000000, 0x7fffffff, 'Time');
  return value;
}

function parseColonDurationMilliseconds(text: string): number | undefined {
  const match = /^([+-])?(?:time#|t#)?(?:(\d+)d_?)?(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/i.exec(text);
  if (!match) {
    return undefined;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const days = Number(match[2] ?? 0);
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  const seconds = Number(match[5]);
  const milliseconds = Number((match[6] ?? '').padEnd(3, '0'));
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error('Enter a valid Time value.');
  }
  return sign * (((days * 24 + hours) * 60 + minutes) * 60 * 1000 + seconds * 1000 + milliseconds);
}

function parseUnitDurationMilliseconds(text: string): number {
  const source = text.trim().replace(/^(time|t)#/i, '');
  const sign = source.startsWith('-') ? -1 : 1;
  const unsigned = source.replace(/^[+-]/, '');
  const tokenRegexp = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi;
  let total = 0;
  let consumed = '';
  let match: RegExpExecArray | null;
  while ((match = tokenRegexp.exec(unsigned)) !== null) {
    const amount = Number(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    consumed += match[0];
    total += amount * durationUnitMilliseconds(unit);
  }
  if (!consumed || consumed.length !== unsigned.replace(/_/g, '').length) {
    throw new Error('Enter a Time value like T#0d_01:02:03.004.');
  }
  return sign * Math.round(total);
}

function durationUnitMilliseconds(unit: string): number {
  if (unit === 'd') {
    return millisecondsPerDay;
  }
  if (unit === 'h') {
    return 60 * 60 * 1000;
  }
  if (unit === 'm') {
    return 60 * 1000;
  }
  if (unit === 's') {
    return 1000;
  }
  return 1;
}

function parseTimeOfDayMilliseconds(rawValue: string | number | boolean): number {
  const nanoseconds = parseTimeOfDayNanoseconds(rawValue);
  if (nanoseconds % 1_000_000n !== 0n) {
    throw new Error('TOD only supports millisecond precision.');
  }
  return Number(nanoseconds / 1_000_000n);
}

function parseTimeOfDayNanoseconds(rawValue: string | number | boolean): bigint {
  if (typeof rawValue === 'boolean') {
    throw new Error('Time of day variables require a time value.');
  }
  if (typeof rawValue === 'number') {
    assertInRange(rawValue, 0, millisecondsPerDay - 1, 'Time_Of_Day');
    return BigInt(rawValue) * 1_000_000n;
  }

  const text = rawValue.trim().replace(/^(tod|time_of_day|timeofday|ltod|ltime_of_day|ltimeofday)#/i, '');
  const match = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(text);
  if (!match) {
    throw new Error('Enter a time of day value as HH:mm:ss.mmm.');
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new Error('Enter a valid time of day value.');
  }

  const fraction = BigInt((match[4] ?? '').padEnd(9, '0'));
  return BigInt(((hours * 60 + minutes) * 60 + seconds)) * 1_000_000_000n + fraction;
}

function encodeDateAndTime(rawValue: string | number | boolean): Buffer {
  const date = parseUtcDateTime(rawValue, 'Date_And_Time');
  const year = date.getUTCFullYear();
  if (year < 1990 || year > 2089) {
    throw new Error('Date_And_Time year must be between 1990 and 2089.');
  }

  const milliseconds = date.getUTCMilliseconds();
  return Buffer.from([
    toBcd(year >= 2000 ? year - 2000 : year - 1900),
    toBcd(date.getUTCMonth() + 1),
    toBcd(date.getUTCDate()),
    toBcd(date.getUTCHours()),
    toBcd(date.getUTCMinutes()),
    toBcd(date.getUTCSeconds()),
    toBcd(Math.floor(milliseconds / 10)),
    ((milliseconds % 10) << 4) | weekday(date)
  ]);
}

function parseLDateTimeNanoseconds(rawValue: string | number | boolean): bigint {
  if (typeof rawValue === 'boolean') {
    throw new Error('LDT variables require a date-time value.');
  }
  if (typeof rawValue === 'number') {
    return BigInt(rawValue) * 1_000_000n;
  }

  const date = parseUtcDateTime(rawValue, 'LDT');
  return BigInt(date.getTime() - dateEpoch) * 1_000_000n;
}

function encodeDtl(rawValue: string | number | boolean): Buffer {
  const date = parseUtcDateTime(rawValue, 'DTL');
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 2554) {
    throw new Error('DTL year must be between 1970 and 2554.');
  }

  const bytes = Buffer.alloc(12);
  bytes.writeUInt16BE(year, 0);
  bytes.writeUInt8(date.getUTCMonth() + 1, 2);
  bytes.writeUInt8(date.getUTCDate(), 3);
  bytes.writeUInt8(weekday(date), 4);
  bytes.writeUInt8(date.getUTCHours(), 5);
  bytes.writeUInt8(date.getUTCMinutes(), 6);
  bytes.writeUInt8(date.getUTCSeconds(), 7);
  bytes.writeUInt32BE(date.getUTCMilliseconds() * 1_000_000, 8);
  return bytes;
}

function parseUtcDateTime(rawValue: string | number | boolean, type: string): Date {
  if (typeof rawValue !== 'string') {
    throw new Error(`${type} variables require a date-time value.`);
  }

  const text = rawValue.trim().replace(new RegExp(`^(${type}|dt|ldt)#`, 'i'), '');
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T00:00:00.000Z`
    : /(?:z|[+-]\d{2}:?\d{2})$/i.test(text)
      ? text
      : `${text}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Enter a valid ${type} value.`);
  }
  return date;
}

function encodeChar(rawValue: string | number | boolean): Buffer {
  const text = parseTextValue(rawValue);
  if (text.length > 1) {
    throw new Error('Char variables require zero or one character.');
  }
  const code = text.length === 0 ? 0 : text.charCodeAt(0);
  if (code > 0xff) {
    throw new Error('Char variables only support single-byte characters.');
  }
  return Buffer.from([code]);
}

function encodeWChar(rawValue: string | number | boolean): Buffer {
  const text = parseTextValue(rawValue);
  if (text.length > 1) {
    throw new Error('WChar variables require zero or one character.');
  }
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(text.length === 0 ? 0 : text.charCodeAt(0), 0);
  return bytes;
}

function encodeString(rawValue: string | number | boolean, declaredLength: number): Buffer {
  const text = parseTextValue(rawValue);
  if (text.length > declaredLength) {
    throw new Error(`String value must be ${declaredLength} characters or fewer.`);
  }

  const bytes = Buffer.alloc(declaredLength + 2);
  bytes.writeUInt8(declaredLength, 0);
  bytes.writeUInt8(text.length, 1);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0xff) {
      throw new Error('String variables only support single-byte characters.');
    }
    bytes.writeUInt8(code, index + 2);
  }
  return bytes;
}

function encodeWString(rawValue: string | number | boolean, declaredLength: number): Buffer {
  const text = parseTextValue(rawValue);
  if (text.length > declaredLength) {
    throw new Error(`WString value must be ${declaredLength} characters or fewer.`);
  }

  const bytes = Buffer.alloc(declaredLength * 2 + 4);
  bytes.writeUInt16BE(declaredLength, 0);
  bytes.writeUInt16BE(text.length, 2);
  for (let index = 0; index < text.length; index++) {
    bytes.writeUInt16BE(text.charCodeAt(index), index * 2 + 4);
  }
  return bytes;
}

function parseTextValue(rawValue: string | number | boolean): string {
  if (typeof rawValue !== 'string') {
    throw new Error('Text variables require a text value.');
  }
  const text = rawValue.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(text);
  return quoted?.[2] ?? rawValue;
}

function parseStringLength(type: string): number {
  const match = /\[(\d+)\]$/i.exec(type);
  return match?.[1] ? Number(match[1]) : 254;
}

const dateEpoch = Date.UTC(1990, 0, 1);
const millisecondsPerDay = 24 * 60 * 60 * 1000;

function weekday(date: Date): number {
  return date.getUTCDay() + 1;
}

function toBcd(value: number): number {
  return Math.floor(value / 10) * 0x10 + (value % 10);
}

function assertInRange(value: number, min: number, max: number, type: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${type} value must be between ${min} and ${max}.`);
  }
}

function assertBigIntInRange(value: bigint, min: bigint, max: bigint, type: string): void {
  if (value < min || value > max) {
    throw new Error(`${type} value must be between ${min} and ${max}.`);
  }
}

function toBuffer(value: unknown, expectedLength: number): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Buffer.from(value.map((item) => Number(item) & 0xff));
  }
  if (typeof value === 'number') {
    return Buffer.from([value & 0xff]);
  }
  return Buffer.alloc(expectedLength);
}
