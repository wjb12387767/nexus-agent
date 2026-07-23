import { useMemo, useState } from 'react';
import { getSettings, type AgentRuntimeSetting } from '@/shared/db/settings';
import { cn } from '@/shared/lib/utils';
import {
  Bot,
  Check,
  ChevronDown,
  MessageCircle,
  Settings2,
} from 'lucide-react';

import { SettingsModal } from '@/components/settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import type { ChatMode } from './ChatInput';

interface AgentModeSelectorProps {
  value: ChatMode;
  onValueChange: (value: ChatMode) => void;
  disabled?: boolean;
  compact?: boolean;
}

export function AgentModeSelector({
  value,
  onValueChange,
  disabled = false,
  compact = false,
}: AgentModeSelectorProps) {
  const [runtimes, setRuntimes] = useState<AgentRuntimeSetting[]>(
    () => getSettings().agentRuntimes
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

  const enabledRuntimes = useMemo(
    () =>
      runtimes
        .filter((runtime) => runtime.enabled)
        .sort(
          (a, b) => Number(b.type === 'codeany') - Number(a.type === 'codeany')
        ),
    [runtimes]
  );
  const selectedRuntime = value.startsWith('agent:')
    ? enabledRuntimes.find((runtime) => runtime.id === value.slice(6))
    : undefined;
  const runtimeLabel = (runtime?: AgentRuntimeSetting) =>
    runtime?.type === 'codeany' ? 'WorkAny' : runtime?.name;
  const label =
    value === 'chat' ? 'Chat' : runtimeLabel(selectedRuntime) || 'WorkAny';

  const refresh = () => setRuntimes([...getSettings().agentRuntimes]);

  return (
    <>
      <DropdownMenu modal={false} onOpenChange={(open) => open && refresh()}>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label="Select conversation mode"
          className={cn(
            'bg-muted/60 text-foreground/80 hover:bg-muted focus-visible:ring-ring flex min-w-0 shrink-0 items-center gap-1.5 rounded-full font-medium transition-colors focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-xs'
          )}
        >
          {value === 'chat' ? (
            <MessageCircle className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <Bot className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="truncate">{label}</span>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={8}
          className="z-[60] w-56 rounded-xl p-1.5 shadow-xl"
        >
          <DropdownMenuItem
            onSelect={() => onValueChange('chat')}
            className="min-h-10 cursor-pointer rounded-lg px-3 py-2.5 text-sm"
          >
            <MessageCircle className="size-4" />
            <span className="flex-1">Chat</span>
            {value === 'chat' && <Check className="size-4" />}
          </DropdownMenuItem>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="min-h-10 cursor-pointer rounded-lg px-3 py-2.5 text-sm">
              <Bot className="size-4" />
              <span className="flex-1">Agent</span>
              {value.startsWith('agent:') && <Check className="mr-1 size-4" />}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="z-[61] min-w-56 rounded-xl p-1.5 shadow-xl">
              {enabledRuntimes.map((runtime) => {
                const runtimeValue = `agent:${runtime.id}` as ChatMode;
                return (
                  <DropdownMenuItem
                    key={runtime.id}
                    onSelect={() => onValueChange(runtimeValue)}
                    className="min-h-10 cursor-pointer rounded-lg px-3 py-2.5 text-sm"
                  >
                    <span className="flex-1 truncate">
                      {runtimeLabel(runtime)}
                    </span>
                    {value === runtimeValue && <Check className="size-4" />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator className="my-1.5" />
          <DropdownMenuItem
            onSelect={() => setSettingsOpen(true)}
            className="min-h-10 cursor-pointer rounded-lg px-3 py-2.5 text-sm"
          >
            <Settings2 className="size-4" />
            <span>Manage agents</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) refresh();
        }}
        initialCategory="agent"
      />
    </>
  );
}
