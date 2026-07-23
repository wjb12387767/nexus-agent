import { type AgentRuntimeSetting } from '@/shared/db/settings';
import { Bot, Plus, Trash2 } from 'lucide-react';
import { nanoid } from 'nanoid';

import type { SettingsTabProps } from '../types';

export function AgentSettings({
  settings,
  onSettingsChange,
}: SettingsTabProps) {
  const updateRuntime = (
    id: string,
    update: (runtime: AgentRuntimeSetting) => AgentRuntimeSetting
  ) => {
    onSettingsChange({
      ...settings,
      agentRuntimes: settings.agentRuntimes.map((runtime) =>
        runtime.id === id ? update(runtime) : runtime
      ),
    });
  };

  const addRuntime = () => {
    const runtime: AgentRuntimeSetting = {
      id: `acp-${nanoid(8)}`,
      type: 'acp',
      name: 'New agent',
      enabled: true,
      config: { protocol: 'acp', command: '', args: '' },
    };
    onSettingsChange({
      ...settings,
      agentRuntimes: [...settings.agentRuntimes, runtime],
    });
  };

  const removeRuntime = (id: string) => {
    onSettingsChange({
      ...settings,
      agentRuntimes: settings.agentRuntimes.filter(
        (runtime) => runtime.id !== id
      ),
      defaultAgentRuntime:
        settings.defaultAgentRuntime === id
          ? 'codeany'
          : settings.defaultAgentRuntime,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-foreground font-medium">Agent runtimes</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            WorkAny runs in-process. Other agents connect through ACP over
            stdio.
          </p>
        </div>
        <button
          type="button"
          onClick={addRuntime}
          className="bg-foreground text-background hover:bg-foreground/90 flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium"
        >
          <Plus className="size-4" />
          Add agent
        </button>
      </div>

      <div className="space-y-3">
        {settings.agentRuntimes.map((runtime) => {
          const builtIn = runtime.type === 'codeany';
          return (
            <section
              key={runtime.id}
              className="border-border bg-card rounded-xl border p-4"
            >
              <div className="flex items-center gap-3">
                <span className="bg-muted flex size-9 items-center justify-center rounded-lg">
                  <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  {builtIn ? (
                    <div className="text-sm font-medium">WorkAny</div>
                  ) : (
                    <input
                      value={runtime.name}
                      onChange={(event) =>
                        updateRuntime(runtime.id, (current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                      aria-label="Agent name"
                      className="border-input bg-background focus:ring-ring h-9 w-full rounded-lg border px-3 text-sm focus:ring-2 focus:outline-none"
                    />
                  )}
                  <p className="text-muted-foreground mt-1 text-xs">
                    {builtIn ? 'Built-in · open-agent-sdk' : 'External · ACP'}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Enabled</span>
                  <input
                    type="checkbox"
                    checked={runtime.enabled}
                    disabled={builtIn}
                    onChange={(event) =>
                      updateRuntime(runtime.id, (current) => ({
                        ...current,
                        enabled: event.target.checked,
                      }))
                    }
                    className="accent-primary size-4"
                  />
                </label>
                {!builtIn && (
                  <button
                    type="button"
                    onClick={() => removeRuntime(runtime.id)}
                    aria-label={`Remove ${runtime.name}`}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded-lg p-2"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>

              {!builtIn && (
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-muted-foreground text-xs">
                      Command
                    </span>
                    <input
                      value={String(runtime.config.command || '')}
                      onChange={(event) =>
                        updateRuntime(runtime.id, (current) => ({
                          ...current,
                          config: {
                            ...current.config,
                            protocol: 'acp',
                            command: event.target.value,
                          },
                        }))
                      }
                      placeholder="opencode"
                      spellCheck={false}
                      className="border-input bg-background focus:ring-ring h-9 rounded-lg border px-3 font-mono text-sm focus:ring-2 focus:outline-none"
                    />
                  </label>
                  <label className="grid gap-1.5 text-sm">
                    <span className="text-muted-foreground text-xs">
                      Arguments
                    </span>
                    <input
                      value={String(runtime.config.args || '')}
                      onChange={(event) =>
                        updateRuntime(runtime.id, (current) => ({
                          ...current,
                          config: {
                            ...current.config,
                            args: event.target.value,
                          },
                        }))
                      }
                      placeholder="acp"
                      spellCheck={false}
                      className="border-input bg-background focus:ring-ring h-9 rounded-lg border px-3 font-mono text-sm focus:ring-2 focus:outline-none"
                    />
                  </label>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
