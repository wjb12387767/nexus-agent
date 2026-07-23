import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientConnection,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';

import type { AgentMessage } from '@/core/agent/types';

export interface AcpRuntimeConfig {
  id: string;
  name: string;
  command: string;
  args?: string;
  model?: string;
  modelProvider?: string;
  apiKey?: string;
  baseUrl?: string;
  apiType?: string;
}

type Emit = (message: AgentMessage) => void;

const execFileAsync = promisify(execFile);

function splitArgs(input = ''): string[] {
  const args: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) args.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) throw new Error('Unclosed quote in ACP runtime arguments');
  if (current) args.push(current);
  return args;
}

async function executablePath(command: string): Promise<string> {
  if (!command.trim()) throw new Error('ACP runtime command is required');
  if (command.includes('/') || command.includes('\\')) {
    await fs.promises.access(command, fs.constants.X_OK);
    return command;
  }
  const shell =
    process.env.SHELL ||
    (process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh');
  const quoted = `'${command.replace(/'/g, "'\\''")}'`;
  try {
    const { stdout } =
      process.platform === 'win32'
        ? await execFileAsync('where.exe', [command], { timeout: 2500 })
        : await execFileAsync(shell, ['-lc', `command -v -- ${quoted}`], {
            timeout: 2500,
          });
    const found = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found) return found;
  } catch {
    // Use the friendly error below.
  }
  throw new Error(`Agent runtime command not found: ${command}`);
}

function textFromUpdate(update: SessionUpdate): string | undefined {
  if (update.sessionUpdate !== 'agent_message_chunk') return undefined;
  return update.content.type === 'text' ? update.content.text : undefined;
}

function detail(value: unknown): string | undefined {
  if (value == null) return undefined;
  try {
    // ACP runtimes commonly wrap the useful tool output with internal display
    // metadata. Keep that protocol envelope out of the conversation UI.
    const record =
      typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const unwrapped =
      typeof record?.output === 'string'
        ? record.output
        : typeof record?.text === 'string'
          ? record.text
          : value;
    const text =
      typeof unwrapped === 'string'
        ? unwrapped
        : JSON.stringify(unwrapped, null, 2);
    return text.length > 10_000 ? `${text.slice(0, 10_000)}…` : text;
  } catch {
    return undefined;
  }
}

function selectOptions(
  options: Array<Record<string, unknown>>
): Array<{ value: string; name?: string }> {
  const result: Array<{ value: string; name?: string }> = [];
  for (const option of options) {
    if (typeof option.value === 'string') {
      result.push({
        value: option.value,
        name: typeof option.name === 'string' ? option.name : undefined,
      });
    } else if (Array.isArray(option.options)) {
      result.push(
        ...selectOptions(option.options as Array<Record<string, unknown>>)
      );
    }
  }
  return result;
}

function preferredModelValue(
  configOptions: NonNullable<
    ActiveSession['newSessionResponse']['configOptions']
  >,
  model?: string,
  providerId?: string
): { configId: string; value: string } | undefined {
  const requested = model?.trim();
  if (!requested) return undefined;
  const modelOption = configOptions.find(
    (option) =>
      option.type === 'select' &&
      (option.category === 'model' || option.id === 'model')
  );
  if (!modelOption || modelOption.type !== 'select') return undefined;
  const options = selectOptions(
    modelOption.options as Array<Record<string, unknown>>
  );
  const provider = providerId?.trim().toLowerCase();
  const normalizedRequested = requested.toLowerCase();
  const providerQualified = provider
    ? `${provider}/${normalizedRequested}`
    : undefined;
  const match =
    (providerQualified
      ? options.find(
          (option) => option.value.toLowerCase() === providerQualified
        )
      : undefined) ||
    options.find(
      (option) => option.value.toLowerCase() === normalizedRequested
    ) ||
    options.find((option) =>
      option.value.toLowerCase().endsWith(`/${normalizedRequested}`)
    );
  return match ? { configId: modelOption.id, value: match.value } : undefined;
}

