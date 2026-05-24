import { EventEmitter } from 'events';
import { ParsedDbBlock, PlcConnectionOptions, MonitorStatus, VariableValueUpdate } from './model';
import { decodeVariables } from './valueDecoder';

// nodes7 does not publish TypeScript declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Nodes7 = require('nodes7') as Nodes7Constructor;

type NodeS7Connection = {
  initiateConnection: (options: Record<string, unknown>, callback: (error?: Error) => void) => void;
  dropConnection: (callback?: () => void) => void;
  addItems: (items: string | string[]) => void;
  removeItems: (items?: string | string[]) => void;
  readAllItems: (callback: (error: boolean, values: Record<string, unknown>) => void) => void;
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
