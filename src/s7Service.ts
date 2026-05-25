import { EventEmitter } from 'events';
import { DbVariable, ParsedDbBlock, PlcConnectionOptions, MonitorStatus, VariableValueUpdate, VariableWriteRequest } from './model';
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

interface VariableWrite {
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

function createVariableWrite(
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