function spawnEnvironment(
  config: AcpRuntimeConfig
): Record<string, string | undefined> {
  const model = config.model?.trim();
  const apiKey = config.apiKey?.trim();
  if (!model || !apiKey) return { ...process.env };
  let baseUrl = config.baseUrl?.trim().replace(/\/+$/, '');
  if (
    baseUrl &&
    config.apiType !== 'anthropic-messages' &&
    !baseUrl.endsWith('/v1')
  ) {
    baseUrl += '/v1';
  }
  const options: Record<string, string> = { apiKey };
  if (baseUrl) options.baseURL = baseUrl;
  const inlineConfig = {
    provider: {
      workany: {
        npm:
          config.apiType === 'anthropic-messages'
            ? '@ai-sdk/anthropic'
            : '@ai-sdk/openai-compatible',
        name: 'WorkAny',
        options,
        models: { [model]: { name: model } },
      },
    },
    model: `workany/${model}`,
    small_model: `workany/${model}`,
  };
  return {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(inlineConfig),
  };
}

class AcpRuntime {
  private emit: Emit | null = null;
  private prompting = false;
  private stderr = '';
  private seenTools = new Set<string>();
  private pendingPermissions = new Map<
    string,
    {
      resolve: (response: RequestPermissionResponse) => void;
      options: PermissionOption[];
    }
  >();

  private constructor(
    readonly key: string,
    readonly config: AcpRuntimeConfig,
    readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly connection: ClientConnection,
    private readonly session: ActiveSession
  ) {
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_000);
    });
    child.once('exit', (code, signal) => {
      this.connection.close(
        new Error(
          `Agent runtime exited (${signal ?? code ?? 'unknown'})${this.stderr ? `: ${this.stderr}` : ''}`
        )
      );
      this.cancelPermissions();
      runtimes.delete(key);
    });
  }

  static async create(key: string, config: AcpRuntimeConfig, cwd: string) {
    const command = await executablePath(config.command);
    try {
      await fs.promises.mkdir(cwd, { recursive: true });
    } catch (error) {
      throw new Error(
        `Unable to prepare the working folder for ${config.name}: ${cwd} (${error instanceof Error ? error.message : String(error)})`
      );
    }
    const child = spawn(command, splitArgs(config.args), {
      cwd,
      env: spawnEnvironment(config),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        child.off('spawn', handleSpawn);
        child.off('error', handleError);
      };
      const handleSpawn = () => {
        cleanup();
        resolve();
      };
      const handleError = (error: Error & { code?: string }) => {
        cleanup();
        const target =
          error.code === 'ENOENT' ? `${command} or ${cwd}` : command;
        reject(
          new Error(
            `Unable to start ${config.name}: ${target} is unavailable (${error.code || error.message})`
          )
        );
      };
      child.once('spawn', handleSpawn);
      child.once('error', handleError);
    });

    let runtime: AcpRuntime | undefined;
    const app = client({ name: 'WorkAny' }).onRequest(
      methods.client.session.requestPermission,
      ({ params }) =>
        runtime
          ? runtime.requestPermission(params)
          : Promise.resolve({ outcome: { outcome: 'cancelled' } })
    );
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = app.connect(stream);
    child.once('error', (error) => {
      connection.close(error);
      runtime?.cancelPermissions();
      runtimes.delete(key);
    });
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'WorkAny', version: '0.2.0' },
      });
      const session = await connection.agent.buildSession(cwd).start();
      const preferredModel = preferredModelValue(
        session.newSessionResponse.configOptions || [],
        config.model,
        config.modelProvider
      );
      if (preferredModel) {
        await connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId: session.sessionId,
          configId: preferredModel.configId,
          value: preferredModel.value,
        });
      }
      runtime = new AcpRuntime(key, config, cwd, child, connection, session);
      return runtime;
    } catch (error) {
      connection.close(error);
      child.kill();
      throw error;
    }
  }

  async prompt(prompt: string, emit: Emit, signal: AbortSignal) {
    if (this.prompting)
      throw new Error(`${this.config.name} is already responding`);
    this.prompting = true;
    this.emit = emit;
    this.seenTools.clear();
    const cancel = () =>
      void this.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: this.session.sessionId,
      });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      emit({ type: 'session', sessionId: this.key });
      void this.session.prompt(prompt).catch(() => undefined);
      while (true) {
        const message = await this.session.nextUpdate();
        if (message.kind === 'stop') break;
        this.handleUpdate(message.update, emit);
      }
      emit({ type: 'done' });
    } finally {
      signal.removeEventListener('abort', cancel);
      this.emit = null;
      this.prompting = false;
    }
  }

  respondPermission(requestId: string, approved: boolean): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    const preferredKinds = approved
      ? ['allow_once', 'allow_always']
      : ['reject_once', 'reject_always'];
    const option = pending.options.find((item) =>
      preferredKinds.includes((item as { kind?: string }).kind || '')
    );
    this.pendingPermissions.delete(requestId);
    pending.resolve(
      option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    );
    return true;
  }

  close() {
    this.cancelPermissions();
    this.session.dispose();
    this.connection.close();
    this.child.kill();
  }

  private handleUpdate(update: SessionUpdate, emit: Emit) {
    const text = textFromUpdate(update);
    if (text) {
      emit({ type: 'text', content: text, isDelta: true });
      return;
    }
    if (
      update.sessionUpdate !== 'tool_call' &&
      update.sessionUpdate !== 'tool_call_update'
    )
      return;
    if (!this.seenTools.has(update.toolCallId)) {
      this.seenTools.add(update.toolCallId);
      emit({
        type: 'tool_use',
        id: update.toolCallId,
        name: update.title || 'Tool',
        input: update.rawInput,
      });
    }
    if (update.status === 'completed' || update.status === 'failed') {
      emit({
        type: 'tool_result',
        toolUseId: update.toolCallId,
        output: detail(update.rawOutput ?? update.content),
        isError: update.status === 'failed',
      });
    }
  }

  private requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    if (!this.emit)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const requestId = randomUUID();
    this.emit({
      type: 'permission_request',
      permission: {
        id: requestId,
        tool: params.toolCall.title || 'Agent action',
        description: `Allow ${this.config.name} to perform this action?`,
        risk_level: 'medium',
      } as AgentMessage['permission'],
    } as AgentMessage);
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        options: params.options,
      });
    });
  }

  private cancelPermissions() {
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
  }
}

