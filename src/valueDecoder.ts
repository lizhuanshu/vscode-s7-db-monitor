import { DbVariable } from './model';

export type DecodedValue = string | number | boolean | null;

const dateEpoch = Date.UTC(1990, 0, 1);
const millisecondsPerDay = 24 * 60 * 60 * 1000;

export function decodeVariables(buffer: Buffer, variables: DbVariable[]): Record<string, DecodedValue> {
  const values: Record<string, DecodedValue> = {};
  for (const variable of flattenVariables(variables)) {
    values[variable.id] = decodeVariable(buffer, variable);
  }
  return values;
}

export function flattenVariables(variables: DbVariable[]): DbVariable[] {
  const result: DbVariable[] = [];
  const visit = (variable: DbVariable) => {
    if (variable.readable) {
      result.push(variable);
    }
    for (const child of variable.children) {
      visit(child);
    }
  };
  for (const variable of variables) {
    visit(variable);
  }
  return result;
}

export function decodeVariable(buffer: Buffer, variable: DbVariable): DecodedValue {
  if (!variable.readable || variable.offset.byte < 0 || variable.offset.byte >= buffer.length) {
    return null;
  }

  const type = normalizeType(variable.type);
  const byte = variable.offset.byte;

  try {
    if (type === 'bool') {
      const bit = variable.offset.bit ?? 0;
      return ((buffer[byte] ?? 0) & (1 << bit)) !== 0;
    }
    if (type === 'byte' || type === 'usint') {
      return buffer.readUInt8(byte);
    }
    if (type === 'sint') {
      return buffer.readInt8(byte);
    }
    if (type === 'char') {
      return String.fromCharCode(buffer.readUInt8(byte));
    }
    if (type === 'wchar') {
      return String.fromCharCode(buffer.readUInt16BE(byte));
    }
    if (type === 'word' || type === 'uint') {
      return buffer.readUInt16BE(byte);
    }
    if (type === 'int') {
      return buffer.readInt16BE(byte);
    }
    if (type === 'dword' || type === 'udint') {
      return buffer.readUInt32BE(byte);
    }
    if (type === 'dint') {
      return buffer.readInt32BE(byte);
    }
    if (type === 'lword' || type === 'ulint') {
      return formatBigInt(buffer.readBigUInt64BE(byte));
    }
    if (type === 'lint') {
      return formatBigInt(buffer.readBigInt64BE(byte));
    }
    if (type === 'real') {
      return Number(buffer.readFloatBE(byte).toFixed(6));
    }
    if (type === 'lreal') {
      return Number(buffer.readDoubleBE(byte).toFixed(12));
    }
    if (type === 'date') {
      return decodeDate(buffer.readUInt16BE(byte));
    }
    if (type === 'time') {
      return formatDurationMs(buffer.readInt32BE(byte));
    }
    if (type === 'tod' || type === 'time_of_day' || type === 'timeofday') {
      return formatTimeOfDayMs(buffer.readUInt32BE(byte));
    }
    if (type === 'ltod' || type === 'ltime_of_day' || type === 'ltimeofday') {
      return formatTimeOfDayNs(buffer.readBigUInt64BE(byte));
    }
    if (type === 'dt' || type === 'date_and_time' || type === 'dateandtime') {
      return decodeDateAndTime(buffer.subarray(byte, byte + 8));
    }
    if (type === 'ldt') {
      return formatLDateTime(buffer.readBigInt64BE(byte));
    }
    if (type === 'dtl') {
      return decodeDtl(buffer.subarray(byte, byte + 12));
    }
    if (type.startsWith('string[')) {
      return decodeString(buffer, byte, parseStringLength(type));
    }
    if (type.startsWith('wstring[')) {
      return decodeWString(buffer, byte, parseStringLength(type));
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeType(type: string): string {
  return type.trim().replace(/\s+/g, '').toLowerCase();
}

function parseStringLength(type: string): number {
  const match = /\[(\d+)\]$/i.exec(type);
  return match ? Number(match[1]) : 254;
}

function decodeString(buffer: Buffer, byte: number, declaredLength: number): string {
  const maxLength = buffer.readUInt8(byte);
  const actualLength = Math.min(buffer.readUInt8(byte + 1), declaredLength, maxLength);
  return buffer.subarray(byte + 2, byte + 2 + actualLength).toString('latin1');
}

function decodeWString(buffer: Buffer, byte: number, declaredLength: number): string {
  const maxLength = buffer.readUInt16BE(byte);
  const actualLength = Math.min(buffer.readUInt16BE(byte + 2), declaredLength, maxLength);
  const chars: string[] = [];
  for (let index = 0; index < actualLength; index++) {
    chars.push(String.fromCharCode(buffer.readUInt16BE(byte + 4 + index * 2)));
  }
  return chars.join('');
}

function decodeDate(daysSinceEpoch: number): string {
  return new Date(dateEpoch + daysSinceEpoch * millisecondsPerDay).toISOString().slice(0, 10);
}

function formatDurationMs(milliseconds: number): string {
  const sign = milliseconds < 0 ? '-' : '';
  const abs = Math.abs(milliseconds);
  const days = Math.floor(abs / millisecondsPerDay);
  const remainder = abs % millisecondsPerDay;
  return `${sign}T#${days}d_${formatTimeOfDayMs(remainder)}`;
}

function formatTimeOfDayMs(milliseconds: number): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1000);
  const ms = milliseconds % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${String(ms).padStart(3, '0')}`;
}

function formatTimeOfDayNs(nanoseconds: bigint): string {
  const milliseconds = Number(nanoseconds / 1_000_000n);
  const nsRemainder = Number(nanoseconds % 1_000_000n);
  return `${formatTimeOfDayMs(milliseconds)}${String(nsRemainder).padStart(6, '0')}`;
}

function decodeDateAndTime(bytes: Buffer): string | null {
  if (bytes.length < 8) {
    return null;
  }
  const yearValue = bcd(bytes[0]);
  const year = yearValue >= 90 ? 1900 + yearValue : 2000 + yearValue;
  const month = bcd(bytes[1]);
  const day = bcd(bytes[2]);
  const hour = bcd(bytes[3]);
  const minute = bcd(bytes[4]);
  const second = bcd(bytes[5]);
  const millisecond = bcd(bytes[6]) * 10 + Math.floor(bcd(bytes[7]) / 10);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond)).toISOString();
}

function formatLDateTime(nanosecondsSinceEpoch: bigint): string {
  const milliseconds = Number(nanosecondsSinceEpoch / 1_000_000n);
  return new Date(dateEpoch + milliseconds).toISOString();
}

function decodeDtl(bytes: Buffer): string | null {
  if (bytes.length < 12) {
    return null;
  }
  const year = bytes.readUInt16BE(0);
  const month = bytes.readUInt8(2);
  const day = bytes.readUInt8(3);
  const hour = bytes.readUInt8(5);
  const minute = bytes.readUInt8(6);
  const second = bytes.readUInt8(7);
  const nanoseconds = bytes.readUInt32BE(8);
  const millisecond = Math.floor(nanoseconds / 1_000_000);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond)).toISOString();
}

function bcd(value: number | undefined): number {
  const byte = value ?? 0;
  return ((byte >> 4) & 0x0f) * 10 + (byte & 0x0f);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatBigInt(value: bigint): string | number {
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
  const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
  if (value <= maxSafe && value >= minSafe) {
    return Number(value);
  }
  return value.toString();
}
