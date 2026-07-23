import { useState } from 'react';
import type { AgentMessage } from '@/shared/hooks/useAgent';
import { cn } from '@/shared/lib/utils';
import { AlertCircle, ChevronDown, LoaderCircle, Terminal } from 'lucide-react';

interface ToolExecutionItemProps {
  message: AgentMessage;
  result?: AgentMessage;
  isLast: boolean;
}

function getToolDisplayName(toolName: string): string {
  const names: Record<string, string> = {
    Bash: 'Run command',
    bash: 'Run command',
    Read: 'Read file',
    read: 'Read file',
    Write: 'Write file',
    write: 'Write file',
    Edit: 'Edit file',
    edit: 'Edit file',
    Grep: 'Search text',
    grep: 'Search text',
    Glob: 'Find files',
    glob: 'Find files',
    WebFetch: 'Fetch page',
    webfetch: 'Fetch page',
    WebSearch: 'Search web',
    Task: 'Run task',
    task: 'Run task',
    Skill: 'Use skill',
    skill: 'Use skill',
    TodoWrite: 'Update tasks',
    todowrite: 'Update tasks',
  };
  return names[toolName] || toolName;
}

function getToolSubject(
  toolName: string,
  input: Record<string, unknown> | undefined,
  outputPath?: string
): string {
  const value =
    toolName.toLowerCase() === 'bash'
      ? input?.command
      : input?.file_path ||
        input?.path ||
        input?.pattern ||
        input?.query ||
        input?.url ||
        input?.description ||
        outputPath;
  return typeof value === 'string' ? value : outputPath || '';
}

interface NormalizedOutput {
  text: string;
  path?: string;
  type?: string;
  entryCount?: number;
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function tagValue(value: string, tag: string): string | undefined {
  return value
    .match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]
    ?.trim();
}

function normalizeOutput(output?: string): NormalizedOutput {
  if (!output) return { text: '' };
  let value = output.trim();
  let path: string | undefined;
  let type: string | undefined;

  // Unwrap persisted ACP envelopes from older conversations. Some runtimes
  // wrap more than once, so allow a small, bounded number of passes.
  for (let pass = 0; pass < 2; pass++) {
    const record = parseRecord(value);
    if (!record) break;
    const display =
      record.metadata && typeof record.metadata === 'object'
        ? (record.metadata as Record<string, unknown>).display
        : undefined;
    if (display && typeof display === 'object') {
      const metadata = display as Record<string, unknown>;
      if (typeof metadata.path === 'string') path = metadata.path;
      if (typeof metadata.type === 'string') type = metadata.type;
    }
    if (typeof record.output === 'string') value = record.output.trim();
    else if (typeof record.text === 'string') value = record.text.trim();
    else break;
  }

  const error = tagValue(value, 'tool_use_error');
  if (error !== undefined) value = error;

  path = tagValue(value, 'path') || path;
  type = tagValue(value, 'type') || type;
  const content = tagValue(value, 'content');
  const entries = tagValue(value, 'entries');
  const entryCountMatch = entries?.match(/\((\d+) entries\)\s*$/i);
  const entryCount = entryCountMatch ? Number(entryCountMatch[1]) : undefined;

  if (content !== undefined) {
    value = content;
  } else if (entries !== undefined) {
    value = entries.replace(/\n*\(\d+ entries\)\s*$/i, '').trim();
    if (!value && entryCount === 0) value = 'Directory is empty';
  } else if (path || type) {
    value = value
      .replace(/<path>[\s\S]*?<\/path>/gi, '')
      .replace(/<type>[\s\S]*?<\/type>/gi, '')
      .trim();
  }

  return {
    text:
      value.length > 10_000
        ? `${value.slice(0, 10_000)}\n\n… truncated`
        : value,
    path,
    type,
    entryCount,
  };
}

function lineCount(value: string): number {
  return value ? value.split('\n').filter((line) => line.trim()).length : 0;
}

