export interface DbOffset {
  byte: number;
  bit?: number;
}

export interface DbVariable {
  id: string;
  name: string;
  path: string[];
  type: string;
  offset: DbOffset;
  size: number;
  children: DbVariable[];
  readable: boolean;
}

export interface ParsedDbBlock {
  id: string;
  name: string;
  number?: number;
  sourcePath: string;
  variables: DbVariable[];
  readSize: number;
  diagnostics: string[];
}

export interface PlcConnectionOptions {
  host: string;
  rack: number;
  slot: number;
  pollIntervalMs: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MonitorStatus {
  state: ConnectionState;
  message: string;
  updatedAt?: string;
}

export interface VariableValueUpdate {
  dbId: string;
  values: Record<string, string | number | boolean | null>;
  updatedAt: string;
}

export interface VariableWriteRequest {
  dbId: string;
  variableId: string;
  value: string | number | boolean;
  radix?: number;
}

export type BoolPulsePattern = 'false-true-false' | 'true-false-true';

export interface VariablePulseRequest {
  dbId: string;
  variableId: string;
  pattern: BoolPulsePattern;
  pulseMs: number;
}