const runtimes = new Map<string, AcpRuntime>();

export async function promptAcpRuntime(input: {
  key: string;
  runtime: AcpRuntimeConfig;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  emit: Emit;
}) {
  let runtime = runtimes.get(input.key);
  if (
    runtime &&
    (runtime.config.id !== input.runtime.id ||
      runtime.config.command !== input.runtime.command ||
      runtime.config.args !== input.runtime.args ||
      runtime.config.model !== input.runtime.model ||
      runtime.config.modelProvider !== input.runtime.modelProvider ||
      runtime.config.apiKey !== input.runtime.apiKey ||
      runtime.config.baseUrl !== input.runtime.baseUrl ||
      runtime.config.apiType !== input.runtime.apiType ||
      runtime.cwd !== input.cwd)
  ) {
    runtime.close();
    runtimes.delete(input.key);
    runtime = undefined;
  }
  if (!runtime) {
    runtime = await AcpRuntime.create(input.key, input.runtime, input.cwd);
    runtimes.set(input.key, runtime);
  }
  await runtime.prompt(input.prompt, input.emit, input.signal);
}

export function respondAcpPermission(
  key: string,
  requestId: string,
  approved: boolean
) {
  return runtimes.get(key)?.respondPermission(requestId, approved) ?? false;
}

export function closeAcpRuntime(key: string) {
  runtimes.get(key)?.close();
  runtimes.delete(key);
}

export function closeAllAcpRuntimes() {
  for (const runtime of runtimes.values()) runtime.close();
  runtimes.clear();
}
