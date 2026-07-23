/**
 * Nexus Agent Provider Metadata
 *
 * Metadata for the NexusAgent provider plugin.
 * Nexus is a self-improving coding agent with sandbox, checkpoint,
 * and bash AST safety features. It runs as an external CLI binary
 * (bridged via subprocess from the Node.js host process).
 */

import type { AgentProviderMetadata } from '@/core/agent/plugin';

/**
 * JSON Schema for Nexus agent configuration
 */
export const NEXUS_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    apiKey: {
      type: 'string',
      description: 'API key (Anthropic or third-party provider)',
    },
    baseUrl: {
      type: 'string',
      description: 'Custom API base URL (e.g. OpenRouter, third-party gateway)',
    },
    model: {
      type: 'string',
      default: 'claude-sonnet-4-20250514',
      description: 'Model identifier to use with nexus',
    },
    workDir: {
      type: 'string',
      description: 'Working directory for file operations',
    },
    nexusPath: {
      type: 'string',
      description: 'Explicit path to the nexus CLI binary (overrides PATH search)',
    },
  },
};

/**
 * Metadata for the built-in Nexus agent provider.
 */
export const NEXUS_METADATA: AgentProviderMetadata = {
  type: 'nexus',
  name: 'Nexus Agent',
  version: '1.0.0',
  description:
    'Nexus Agent — self-improving coding agent with sandbox, checkpoint, and bash AST safety. Runs via external nexus CLI subprocess.',
  configSchema: NEXUS_CONFIG_SCHEMA,
  builtin: true,
  supportsPlan: true,
  supportsStreaming: true,
  supportsSandbox: true,
  supportedModels: [
    'claude-sonnet-4-20250514',
    'claude-opus-4-20250514',
    'claude-3-5-sonnet-20241022',
    'gpt-4o',
    'gpt-4o-mini',
    'deepseek-chat',
    'qwen3-coder-plus',
  ],
  defaultModel: 'claude-sonnet-4-20250514',
  tags: ['nexus', 'coding-agent', 'sandbox', 'checkpoint', 'self-improving'],
};