function resultSummary(
  toolName: string,
  result: AgentMessage | undefined,
  output: NormalizedOutput
): string {
  if (!result) return 'Running';
  if (result.isError) {
    return output.text.split('\n').find((line) => line.trim()) || 'Tool failed';
  }
  const count = lineCount(output.text);
  const normalized = toolName.toLowerCase();
  if (normalized === 'read' && output.type === 'directory') {
    return output.entryCount
      ? `${output.entryCount} items`
      : 'Directory is empty';
  }
  if (normalized === 'read')
    return count ? `${count} lines read` : 'Read complete';
  if (normalized === 'write') return 'File written';
  if (normalized === 'edit') return 'File edited';
  if (normalized === 'grep') return count ? `${count} matches` : 'No matches';
  if (normalized === 'glob') return count ? `${count} files` : 'No files';
  if (normalized === 'todowrite') return 'Task list updated';
  if (!output.text) return 'Completed';
  return count === 1 ? output.text.slice(0, 100) : `${count} lines`;
}

function formatDetail(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: NormalizedOutput,
  isError: boolean
): string {
  const normalized = toolName.toLowerCase();
  if (!isError && ['write', 'edit', 'todowrite'].includes(normalized)) {
    return '';
  }
  const blocks: string[] = [];
  if (normalized === 'bash' && typeof input?.command === 'string') {
    blocks.push(`$ ${input.command}`);
  } else if (output.path) {
    blocks.push(output.path);
  } else if (normalized === 'grep' && typeof input?.pattern === 'string') {
    blocks.push(`Search: ${input.pattern}`);
  }
  if (output.text) blocks.push(output.text);
  return blocks.join('\n\n');
}

export function ToolExecutionItem({
  message,
  result,
  isLast,
}: ToolExecutionItemProps) {
  const [expanded, setExpanded] = useState(false);
  const toolName = message.name || 'Tool';
  const input = message.input as Record<string, unknown> | undefined;
  const output = normalizeOutput(result?.output || result?.content);
  const running = isLast && !result;
  const failed = !!result?.isError;
  const detail = formatDetail(toolName, input, output, failed);
  const subject = getToolSubject(toolName, input, output.path);
  const invalidTool = /^\$TOOL_NAME/i.test(toolName);
  const title = invalidTool
    ? `Invalid tool call · ${toolName}`
    : getToolDisplayName(toolName);
  const summary = resultSummary(toolName, result, output);

  return (
    <div
      className={cn(
        'text-[13px]',
        (failed || invalidTool) && 'text-destructive'
      )}
    >
      <button
        type="button"
        disabled={!detail}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          'group flex w-full items-start gap-2 bg-transparent py-1 text-left leading-5',
          detail ? 'cursor-pointer' : 'cursor-default',
          !failed &&
            !invalidTool &&
            'text-muted-foreground hover:text-foreground'
        )}
      >
        {running ? (
          <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
        ) : failed || invalidTool ? (
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <Terminal className="mt-0.5 size-3.5 shrink-0" />
        )}

        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'font-medium group-hover:text-inherit',
              failed || invalidTool ? 'text-destructive' : 'text-foreground'
            )}
          >
            {title}
          </span>
          {subject && (
            <span className="text-muted-foreground ml-1 break-all">
              {subject.length > 90 ? `${subject.slice(0, 90)}…` : subject}
            </span>
          )}
          <span
            className={cn(
              'ml-2',
              failed || invalidTool
                ? 'text-destructive'
                : 'text-muted-foreground/70'
            )}
          >
            {summary.length > 120 ? `${summary.slice(0, 120)}…` : summary}
          </span>
        </span>

        {detail && (
          <ChevronDown
            className={cn(
              'mt-0.5 size-3.5 shrink-0 opacity-0 transition-all group-hover:opacity-100',
              expanded && 'rotate-180 opacity-100'
            )}
          />
        )}
      </button>

      {expanded && detail && (
        <pre
          className={cn(
            'border-border bg-muted/45 text-muted-foreground mt-1 mb-2 ml-5 max-h-64 overflow-auto rounded-lg border px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap',
            (failed || invalidTool) &&
              'border-destructive/20 bg-destructive/5 text-destructive'
          )}
        >
          {detail}
        </pre>
      )}
    </div>
  );
}
