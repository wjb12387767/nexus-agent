/**
 * Nexus Agent Adapter
 *
 * Implementation of the IAgent interface using the nexus CLI subprocess.
 * Bridges nexus-agent (a self-improving coding agent with sandbox, checkpoint,
 * and bash AST safety) to WorkAny's agent system via child process spawning
 * and JSON event stream parsing.
 *
 * Since nexus-agent depends on Bun runtime and monorepo workspace, it cannot
 * be directly imported into WorkAny's Node.js backend. Instead, we spawn the
 * nexus CLI binary as a subprocess and parse its JSON event output.
 */

import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { homedir, platform } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

import {
  BaseAgent,
  buildLanguageInstruction,
  formatPlanForExecution,
  getWorkspaceInstruction,
  parsePlanFromResponse,
  parsePlanningResponse,
  PLANNING_INSTRUCTION,
} from '@/core/agent/base';
import { defineAgentPlugin } from '@/core/agent/plugin';
import type { AgentPlugin } from '@/core/agent/plugin';
import type {
  AgentConfig,
  AgentMessage,
  AgentOptions,
  AgentProvider,
  ConversationMessage,
  ExecuteOptions,
  PlanOptions,
} from '@/core/agent/types';
import {
  DEFAULT_WORK_DIR,
  NEXUS_CLI_FALLBACK_NAMES,
} from '@/config/constants';
import { createLogger, LOG_FILE_PATH } from '@/shared/utils/logger';

import { NEXUS_METADATA } from './metadata';

const logger = createLogger('NexusAgent');

// ============================================================================
// Helper functions
// ============================================================================

function expandPath(inputPath: string): string {
  let result = inputPath;
  if (result.startsWith('~')) {
    result = join(homedir(), result.slice(1));
  }
  if (platform() === 'win32') {
    result = result.replace(/\//g, '\\');
  }
  return result;
}

function generateFallbackSlug(prompt: string, taskId: string): string {
  let slug = prompt
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');

  if (!slug || slug.length < 3) {
    slug = 'task';
  }

  const suffix = taskId.slice(-6);
  return `${slug}-${suffix}`;
}

function getSessionWorkDir(
  workDir: string = DEFAULT_WORK_DIR,
  prompt?: string,
  taskId?: string
): string {
  const expandedPath = expandPath(workDir);

  const hasSessionsPath =
    expandedPath.includes('/sessions/') ||
    expandedPath.includes('\\sessions\\');
  const endsWithSessions =
    expandedPath.endsWith('/sessions') ||
    expandedPath.endsWith('\\sessions');
  if (hasSessionsPath && !endsWithSessions) {
    return expandedPath;
  }

  const baseDir = expandedPath;
  const sessionsDir = join(baseDir, 'sessions');

  let folderName: string;
  if (prompt && taskId) {
    folderName = generateFallbackSlug(prompt, taskId);
  } else if (taskId) {
    folderName = taskId;
  } else {
    folderName = `session-${Date.now()}`;
  }

  return join(sessionsDir, folderName);
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await mkdir(dirPath, { recursive: true });
  } catch (error) {
    console.error('Failed to create directory:', error);
  }
}

/**
 * Search for a binary in PATH and common install locations.
 * Cross-platform: handles Windows extensions (.exe, .cmd, .bat) and
 * Unix paths (/usr/local/bin, /opt/homebrew/bin, ~/.local/bin).
 */
