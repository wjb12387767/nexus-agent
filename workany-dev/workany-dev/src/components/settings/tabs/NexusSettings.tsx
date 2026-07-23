/**
 * Nexus Agent Settings
 *
 * Deep adaptation of nexus-agent settings into the WorkAny UI.
 * Organized into 7 collapsible sections covering core agent, sandbox,
 * checkpoint, context & memory, self-improvement, WSL bridge, and advanced.
 */

import { useState, type ReactNode } from 'react';

import {
  defaultNexusSettings,
  type NexusAgentSettings,
} from '@/shared/db/settings';
import { cn } from '@/shared/lib/utils';
import { useLanguage } from '@/shared/providers/language-provider';
import { ChevronDown } from 'lucide-react';

import type { SettingsTabProps } from '../types';
import { Switch } from '../components/Switch';

// ----------------------------------------------------------------------------
// Model presets
// ----------------------------------------------------------------------------

const MODEL_PRESETS = [
  'claude-sonnet-4-20250514',
  'claude-opus-4-20250514',
  'gpt-4o',
  'deepseek-chat',
  'qwen3-coder-plus',
];

const CUSTOM_MODEL_VALUE = '__custom__';

// ----------------------------------------------------------------------------
// Collapsible section
// ----------------------------------------------------------------------------

