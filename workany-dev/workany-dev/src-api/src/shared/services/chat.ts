/**
 * Lightweight Chat Service
 *
 * Directly calls the LLM API for simple conversational queries,
 * bypassing the Claude Agent SDK to avoid CLI subprocess, tools, and thinking mode overhead.
 *
 * Supports both Anthropic (native SDK) and OpenAI-compatible APIs (fetch).
 */

import Anthropic from '@anthropic-ai/sdk';

import type { AgentMessage, ConversationMessage } from '@/core/agent/types';

import { createLogger } from '@/shared/utils/logger';

const logger = createLogger('ChatService');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

// Maximum number of conversation messages to include in API calls
// to prevent excessive token usage. Each "turn" is a user+assistant pair.
const MAX_CONTEXT_MESSAGES = 40; // 20 turns × 2 messages

function isAnthropicModel(model: string): boolean {
  return model.startsWith('claude-') || model.includes('claude');
}

function resolveConfig(modelConfig?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  apiType?: string;
}) {
  // Use explicit modelConfig from user settings only — no environment variable fallback
  const apiKey = modelConfig?.apiKey || '';
  const baseURL = modelConfig?.baseUrl || undefined;
  const model = modelConfig?.model || DEFAULT_MODEL;

  return { apiKey, baseURL, model, apiType: modelConfig?.apiType };
}

// ============================================================================
// OpenAI-compatible streaming (for non-Anthropic models via proxy)
// ============================================================================

async function* runOpenAICompatibleChat(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  apiKey: string,
  baseURL: string | undefined,
  model: string,
  abortController?: AbortController
): AsyncGenerator<AgentMessage> {
  // Derive the OpenAI-compatible base URL from the Anthropic-style baseURL
  // e.g. "https://openrouter.ai/api/v1" -> use as-is, append /chat/completions
  // Most proxies support /v1/chat/completions
  let endpoint: string;
  if (baseURL) {
    const base = baseURL.replace(/\/+$/, '');
    // If already ends with /v1, just append /chat/completions
    if (base.endsWith('/v1')) {
      endpoint = `${base}/chat/completions`;
    } else {
      endpoint = `${base}/v1/chat/completions`;
    }
  } else {
    endpoint = 'https://api.openai.com/v1/chat/completions';
  }

  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  logger.info('[ChatService] OpenAI-compatible request:', { endpoint, model });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      max_tokens: 4096,
      stream: true,
    }),
    signal: abortController?.signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status} ${errorText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content) {
          yield { type: 'text', content };
        }
      } catch {
        // skip unparseable chunks
      }
    }
  }

  yield { type: 'done' };
}