function findBinaryInPath(name: string): string | null {
  const isWin = platform() === 'win32';
  const pathSep = isWin ? ';' : ':';
  const extensions = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];

  // Search PATH
  const pathDirs = (process.env.PATH || '')
    .split(pathSep)
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Search common install paths
  const home = homedir();
  const commonPaths = isWin
    ? [
        join(process.env.LOCALAPPDATA || '', name, name + '.exe'),
        join(home, '.local', 'bin', name + '.exe'),
      ]
    : [
        `/usr/local/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
        join(home, '.local', 'bin', name),
      ];

  for (const p of commonPaths) {
    if (p && existsSync(p)) return p;
  }

  return null;
}

// ============================================================================
// Nexus CLI event types (defensive parsing — nexus may emit varying shapes)
// ============================================================================

interface NexusEvent {
  type?: string;
  session_id?: string;
  sessionId?: string;
  delta?: {
    text_delta?: string;
    thinking_delta?: string;
    toolcall_delta?: unknown;
  };
  text_delta?: string;
  tool_call_id?: string;
  toolCallId?: string;
  id?: string;
  tool_name?: string;
  toolName?: string;
  name?: string;
  arguments?: unknown;
  args?: unknown;
  input?: unknown;
  result?: string;
  output?: string;
  is_error?: boolean;
  isError?: boolean;
  total_cost_usd?: number;
  cost?: number;
  duration_ms?: number;
  duration?: number;
  message?: string;
  error?: string;
  text?: string;
}

// ============================================================================
// NexusAgent class
// ============================================================================

export class NexusAgent extends BaseAgent {
  readonly provider: AgentProvider = 'nexus';

  private childProcesses: Map<string, ChildProcess> = new Map();

  constructor(config: AgentConfig) {
    super(config);
    logger.info('[NexusAgent] Created with config:', {
      provider: config.provider,
      hasApiKey: !!config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      workDir: config.workDir,
      nexusPath: config.nexusPath,
    });

    // Detect CLI path at construction time (warn but don't throw)
    const cliPath = this.findNexusCli();
    if (!cliPath) {
      logger.warn(
        `[NexusAgent] nexus CLI not found. Searched PATH and common locations for: ${NEXUS_CLI_FALLBACK_NAMES.join(', ')}`
      );
    } else {
      logger.info(`[NexusAgent] Detected nexus CLI at: ${cliPath}`);
    }
  }

  // --------------------------------------------------------------------------
  // CLI detection
  // --------------------------------------------------------------------------

  private findNexusCli(): string | null {
    // 1. Explicit path from config
    if (this.config.nexusPath) {
      const expanded = expandPath(this.config.nexusPath);
      if (existsSync(expanded)) {
        return expanded;
      }
      logger.warn(`[Nexus] config.nexusPath not found: ${expanded}`);
    }

    // 2. Search PATH and common locations for each candidate name
    for (const name of NEXUS_CLI_FALLBACK_NAMES) {
      const found = findBinaryInPath(name);
      if (found) return found;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Subprocess helpers
  // --------------------------------------------------------------------------

  private isUsingCustomApi(): boolean {
    return !!(this.config.baseUrl && this.config.apiKey);
  }

  /**
   * Typed accessor for nexus settings synced from the frontend.
   * Returns undefined when no nexus settings are configured.
   */
  private getNexusSetting(key: string): unknown {
    const ns = this.config.nexusSettings;
    if (!ns || typeof ns !== 'object') return undefined;
    return (ns as Record<string, unknown>)[key];
  }

  private getNexusBool(key: string, fallback: boolean): boolean {
    const v = this.getNexusSetting(key);
    return typeof v === 'boolean' ? v : fallback;
  }

  private getNexusNumber(key: string, fallback: number): number {
    const v = this.getNexusSetting(key);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  private getNexusString(key: string, fallback: string): string {
    const v = this.getNexusSetting(key);
    return typeof v === 'string' ? v : fallback;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (this.config.apiKey) {
      if (this.config.apiType === 'openai-completions') {
        env.OPENAI_API_KEY = this.config.apiKey;
      } else {
        env.ANTHROPIC_API_KEY = this.config.apiKey;
      }
    }

    // Pass custom base URL via environment variables.
    // nexus CLI supports ANTHROPIC_BASE_URL natively; OPENAI_BASE_URL is
    // respected by most OpenAI-compatible providers. This replaces the
    // removed --api-base CLI flag.
    if (this.config.baseUrl) {
      if (this.config.apiType === 'openai-completions') {
        env.OPENAI_BASE_URL = this.config.baseUrl;
      } else {
        env.ANTHROPIC_BASE_URL = this.config.baseUrl;
      }
    }

    // Pass nexus settings via environment variables for options that
    // may not have dedicated CLI flags. The nexus CLI reads these if
    // supported; unknown variables are safely ignored.
    const boolVars: Record<string, boolean> = {
      NEXUS_FILE_SAFETY: this.getNexusBool('fileSafetyEnabled', true),
      NEXUS_DOOM_LOOP: this.getNexusBool('doomLoopDetection', true),
      NEXUS_BASH_AST: this.getNexusBool('bashAstSafety', true),
      NEXUS_COMPACTION_ENABLED: this.getNexusBool('compactionEnabled', true),
      NEXUS_AUTO_LEARN: this.getNexusBool('autoLearnEnabled', true),
      NEXUS_BACKGROUND_REVIEW: this.getNexusBool('backgroundReviewEnabled', false),
      NEXUS_CURATOR: this.getNexusBool('curatorEnabled', false),
      NEXUS_MNEMOPI: this.getNexusBool('mnemopiEnabled', false),
      NEXUS_LEARNING_GRAPH: this.getNexusBool('learningGraphEnabled', true),
      NEXUS_AUTO_LEARN_CAPTURE: this.getNexusBool('autoLearnCapture', true),
      NEXUS_REFLECT_ON_ERRORS: this.getNexusBool('reflectOnErrors', true),
      NEXUS_WSL_AUTO_DETECT: this.getNexusBool('wslAutoDetect', true),
      NEXUS_WSL_SUPPRESS_HINT: this.getNexusBool('wslSuppressHint', false),
      NEXUS_PROMPT_CACHING: this.getNexusBool('promptCaching', true),
      NEXUS_CONTEXT_BREAKDOWN: this.getNexusBool('contextBreakdown', false),
      NEXUS_THINK_SCRUBBER: this.getNexusBool('thinkScrubber', true),
      NEXUS_TELEMETRY: this.getNexusBool('telemetry', false),
      NEXUS_DEBUG: this.getNexusBool('debugMode', false),
    };
    for (const [key, value] of Object.entries(boolVars)) {
      env[key] = value ? 'true' : 'false';
    }

    const numVars: Record<string, number> = {
      NEXUS_CHECKPOINT_INTERVAL: this.getNexusNumber('autoCheckpointInterval', 300),
      NEXUS_MAX_CHECKPOINTS: this.getNexusNumber('maxCheckpoints', 50),
      NEXUS_COMPACTION_THRESHOLD: this.getNexusNumber('compactionThreshold', 75),
    };
    for (const [key, value] of Object.entries(numVars)) {
      env[key] = String(value);
    }

    const strVars: Record<string, string> = {
      NEXUS_SANDBOX_FALLBACK: this.getNexusString('sandboxFallbackBehavior', 'warn'),
      NEXUS_WSL_DISTRO: this.getNexusString('wslPreferredDistro', ''),
    };
    for (const [key, value] of Object.entries(strVars)) {
      if (value) env[key] = value;
    }

    return env;
  }

  private buildNexusArgs(
    prompt: string,
    sessionCwd: string,
    mode: 'run' | 'plan' | 'execute'
  ): string[] {
    const args: string[] = ['--print', '--json'];

    if (mode === 'plan') {
      args.push('--plan-only');
    }

    args.push('--cwd', sessionCwd);

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // Max turns — read from nexus settings, fallback to 200
    const maxTurns = this.getNexusNumber('maxTurns', 200);
    args.push('--max-turns', String(maxTurns));

    // Permission mode — read from nexus settings, fallback to bypass
    const permissionMode = this.getNexusString('permissionMode', 'bypass');
    args.push('--permission-mode', permissionMode);

    // Thinking level — only pass when not the default 'adaptive'
    const thinkingLevel = this.getNexusString('thinkingLevel', 'adaptive');
    if (thinkingLevel && thinkingLevel !== 'adaptive') {
      args.push('--thinking', thinkingLevel);
    }

    // Sandbox toggle
    const sandboxEnabled = this.getNexusBool('sandboxEnabled', true);
    args.push('--sandbox', sandboxEnabled ? 'true' : 'false');

    // Checkpoint toggle
    const checkpointEnabled = this.getNexusBool('checkpointEnabled', true);
    if (checkpointEnabled) {
      args.push('--checkpoint');
    }

    // NOTE: --api-base flag was removed because nexus CLI does not support it.
    // Base URL is passed via environment variables (ANTHROPIC_BASE_URL / OPENAI_BASE_URL)
    // in buildEnv(). Unknown CLI flags cause hard errors in nexus.

    // Positional prompt (must be last)
    args.push(prompt);

    return args;
  }

  private classifyError(errorMsg: string): string {
    const apiKeyPatterns = [
      /Invalid API key/i,
      /invalid_api_key/i,
      /API key.*invalid/i,
      /authentication.*fail/i,
      /Unauthorized/i,
      /\b401\b/,
      /\b403\b/,
      /身份验证失败/,
      /认证失败/,
      /鉴权失败/,
      /密钥无效/,
    ];

    if (apiKeyPatterns.some((p) => p.test(errorMsg))) {
      return '__API_KEY_ERROR__';
    }

    if (
      this.isUsingCustomApi() &&
      /model|not found|not supported/i.test(errorMsg)
    ) {
      return `__CUSTOM_API_ERROR__|${this.config.baseUrl}|${LOG_FILE_PATH}`;
    }

    return `__INTERNAL_ERROR__|${LOG_FILE_PATH}`;
  }

  // --------------------------------------------------------------------------
  // Event parsing
  // --------------------------------------------------------------------------

  private parseNexusEvent(line: string): AgentMessage | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    // Try JSON parsing first
    let event: NexusEvent;
    try {
      event = JSON.parse(trimmed) as NexusEvent;
    } catch {
      // Not JSON — treat as plain text delta (nexus --print may emit raw text)
      return { type: 'text', content: trimmed, isDelta: true };
    }

    if (typeof event !== 'object' || event === null) return null;

    const eventType = event.type;

    switch (eventType) {
      case 'agent_start':
        return {
          type: 'session',
          sessionId: event.session_id || event.sessionId,
        };

      case 'turn_start':
      case 'message_start':
      case 'message_end':
        // Lifecycle events — no AgentMessage equivalent
        return null;

      case 'message_update': {
        const delta = event.delta || event;
        if (delta.text_delta) {
          return { type: 'text', content: delta.text_delta, isDelta: true };
        }
        // Skip thinking_delta and toolcall_delta (not surfaced as AgentMessage)
        return null;
      }

      case 'tool_execution_start':
        return {
          type: 'tool_use',
          id: event.tool_call_id || event.toolCallId || event.id,
          name: event.tool_name || event.toolName || event.name,
          input: event.arguments ?? event.args ?? event.input,
        };

      case 'tool_execution_end':
        return {
          type: 'tool_result',
          toolUseId: event.tool_call_id || event.toolCallId || '',
          output: event.result ?? event.output ?? '',
          isError: event.is_error ?? event.isError ?? false,
        };

      case 'turn_end':
        return null;

      case 'agent_end':
        return {
          type: 'result',
          content: 'success',
          cost: event.total_cost_usd ?? event.cost,
          duration: event.duration_ms ?? event.duration,
        };

      case 'error':
        return {
          type: 'error',
          message: event.message || event.error || 'Unknown nexus error',
        };

      default:
        // Unknown event type — extract text if present, otherwise skip
        if (event.text) {
          return { type: 'text', content: event.text, isDelta: true };
        }
        return null;
    }
  }

  // --------------------------------------------------------------------------
  // Conversation history
  // --------------------------------------------------------------------------

  private formatConversationHistory(
    conversation?: ConversationMessage[]
  ): string {
    if (!conversation || conversation.length === 0) return '';

    const formatted = conversation
      .map((msg) => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        return `${role}: ${msg.content}`;
      })
      .join('\n\n');

    return `## Previous Conversation Context\n\n${formatted}\n\n---\n## Current Request\n`;
  }

  // --------------------------------------------------------------------------
  // Subprocess runner
  // --------------------------------------------------------------------------

  private async *runNexusSubprocess(
    prompt: string,
    sessionCwd: string,
    session: { id: string; abortController: AbortController },
    mode: 'run' | 'plan' | 'execute'
  ): AsyncGenerator<AgentMessage> {
    const cliPath = this.findNexusCli();
    if (!cliPath) {
      yield { type: 'error', message: '__NEXUS_CLI_NOT_FOUND__' };
      return;
    }

    const args = this.buildNexusArgs(prompt, sessionCwd, mode);
    const env = this.buildEnv();

    logger.info(`[Nexus ${session.id}] ========== AGENT START ==========`);
    logger.info(`[Nexus ${session.id}] CLI: ${cliPath}`);
    logger.info(`[Nexus ${session.id}] Mode: ${mode}`);
    logger.info(
      `[Nexus ${session.id}] Model: ${this.config.model || '(default)'}`
    );
    logger.info(
      `[Nexus ${session.id}] Custom API: ${this.isUsingCustomApi()}`
    );
    logger.info(`[Nexus ${session.id}] Working Directory: ${sessionCwd}`);
    logger.info(`[Nexus ${session.id}] Prompt length: ${prompt.length} chars`);

    const child = spawn(cliPath, args, {
      cwd: sessionCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.childProcesses.set(session.id, child);

    let stderrBuffer = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    const donePromise = new Promise<{
      code: number;
      error: Error | null;
    }>((resolve) => {
      child.on('error', (err) => resolve({ code: -1, error: err }));
      child.on('close', (code) =>
        resolve({ code: code ?? 0, error: null })
      );
    });

    try {
      if (child.stdout) {
        const rl = createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });
        for await (const line of rl) {
          if (session.abortController.signal.aborted) break;
          const msg = this.parseNexusEvent(line);
          if (msg) yield msg;
        }
      }

      const { code, error } = await donePromise;

      if (error) {
        throw error;
      }

      if (code !== 0 && !session.abortController.signal.aborted) {
        const errorMsg =
          stderrBuffer.trim() || `nexus exited with code ${code}`;
        logger.error(
          `[Nexus ${session.id}] Process exited with code ${code}: ${errorMsg}`
        );
        yield { type: 'error', message: this.classifyError(errorMsg) };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`[Nexus ${session.id}] Error:`, {
        message: errorMessage,
      });
      yield { type: 'error', message: this.classifyError(errorMessage) };
    } finally {
      this.childProcesses.delete(session.id);
    }
  }

  // ==========================================================================
  // Core agent methods
  // ==========================================================================

  async *run(
    prompt: string,
    options?: AgentOptions
  ): AsyncGenerator<AgentMessage> {
    const session = this.createSession('executing', {
      id: options?.sessionId,
      abortController: options?.abortController,
    });
    yield { type: 'session', sessionId: session.id };

    const sessionCwd = getSessionWorkDir(
      options?.cwd || this.config.workDir,
      prompt,
      options?.taskId
    );
    await ensureDir(sessionCwd);

    const conversationContext = this.formatConversationHistory(
      options?.conversation
    );
    const languageInstruction = buildLanguageInstruction(
      options?.language,
      prompt
    );
    const workspaceInstruction = getWorkspaceInstruction(sessionCwd);

    const enhancedPrompt =
      workspaceInstruction +
      conversationContext +
      languageInstruction +
      prompt;

    try {
      yield* this.runNexusSubprocess(
        enhancedPrompt,
        sessionCwd,
        session,
        'run'
      );
    } finally {
      this.sessions.delete(session.id);
      yield { type: 'done' };
    }
  }

  async *plan(
    prompt: string,
    options?: PlanOptions
  ): AsyncGenerator<AgentMessage> {
    const session = this.createSession('planning', {
      id: options?.sessionId,
      abortController: options?.abortController,
    });
    yield { type: 'session', sessionId: session.id };

    const sessionCwd = getSessionWorkDir(
      options?.cwd || this.config.workDir,
      prompt,
      options?.taskId
    );
    await ensureDir(sessionCwd);
    logger.info(
      `[Nexus ${session.id}] Planning started, cwd: ${sessionCwd}`
    );

    const languageInstruction = buildLanguageInstruction(
      options?.language,
      prompt
    );
    const planningPrompt =
      PLANNING_INSTRUCTION + languageInstruction + prompt;

    let fullResponse = '';

    try {
      for await (const msg of this.runNexusSubprocess(
        planningPrompt,
        sessionCwd,
        session,
        'plan'
      )) {
        if (msg.type === 'text' && msg.content) {
          fullResponse += msg.content;
          yield msg;
        } else if (msg.type === 'error') {
          yield msg;
        }
        // Skip other event types during planning (tool_use, result, etc.)
      }

      if (fullResponse) {
        const planningResult = parsePlanningResponse(fullResponse);

        if (planningResult?.type === 'direct_answer') {
          yield { type: 'direct_answer', content: planningResult.answer };
        } else if (
          planningResult?.type === 'plan' &&
          planningResult.plan.steps.length > 0
        ) {
          this.storePlan(planningResult.plan);
          yield { type: 'plan', plan: planningResult.plan };
        } else {
          const plan = parsePlanFromResponse(fullResponse);
          if (plan && plan.steps.length > 0) {
            this.storePlan(plan);
            yield { type: 'plan', plan };
          } else {
            yield {
              type: 'direct_answer',
              content: fullResponse.trim(),
            };
          }
        }
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`[Nexus ${session.id}] Planning error:`, {
        message: errorMessage,
      });
      yield { type: 'error', message: this.classifyError(errorMessage) };
    } finally {
      this.sessions.delete(session.id);
      yield { type: 'done' };
    }
  }

  async *execute(options: ExecuteOptions): AsyncGenerator<AgentMessage> {
    const session = this.createSession('executing', {
      id: options.sessionId,
      abortController: options.abortController,
    });
    yield { type: 'session', sessionId: session.id };

    const plan = options.plan || this.getPlan(options.planId);
    if (!plan) {
      yield { type: 'error', message: `Plan not found: ${options.planId}` };
      yield { type: 'done' };
      return;
    }

    const sessionCwd = getSessionWorkDir(
      options.cwd || this.config.workDir,
      options.originalPrompt,
      options.taskId
    );
    await ensureDir(sessionCwd);
    logger.info(
      `[Nexus ${session.id}] Executing plan: ${plan.id}, cwd: ${sessionCwd}`
    );

    const executionPrompt =
      formatPlanForExecution(
        plan,
        sessionCwd,
        undefined,
        options.language,
        options.originalPrompt
      ) +
      '\n\nOriginal request: ' +
      options.originalPrompt;

    try {
      yield* this.runNexusSubprocess(
        executionPrompt,
        sessionCwd,
        session,
        'execute'
      );
    } finally {
      this.deletePlan(options.planId);
      this.sessions.delete(session.id);
      yield { type: 'done' };
    }
  }

  async stop(sessionId: string): Promise<void> {
    const child = this.childProcesses.get(sessionId);
    if (child) {
      try {
        child.kill();
        logger.info(`[Nexus ${sessionId}] Killed child process`);
      } catch (error) {
        logger.warn(
          `[Nexus ${sessionId}] Failed to kill child process:`,
          error
        );
      }
      this.childProcesses.delete(sessionId);
    }
    await super.stop(sessionId);
  }

  async shutdown(): Promise<void> {
    for (const [, child] of this.childProcesses) {
      try {
        child.kill();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.childProcesses.clear();
    await super.shutdown();
  }
}

// ============================================================================
// Factory & Plugin
// ============================================================================

export function createNexusAgent(config: AgentConfig): NexusAgent {
  return new NexusAgent(config);
}

export const nexusPlugin: AgentPlugin = defineAgentPlugin({
  metadata: NEXUS_METADATA,
  factory: (config) => createNexusAgent(config),
});
