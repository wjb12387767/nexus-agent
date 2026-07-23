/**
 * Setup Guard Component
 *
 * First-launch onboarding wizard. Guides the user through:
 *   Step 1 — Workspace selection (where task files & sessions are stored)
 *   Step 2 — AI model provider configuration (API key + model)
 *   Step 3 — Optional connectivity test
 *
 * Once a model provider is configured, the wizard is dismissed and the main
 * app renders. Workspace has a sensible default (~/.workany) so it is only
 * shown when the model is not yet configured.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { API_BASE_URL } from '@/config';
import {
  getSettings,
  isModelConfigured,
  saveSettings,
  type AIProvider,
} from '@/shared/db/settings';
import { pickDirectory } from '@/shared/lib/paths';
import { cn } from '@/shared/lib/utils';
import { useLanguage } from '@/shared/providers/language-provider';
import {
  ArrowRight,
  CheckCircle2,
  FlaskConical,
  FolderOpen,
  Loader2,
  Settings2,
  XCircle,
} from 'lucide-react';

import { SettingsModal } from '@/components/settings';

interface SetupGuardProps {
  children: ReactNode;
}

// Kept for API compatibility with existing imports
export function clearDependencyCache() {
  // No-op
}

type Step = 'workspace' | 'model';
type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'success' }
  | { kind: 'failed'; error: string }
  | { kind: 'skipped' };

const TOTAL_STEPS = 2;

export function SetupGuard({ children }: SetupGuardProps) {
  const { t } = useLanguage();
  const [step, setStep] = useState<Step>('workspace');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workDir, setWorkDir] = useState<string>(() => getSettings().workDir);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  // userReady gates the final pass-through so the user can run the optional
  // connectivity test (or skip it) before entering the app. Without this,
  // the wizard would dismiss the moment the model is configured and the
  // test button would never be reachable.
  const [userReady, setUserReady] = useState(false);

  const modelConfigured = isModelConfigured();

  // Reset test state when settings modal closes after a successful config,
  // so stale "failed" results don't linger after the user fixes the provider.
  useEffect(() => {
    if (!settingsOpen && isModelConfigured()) {
      setTestState({ kind: 'idle' });
    }
  }, [settingsOpen]);

  // Pass through only after the model is configured AND the user explicitly
  // chose to enter the app (via "Enter App" or "Skip Test").
  if (modelConfigured && userReady) {
    return <>{children}</>;
  }

  const handlePickWorkspace = async () => {
    const selected = await pickDirectory(
      t.setup?.changeWorkspace || 'Change Workspace'
    );
    if (selected) {
      setWorkDir(selected);
      const settings = getSettings();
      saveSettings({ ...settings, workDir: selected });
    }
  };

  const runConnectivityTest = async () => {
    const settings = getSettings();
    const provider = settings.providers.find(
      (p) => p.id === settings.defaultProvider
    ) as AIProvider | undefined;
    if (!provider || !provider.apiKey) {
      setTestState({
        kind: 'failed',
        error: t.setup?.modelNotConfigured || 'Model not configured',
      });
      return;
    }
    const model = provider.defaultModel || provider.models[0];
    if (!model) {
      setTestState({
        kind: 'failed',
        error: 'No model selected',
      });
      return;
    }

    setTestState({ kind: 'testing' });
    try {
      const response = await fetch(`${API_BASE_URL}/providers/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model,
          apiType: provider.apiType,
        }),
      });
      const result = (await response.json()) as {
        success?: boolean;
        error?: string;
      };
      if (response.ok && result.success) {
        setTestState({ kind: 'success' });
      } else {
        setTestState({
          kind: 'failed',
          error: result.error || `HTTP ${response.status}`,
        });
      }
    } catch (error) {
      setTestState({
        kind: 'failed',
        error: error instanceof Error ? error.message : 'Test failed',
      });
    }
  };

  const ts = (t.setup || {}) as NonNullable<typeof t.setup>;
  const isWorkspaceStep = step === 'workspace';

  return (
    <>
      <div className="bg-background flex min-h-svh items-center justify-center px-6 py-10">
        <div className="flex w-full max-w-lg flex-col gap-6">
          {/* Header */}
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="bg-primary/10 flex size-14 items-center justify-center rounded-2xl">
              <Settings2 className="text-primary size-7" />
            </div>
            <h1 className="text-foreground text-2xl font-semibold">
              {ts.wizardTitle || 'Welcome to WorkAny'}
            </h1>
            <p className="text-muted-foreground text-sm">
              {ts.wizardSubtitle || 'A few steps to start using the agent'}
            </p>
            <div className="text-muted-foreground/70 mt-1 text-xs font-medium tracking-wide">
              {ts.stepCount
                ? ts.stepCount(isWorkspaceStep ? 1 : 2, TOTAL_STEPS)
                : `Step ${isWorkspaceStep ? 1 : 2} / ${TOTAL_STEPS}`}
            </div>
          </div>

          {/* Step body */}
          {isWorkspaceStep ? (
            <WorkspaceStep
              workDir={workDir}
              ts={ts}
              onPick={handlePickWorkspace}
            />
          ) : (
            <ModelStep
              configured={modelConfigured}
              testState={testState}
              ts={ts}
              onConfigure={() => setSettingsOpen(true)}
              onTest={runConnectivityTest}
              onSkipTest={() => setTestState({ kind: 'skipped' })}
            />
          )}

          {/* Footer actions */}
          <div className="flex items-center justify-between gap-3 pt-2">
            {!isWorkspaceStep ? (
              <button
                onClick={() => setStep('workspace')}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {ts.back || 'Back'}
              </button>
            ) : (
              <span />
            )}

            {isWorkspaceStep ? (
              <button
                onClick={() => setStep('model')}
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-10 items-center gap-2 rounded-lg px-6 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {ts.next || 'Next'}
                <ArrowRight className="size-4" />
              </button>
            ) : modelConfigured ? (
              <button
                onClick={() => setUserReady(true)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-10 items-center gap-2 rounded-lg px-6 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {ts.enterApp || 'Enter App'}
                <ArrowRight className="size-4" />
              </button>
            ) : (
              <button
                onClick={() => setSettingsOpen(true)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-10 items-center gap-2 rounded-lg px-6 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <Settings2 className="size-4" />
                {ts.configureModel || 'Configure Model'}
              </button>
            )}
          </div>
        </div>
      </div>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={(open) => setSettingsOpen(open)}
        initialCategory="model"
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Step components
// ---------------------------------------------------------------------------

// Use the same type as the setup translation namespace. This avoids
// `Record<string, unknown>` which would make every property `unknown` and
// break JSX rendering (`unknown` is not assignable to `ReactNode`).
type SetupTranslations = NonNullable<
  ReturnType<typeof useLanguage>['t']['setup']
>;

function WorkspaceStep({
  workDir,
  ts,
  onPick,
}: {
  ts: SetupTranslations;
  workDir: string;
  onPick: () => void;
}) {
  return (
    <div className="border-border bg-card/50 flex flex-col gap-4 rounded-xl border p-5">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
          <FolderOpen className="text-primary size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground text-sm font-semibold">
            {ts.stepWorkspace || 'Workspace'}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {ts.stepWorkspaceDesc ||
              'Choose the working directory for the agent.'}
          </p>
        </div>
      </div>

      <div className="border-border bg-background/60 flex items-center gap-2 rounded-lg border px-3 py-2.5">
        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
            {ts.currentWorkspace || 'Current Workspace'}
          </div>
          <div className="text-foreground truncate font-mono text-xs">
            {workDir || '~/.workany'}
          </div>
        </div>
      </div>

      <button
        onClick={onPick}
        className="border-input bg-background hover:bg-accent focus-visible:ring-ring inline-flex h-9 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <FolderOpen className="size-3.5" />
        {ts.changeWorkspace || 'Change Workspace'}
      </button>

      <p className="text-muted-foreground/70 text-center text-[11px]">
        {ts.workspaceReady || 'Workspace Ready'} ·{' '}
        {ts.useDefault || 'Use Default'}
      </p>
    </div>
  );
}

function ModelStep({
  configured,
  testState,
  ts,
  onConfigure,
  onTest,
  onSkipTest,
}: {
  ts: SetupTranslations;
  configured: boolean;
  testState: TestState;
  onConfigure: () => void;
  onTest: () => void;
  onSkipTest: () => void;
}) {
  return (
    <div className="border-border bg-card/50 flex flex-col gap-4 rounded-xl border p-5">
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            configured
              ? 'bg-emerald-500/10'
              : 'bg-primary/10'
          )}
        >
          {configured ? (
            <CheckCircle2 className="size-5 text-emerald-500" />
          ) : (
            <Settings2 className="text-primary size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-foreground text-sm font-semibold">
            {ts.stepModel || 'Model Configuration'}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
            {ts.stepModelDesc || 'Configure an AI model provider.'}
          </p>
        </div>
      </div>

      {!configured ? (
        <div className="border-border bg-background/60 rounded-lg border border-dashed px-4 py-5 text-center">
          <p className="text-foreground text-sm font-medium">
            {ts.modelNotConfigured || 'Model Not Configured'}
          </p>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {ts.modelNotConfiguredDescription ||
              'Please configure an AI model provider to get started.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="border-border bg-background/60 flex items-center gap-2 rounded-lg border px-3 py-2.5">
            <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
            <span className="text-foreground text-sm font-medium">
              {ts.modelConfigured || 'Model Configured'}
            </span>
          </div>

          {/* Test result banner */}
          {testState.kind === 'success' && (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-3.5" />
              {ts.testSuccess || 'Connection successful'}
            </div>
          )}
          {testState.kind === 'failed' && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {ts.testFailed || 'Connection failed'}: {testState.error}
              </span>
            </div>
          )}
          {testState.kind === 'skipped' && (
            <div className="text-muted-foreground flex items-center gap-2 px-1 text-[11px]">
              {ts.testSkipped || 'Can test anytime in settings'}
            </div>
          )}

          {/* Test / skip buttons */}
          {testState.kind !== 'success' && (
            <div className="flex items-center gap-2">
              <button
                onClick={onTest}
                disabled={testState.kind === 'testing'}
                className="border-input bg-background hover:bg-accent focus-visible:ring-ring inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
              >
                {testState.kind === 'testing' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FlaskConical className="size-3.5" />
                )}
                {testState.kind === 'testing'
                  ? ts.testing || 'Testing...'
                  : ts.testConnection || 'Test Connection'}
              </button>
              <button
                onClick={onSkipTest}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex h-9 items-center justify-center rounded-md px-3 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                {ts.skipTest || 'Skip Test'}
              </button>
            </div>
          )}
        </div>
      )}

      {!configured && (
        <button
          onClick={onConfigure}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <Settings2 className="size-3.5" />
          {ts.configureModel || 'Configure Model'}
        </button>
      )}
    </div>
  );
}
