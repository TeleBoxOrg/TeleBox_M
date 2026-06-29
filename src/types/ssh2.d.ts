declare module 'ssh2' {
  import { EventEmitter } from 'events';
  import { Stream } from 'stream';
  import { Agent } from 'http';

  interface ConnectConfig {
    host: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: Buffer | string;
    passphrase?: string;
    readyTimeout?: number;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    agent?: Agent | string;
    sock?: NodeJS.ReadableStream;
  }

  interface ClientOptions {
    readyTimeout?: number;
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
  }

  interface ExecOptions {
    env?: Record<string, string>;
    pty?: boolean;
    x11?: boolean;
    allowAgentFwd?: boolean;
  }

  interface TcpConnection {
    destIP: string;
    destPort: number;
    srcIP: string;
    srcPort: number;
  }

  interface Client extends EventEmitter {
    connect(config: ConnectConfig): this;
    end(): this;
    destroy(): this;
    exec(
      command: string,
      options: ExecOptions,
      callback: (err: Error | undefined, channel: Channel) => void
    ): void;
    forwardIn(
      remoteAddr: string,
      remotePort: number,
      callback: (err: Error | undefined, bindPort: number) => void
    ): void;
    forwardOut(
      srcIP: string,
      srcPort: number,
      dstIP: string,
      dstPort: number,
      callback: (err: Error | undefined, channel: Channel) => void
    ): void;
    rekey(callback?: (err: Error | undefined) => void): void;
    setNoDelay(noDelay?: boolean): this;
    on(event: 'ready', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'keyboard-interactive', listener: (
      name: string,
      instructions: string,
      lang: string,
      prompts: Array<{ prompt: string; echo: string }>,
      finish: (responses: string[]) => void
    ) => void): this;
  }

  class Channel extends Stream {
    close(): void;
    end(data?: string | Buffer): void;
    setWindow(rows: number, cols: number, height: number, width: number): void;
    signal(signal: string): void;
    exit(status: number): void;
    exit(signal: string, coreDumped?: boolean, desc?: string): void;
    stderr: Stream;
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'end', listener: () => void): this;
  }

  class Client extends EventEmitter implements Client {
    connect(config: ConnectConfig): this;
    end(): this;
    destroy(): this;
    exec(
      command: string,
      options: ExecOptions,
      callback: (err: Error | undefined, channel: Channel) => void
    ): void;
    forwardIn(
      remoteAddr: string,
      remotePort: number,
      callback: (err: Error | undefined, bindPort: number) => void
    ): void;
    forwardOut(
      srcIP: string,
      srcPort: number,
      dstIP: string,
      dstPort: number,
      callback: (err: Error | undefined, channel: Channel) => void
    ): void;
    rekey(callback?: (err: Error | undefined) => void): void;
    setNoDelay(noDelay?: boolean): this;
    on(event: 'ready', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'keyboard-interactive', listener: (
      name: string,
      instructions: string,
      lang: string,
      prompts: Array<{ prompt: string; echo: string }>,
      finish: (responses: string[]) => void
    ) => void): this;
  }

  export { Client, ConnectConfig, Channel };
}