async function openAICompatibleCreate(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  apiKey: string,
  baseURL: string | undefined,
  model: string,
  maxTokens: number
): Promise<string> {
  let endpoint: string;
  if (baseURL) {
    const base = baseURL.replace(/\/+$/, '');
    endpoint = base.endsWith('/v1')
      ? `${base}/chat/completions`
      : `${base}/v1/chat/completions`;
  } else {
    endpoint = 'https://api.openai.com/v1/chat/completions';
  }

  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: openaiMessages,
      max_tokens: maxTokens,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${response.status} ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ============================================================================
// Main chat function
// ============================================================================

/**
 * Run a lightweight chat using the appropriate API.
 * - Anthropic models: uses Anthropic SDK
 * - Other models: uses OpenAI-compatible fetch
 */
export async function* runChat(
  prompt: string,
  modelConfig?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    apiType?: string;
  },
  _language?: string,
  conversation?: ConversationMessage[],
  abortController?: AbortController
): AsyncGenerator<AgentMessage> {
  const { apiKey, baseURL, model, apiType } = resolveConfig(modelConfig);
  const useAnthropic = apiType
    ? apiType === 'anthropic-messages'
    : isAnthropicModel(model);

  if (!apiKey) {
    yield { type: 'error', message: 'No API key configured. Please set up your API key in Settings.' };
    yield { type: 'done' };
    return;
  }

  logger.info('[ChatService] Starting chat:', {
    model,
    hasBaseURL: !!baseURL,
    isAnthropic: useAnthropic,
    hasConversation: !!(conversation && conversation.length > 0),
    promptLength: prompt.length,
  });

  const systemPrompt = `You are the built-in chat assistant inside WorkAny, an AI workspace for conversations and agent-powered tasks.
Be concise and practical. When the user asks about code, commands, or files, explain the next useful action clearly. Do not claim to have run tools, accessed the user's computer, or changed files unless the conversation explicitly contains those results.
The conversation history may contain replies written by a different model or agent the user was talking to earlier. Treat those replies as context only—never adopt their identity, name, or model. Do not identify yourself as the underlying model provider or model. When asked who you are, you are WorkAny's built-in chat assistant, and you have no tool access.
Always reply in the same language as the user's latest message. If the language cannot be determined reliably, reply in English.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (conversation && conversation.length > 0) {
    // Limit conversation history to prevent excessive token usage
    const trimmedConversation = conversation.length > MAX_CONTEXT_MESSAGES
      ? conversation.slice(-MAX_CONTEXT_MESSAGES)
      : conversation;

    if (trimmedConversation.length < conversation.length) {
      logger.info(`[ChatService] Truncated conversation history from ${conversation.length} to ${trimmedConversation.length} messages`);
    }

    for (const msg of trimmedConversation) {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: 'user', content: prompt });

  // Non-Anthropic models: use OpenAI-compatible API
  if (!useAnthropic) {
    try {
      yield* runOpenAICompatibleChat(messages, systemPrompt, apiKey, baseURL, model, abortController);
    } catch (error) {
      if (abortController?.signal.aborted) {
        logger.info('[ChatService] Chat aborted by user');
        yield { type: 'done' };
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[ChatService] OpenAI-compatible chat error:', errorMessage);
      yield { type: 'error', message: errorMessage };
      yield { type: 'done' };
    }
    return;
  }

  // Anthropic models: use Anthropic SDK
  const client = new Anthropic({ apiKey, baseURL });

  try {
    const requestParams: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    };

    requestParams.thinking = { type: 'disabled' };

    const stream = client.messages.stream(
      requestParams as Parameters<typeof client.messages.stream>[0]
    );

    if (abortController) {
      abortController.signal.addEventListener('abort', () => {
        stream.abort();
      });
    }

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        yield { type: 'text', content: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();
    logger.info('[ChatService] Chat completed:', {
      inputTokens: finalMessage.usage.input_tokens,
      outputTokens: finalMessage.usage.output_tokens,
    });

    yield { type: 'done' };
  } catch (error) {
    if (abortController?.signal.aborted) {
      logger.info('[ChatService] Chat aborted by user');
      yield { type: 'done' };
      return;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('[ChatService] Chat error:', errorMessage);
    yield { type: 'error', message: errorMessage };
    yield { type: 'done' };
  }
}

// ============================================================================
// Title generation
// ============================================================================

/**
 * Generate a short title from a user prompt.
 * Uses a lightweight LLM call to summarize the prompt into a concise title.
 */
export async function generateTitle(
  prompt: string,
  modelConfig?: { apiKey?: string; baseUrl?: string; model?: string },
  language?: string
): Promise<string> {
  const { apiKey, baseURL, model } = resolveConfig(modelConfig);

  if (!apiKey) {
    return prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '');
  }

  const langHint = language?.startsWith('zh') ? '请用中文回复。' : '';
  const systemPrompt = `Generate a very short title (max 20 characters) that summarizes the user's request. Output ONLY the title, no quotes, no punctuation at the end, no explanation. ${langHint}`;

  try {
    let title: string;

    if (!isAnthropicModel(model)) {
      // Non-Anthropic: OpenAI-compatible
      title = await openAICompatibleCreate(
        [{ role: 'user', content: prompt }],
        systemPrompt,
        apiKey,
        baseURL,
        model,
        50
      );
    } else {
      // Anthropic: native SDK
      const client = new Anthropic({ apiKey, baseURL });
      const response = await client.messages.create({
        model,
        max_tokens: 50,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'disabled' },
      });
      title = (response.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .join('')
        .trim();
    }

    logger.info('[ChatService] Generated title:', { prompt: prompt.slice(0, 50), title });
    return title || prompt.slice(0, 30);
  } catch (error) {
    logger.error('[ChatService] Title generation failed:', error);
    return prompt.slice(0, 30) + (prompt.length > 30 ? '...' : '');
  }
}
