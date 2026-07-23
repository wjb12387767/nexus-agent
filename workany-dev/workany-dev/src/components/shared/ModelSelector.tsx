import { useMemo, useState } from 'react';
import {
  getSettings,
  saveSettingsWithSync,
  type Settings,
} from '@/shared/db/settings';
import { cn } from '@/shared/lib/utils';
import { Check, ChevronDown, Settings2 } from 'lucide-react';

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

interface ModelSelectorProps {
  disabled?: boolean;
  compact?: boolean;
}

export function ModelSelector({
  disabled = false,
  compact = false,
}: ModelSelectorProps) {
  const [settings, setSettings] = useState<Settings>(() => getSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const providers = useMemo(
    () =>
      settings.providers.filter(
        (provider) =>
          provider.enabled && provider.apiKey && provider.models.length > 0
      ),
    [settings.providers]
  );

  const selectedProvider = providers.find(
    (provider) => provider.id === settings.defaultProvider
  );
  const selectedModel =
    selectedProvider?.models.find((model) => model === settings.defaultModel) ||
    selectedProvider?.defaultModel ||
    selectedProvider?.models[0] ||
    '';
  const selectedModelLabel =
    selectedProvider?.modelEntries?.find((entry) => entry.id === selectedModel)
      ?.displayName || selectedModel;

  const refreshSettings = () => {
    setSettings({ ...getSettings() });
  };

  const selectModel = async (providerId: string, model: string) => {
    const nextSettings: Settings = {
      ...getSettings(),
      defaultProvider: providerId,
      defaultModel: model,
    };
    setSettings(nextSettings);
    await saveSettingsWithSync(nextSettings);
  };

  return (
    <>
      <DropdownMenu
        modal={false}
        onOpenChange={(open) => {
          if (open) refreshSettings();
        }}
      >
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label="Select model"
          className={cn(
            'bg-muted/70 text-foreground hover:bg-muted focus-visible:ring-ring flex min-w-0 shrink items-center gap-1.5 rounded-full font-medium transition-colors focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
            compact
              ? 'h-7 max-w-44 px-2.5 text-xs'
              : 'h-8 max-w-56 px-3 text-xs'
          )}
        >
          <span className="truncate">
            {selectedModelLabel || 'Select model'}
          </span>
          <ChevronDown className="size-3.5 shrink-0" />
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          side="top"
          sideOffset={8}
          className="z-[60] w-64 rounded-xl p-1.5 shadow-xl"
        >
          {providers.map((provider) => (
            <DropdownMenuSub key={provider.id}>
              <DropdownMenuSubTrigger className="min-h-10 cursor-pointer rounded-lg px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{provider.name}</span>
                {provider.id === settings.defaultProvider && (
                  <Check className="text-foreground size-4 shrink-0" />
                )}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="z-[61] min-w-56 rounded-xl p-1.5 shadow-xl">
                {provider.models.map((model) => {
                  const modelLabel =
                    provider.modelEntries?.find((entry) => entry.id === model)
                      ?.displayName || model;
                  const active =
                    provider.id === settings.defaultProvider &&
                    model === selectedModel;
                  return (
                    <DropdownMenuItem
                      key={model}
                      onSelect={() => void selectModel(provider.id, model)}
                      className="min-h-9 cursor-pointer rounded-lg px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {modelLabel}
                      </span>
                      {active && <Check className="size-4 shrink-0" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ))}

          {providers.length === 0 && (
            <div className="text-muted-foreground px-3 py-3 text-sm">
              No configured models
            </div>
          )}

          <DropdownMenuSeparator className="my-1.5" />
          <DropdownMenuItem
            onSelect={() => setSettingsOpen(true)}
            className="min-h-10 cursor-pointer rounded-lg px-3 py-2.5 text-sm"
          >
            <Settings2 className="size-4" />
            <span>Manage models</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) refreshSettings();
        }}
        initialCategory="model"
      />
    </>
  );
}