interface CollapsibleSectionProps {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

function CollapsibleSection({
  title,
  description,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-border bg-card rounded-xl border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent/40 flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-colors"
      >
        <div className="min-w-0">
          <h3 className="text-foreground text-sm font-medium">{title}</h3>
          {description && (
            <p className="text-muted-foreground mt-0.5 text-xs">{description}</p>
          )}
        </div>
        <ChevronDown
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>
      {open && <div className="border-border space-y-4 border-t p-4">{children}</div>}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Row helpers
// ----------------------------------------------------------------------------

interface SettingRowProps {
  title: string;
  description?: string;
  children: ReactNode;
}

function SettingRow({ title, description, children }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-foreground text-sm font-medium">{title}</div>
        {description && (
          <div className="text-muted-foreground mt-0.5 text-xs">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

const selectClass =
  'border-input bg-background text-foreground focus:ring-ring h-9 cursor-pointer rounded-lg border px-3 text-sm focus:border-transparent focus:ring-2 focus:outline-none';

const inputClass =
  'border-input bg-background text-foreground focus:ring-ring h-9 rounded-lg border px-3 text-sm focus:border-transparent focus:ring-2 focus:outline-none';

// ----------------------------------------------------------------------------
// Main component
// ----------------------------------------------------------------------------

export function NexusSettings({ settings, onSettingsChange }: SettingsTabProps) {
  const { t } = useLanguage();
  const nexus: NexusAgentSettings = settings.nexusSettings ?? defaultNexusSettings;

  const update = (patch: Partial<NexusAgentSettings>) => {
    onSettingsChange({
      ...settings,
      nexusSettings: { ...nexus, ...patch },
    });
  };

  const isCustomModel =
    nexus.model !== CUSTOM_MODEL_VALUE &&
    !MODEL_PRESETS.includes(nexus.model);

  const modelSelectValue = isCustomModel ? CUSTOM_MODEL_VALUE : nexus.model;

  const tn = t.settings.nexusSettings;

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">{tn.description}</p>

      {/* Section 1: Agent Core */}
      <CollapsibleSection
        title={tn.sectionCore}
        description={tn.sectionCoreDescription}
      >
        <SettingRow
          title={tn.model}
          description={tn.modelDescription}
        >
          <select
            value={modelSelectValue}
            onChange={(e) => {
              if (e.target.value === CUSTOM_MODEL_VALUE) {
                update({ model: '' });
              } else {
                update({ model: e.target.value });
              }
            }}
            className={cn(selectClass, 'w-56')}
          >
            {MODEL_PRESETS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={CUSTOM_MODEL_VALUE}>
              {tn.modelCustom}
            </option>
          </select>
        </SettingRow>

        {isCustomModel && (
          <SettingRow title={tn.modelCustom} description={tn.modelCustomDescription}>
            <input
              value={nexus.model}
              onChange={(e) => update({ model: e.target.value })}
              placeholder="claude-sonnet-4-20250514"
              spellCheck={false}
              className={cn(inputClass, 'w-56 font-mono')}
            />
          </SettingRow>
        )}

        <SettingRow
          title={tn.maxTurns}
          description={tn.maxTurnsDescription}
        >
          <input
            type="number"
            min={1}
            max={1000}
            value={nexus.maxTurns}
            onChange={(e) =>
              update({ maxTurns: Number(e.target.value) || 1 })
            }
            className={cn(inputClass, 'w-24 text-center')}
          />
        </SettingRow>

        <SettingRow
          title={tn.permissionMode}
          description={tn.permissionModeDescription}
        >
          <select
            value={nexus.permissionMode}
            onChange={(e) =>
              update({
                permissionMode: e.target.value as NexusAgentSettings['permissionMode'],
              })
            }
            className={cn(selectClass, 'w-40')}
          >
            <option value="bypass">{tn.permissionBypass}</option>
            <option value="ask">{tn.permissionAsk}</option>
            <option value="always-allow">{tn.permissionAlwaysAllow}</option>
          </select>
        </SettingRow>

        <SettingRow
          title={tn.thinkingLevel}
          description={tn.thinkingLevelDescription}
        >
          <select
            value={nexus.thinkingLevel}
            onChange={(e) =>
              update({
                thinkingLevel: e.target.value as NexusAgentSettings['thinkingLevel'],
              })
            }
            className={cn(selectClass, 'w-40')}
          >
            <option value="adaptive">{tn.thinkingAdaptive}</option>
            <option value="low">{tn.thinkingLow}</option>
            <option value="medium">{tn.thinkingMedium}</option>
            <option value="high">{tn.thinkingHigh}</option>
            <option value="disabled">{tn.thinkingDisabled}</option>
          </select>
        </SettingRow>
      </CollapsibleSection>

      {/* Section 2: Sandbox & Security */}
      <CollapsibleSection
        title={tn.sectionSandbox}
        description={tn.sectionSandboxDescription}
      >
        <SettingRow
          title={tn.sandboxEnabled}
          description={tn.sandboxEnabledDescription}
        >
          <Switch
            checked={nexus.sandboxEnabled}
            onChange={(v) => update({ sandboxEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.sandboxFallback}
          description={tn.sandboxFallbackDescription}
        >
          <select
            value={nexus.sandboxFallbackBehavior}
            onChange={(e) =>
              update({
                sandboxFallbackBehavior: e.target
                  .value as NexusAgentSettings['sandboxFallbackBehavior'],
              })
            }
            className={cn(selectClass, 'w-32')}
          >
            <option value="error">{tn.fallbackError}</option>
            <option value="warn">{tn.fallbackWarn}</option>
            <option value="continue">{tn.fallbackContinue}</option>
          </select>
        </SettingRow>

        <SettingRow
          title={tn.fileSafety}
          description={tn.fileSafetyDescription}
        >
          <Switch
            checked={nexus.fileSafetyEnabled}
            onChange={(v) => update({ fileSafetyEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.doomLoop}
          description={tn.doomLoopDescription}
        >
          <Switch
            checked={nexus.doomLoopDetection}
            onChange={(v) => update({ doomLoopDetection: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.bashAst}
          description={tn.bashAstDescription}
        >
          <Switch
            checked={nexus.bashAstSafety}
            onChange={(v) => update({ bashAstSafety: v })}
          />
        </SettingRow>
      </CollapsibleSection>

      {/* Section 3: Checkpoint & Recovery */}
      <CollapsibleSection
        title={tn.sectionCheckpoint}
        description={tn.sectionCheckpointDescription}
      >
        <SettingRow
          title={tn.checkpointEnabled}
          description={tn.checkpointEnabledDescription}
        >
          <Switch
            checked={nexus.checkpointEnabled}
            onChange={(v) => update({ checkpointEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.checkpointInterval}
          description={tn.checkpointIntervalDescription}
        >
          <input
            type="number"
            min={0}
            value={nexus.autoCheckpointInterval}
            onChange={(e) =>
              update({
                autoCheckpointInterval: Number(e.target.value) || 0,
              })
            }
            className={cn(inputClass, 'w-24 text-center')}
          />
        </SettingRow>

        <SettingRow
          title={tn.maxCheckpoints}
          description={tn.maxCheckpointsDescription}
        >
          <input
            type="number"
            min={1}
            value={nexus.maxCheckpoints}
            onChange={(e) =>
              update({ maxCheckpoints: Number(e.target.value) || 1 })
            }
            className={cn(inputClass, 'w-24 text-center')}
          />
        </SettingRow>
      </CollapsibleSection>

      {/* Section 4: Context & Memory */}
      <CollapsibleSection
        title={tn.sectionContext}
        description={tn.sectionContextDescription}
      >
        <SettingRow
          title={tn.compactionEnabled}
          description={tn.compactionEnabledDescription}
        >
          <Switch
            checked={nexus.compactionEnabled}
            onChange={(v) => update({ compactionEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.compactionThreshold}
          description={tn.compactionThresholdDescription}
        >
          <div className="flex w-56 items-center gap-3">
            <input
              type="range"
              min={50}
              max={90}
              step={1}
              value={nexus.compactionThreshold}
              onChange={(e) =>
                update({ compactionThreshold: Number(e.target.value) })
              }
              className="accent-primary h-1 flex-1 cursor-pointer"
            />
            <span className="text-foreground w-10 text-right text-sm tabular-nums">
              {nexus.compactionThreshold}%
            </span>
          </div>
        </SettingRow>

        <SettingRow
          title={tn.autoLearn}
          description={tn.autoLearnDescription}
        >
          <Switch
            checked={nexus.autoLearnEnabled}
            onChange={(v) => update({ autoLearnEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.backgroundReview}
          description={tn.backgroundReviewDescription}
        >
          <Switch
            checked={nexus.backgroundReviewEnabled}
            onChange={(v) => update({ backgroundReviewEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.curator}
          description={tn.curatorDescription}
        >
          <Switch
            checked={nexus.curatorEnabled}
            onChange={(v) => update({ curatorEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.mnemopi}
          description={tn.mnemopiDescription}
        >
          <Switch
            checked={nexus.mnemopiEnabled}
            onChange={(v) => update({ mnemopiEnabled: v })}
          />
        </SettingRow>
      </CollapsibleSection>

      {/* Section 5: Self-Improvement */}
      <CollapsibleSection
        title={tn.sectionSelfImprovement}
        description={tn.sectionSelfImprovementDescription}
      >
        <SettingRow
          title={tn.learningGraph}
          description={tn.learningGraphDescription}
        >
          <Switch
            checked={nexus.learningGraphEnabled}
            onChange={(v) => update({ learningGraphEnabled: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.autoLearnCapture}
          description={tn.autoLearnCaptureDescription}
        >
          <Switch
            checked={nexus.autoLearnCapture}
            onChange={(v) => update({ autoLearnCapture: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.reflectOnErrors}
          description={tn.reflectOnErrorsDescription}
        >
          <Switch
            checked={nexus.reflectOnErrors}
            onChange={(v) => update({ reflectOnErrors: v })}
          />
        </SettingRow>
      </CollapsibleSection>

      {/* Section 6: WSL Bridge */}
      <CollapsibleSection
        title={tn.sectionWsl}
        description={tn.sectionWslDescription}
      >
        <SettingRow
          title={tn.wslAutoDetect}
          description={tn.wslAutoDetectDescription}
        >
          <Switch
            checked={nexus.wslAutoDetect}
            onChange={(v) => update({ wslAutoDetect: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.wslPreferredDistro}
          description={tn.wslPreferredDistroDescription}
        >
          <input
            value={nexus.wslPreferredDistro}
            onChange={(e) => update({ wslPreferredDistro: e.target.value })}
            placeholder="Ubuntu"
            spellCheck={false}
            className={cn(inputClass, 'w-40')}
          />
        </SettingRow>

        <SettingRow
          title={tn.wslSuppressHint}
          description={tn.wslSuppressHintDescription}
        >
          <Switch
            checked={nexus.wslSuppressHint}
            onChange={(v) => update({ wslSuppressHint: v })}
          />
        </SettingRow>
      </CollapsibleSection>

      {/* Section 7: Advanced */}
      <CollapsibleSection
        title={tn.sectionAdvanced}
        description={tn.sectionAdvancedDescription}
        defaultOpen={false}
      >
        <SettingRow
          title={tn.promptCaching}
          description={tn.promptCachingDescription}
        >
          <Switch
            checked={nexus.promptCaching}
            onChange={(v) => update({ promptCaching: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.contextBreakdown}
          description={tn.contextBreakdownDescription}
        >
          <Switch
            checked={nexus.contextBreakdown}
            onChange={(v) => update({ contextBreakdown: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.thinkScrubber}
          description={tn.thinkScrubberDescription}
        >
          <Switch
            checked={nexus.thinkScrubber}
            onChange={(v) => update({ thinkScrubber: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.telemetry}
          description={tn.telemetryDescription}
        >
          <Switch
            checked={nexus.telemetry}
            onChange={(v) => update({ telemetry: v })}
          />
        </SettingRow>

        <SettingRow
          title={tn.debugMode}
          description={tn.debugModeDescription}
        >
          <Switch
            checked={nexus.debugMode}
            onChange={(v) => update({ debugMode: v })}
          />
        </SettingRow>
      </CollapsibleSection>
    </div>
  );
}
