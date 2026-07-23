import { useMemo, useState } from 'react';
import { API_BASE_URL } from '@/config';
import {
  reloadSettingsAsync,
  type AIProvider,
  type ApiType,
} from '@/shared/db/settings';
import { cn } from '@/shared/lib/utils';
import { useLanguage } from '@/shared/providers/language-provider';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';

import type { SettingsTabProps } from '../types';

type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'deepseek'
  | 'minimax'
  | 'zai'
  | 'fal'
  | 'custom';

interface ProviderPreset {
  label: string;
  apiType: ApiType;
  baseUrl: string;
  testModel: string;
}

interface ProviderForm {
  name: string;
  providerType: ProviderType;
  apiType: ApiType;
  baseUrl: string;
  apiKey: string;
  models: ModelFormEntry[];
}

interface ModelFormEntry {
  key: string;
  id: string;
  displayName: string;
}

interface TestResponse {
  success?: boolean;
  error?: string;
}

interface ModelTestResult {
  key: string;
  modelId: string;
  success: boolean;
  error?: string;
}

type Notice = { kind: 'success' | 'error'; message: string } | null;

const PAGE_SIZE = 5;

function createModelEntry(id = '', displayName = id): ModelFormEntry {
  return {
    key: `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    id,
    displayName,
  };
}

const PROVIDER_PRESETS: Record<ProviderType, ProviderPreset> = {
  openai: {
    label: 'OpenAI',
    apiType: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    testModel: 'gpt-5.6-sol',
  },
  anthropic: {
    label: 'Anthropic',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    testModel: 'claude-sonnet-5',
  },
  openrouter: {
    label: 'OpenRouter',
    apiType: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api',
    testModel: 'xiaomi/mimo-v2.5',
  },
  deepseek: {
    label: 'DeepSeek',
    apiType: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    testModel: 'deepseek-v4-flash',
  },
  minimax: {
    label: 'MiniMax Token Plan',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.minimax.io/anthropic',
    testModel: 'MiniMax-M3',
  },
  zai: {
    label: 'GLM Coding Plan',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.z.ai/api/anthropic',
    testModel: 'GLM-5.2',
  },
  fal: {
    label: 'Fal',
    apiType: 'other',
    baseUrl: 'https://fal.run',
    testModel: 'fal-ai/flux/schnell',
  },
  custom: {
    label: 'Custom',
    apiType: 'openai-completions',
    baseUrl: '',
    testModel: '',
  },
};

const PROVIDER_TYPE_ORDER: ProviderType[] = [
  'openai',
  'anthropic',
  'openrouter',
  'deepseek',
  'minimax',
  'zai',
  'fal',
  'custom',
];

const API_TYPE_OPTIONS: Array<{ value: ApiType; label: string }> = [
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'other', label: 'Other' },
];

const createForm = (): ProviderForm => {
  const preset = PROVIDER_PRESETS.openai;
  return {
    name: preset.label,
    providerType: 'openai',
    apiType: preset.apiType,
    baseUrl: preset.baseUrl,
    apiKey: '',
    models: [createModelEntry(preset.testModel)],
  };
};

function inferProviderType(provider: AIProvider): ProviderType {
  if (provider.providerType && provider.providerType in PROVIDER_PRESETS) {
    return provider.providerType as ProviderType;
  }

  const value = `${provider.id} ${provider.name}`.toLowerCase();
  if (value.includes('openrouter')) return 'openrouter';
  if (value.includes('deepseek')) return 'deepseek';
  if (value.includes('minimax')) return 'minimax';
  if (value.includes('z.ai') || value.includes('zai') || value.includes('glm'))
    return 'zai';
  if (value.includes('anthropic') || value.includes('claude'))
    return 'anthropic';
  if (value.includes('openai')) return 'openai';
  if (value.includes('fal')) return 'fal';
  return 'custom';
}

function testEndpointFor(form: ProviderForm) {
  const base = (form.baseUrl || 'https://api.example.com').replace(/\/+$/, '');
  if (form.apiType === 'anthropic-messages') return `${base}/v1/messages`;
  if (form.apiType === 'other') {
    const modelId = form.models.find((model) => model.id.trim())?.id || '';
    return `${base}/${modelId.replace(/^\/+/, '') || '{model}'}`;
  }
  return `${base}/chat/completions`;
}

function ProviderDialog({
  open,
  editingProvider,
  form,
  saving,
  testing,
  testResults,
  testError,
  onOpenChange,
  onFormChange,
  onTest,
  onSave,
}: {
  open: boolean;
  editingProvider: AIProvider | null;
  form: ProviderForm;
  saving: boolean;
  testing: boolean;
  testResults: ModelTestResult[];
  testError: string | null;
  onOpenChange: (open: boolean) => void;
  onFormChange: (form: ProviderForm) => void;
  onTest: () => void;
  onSave: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[110] bg-black/35 backdrop-blur-[1px]" />
        <DialogPrimitive.Content className="bg-background border-border fixed top-1/2 left-1/2 z-[111] flex max-h-[90vh] w-[min(512px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border shadow-2xl focus:outline-none">
          <div className="px-6 pt-6 pb-2">
            <DialogPrimitive.Title className="text-foreground text-xl font-semibold">
              {editingProvider ? 'Edit Provider' : 'Create Provider'}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-muted-foreground mt-1 text-sm">
              {editingProvider
                ? 'Update the provider configuration.'
                : 'Add a new upstream API provider.'}
            </DialogPrimitive.Description>
            <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-5 right-5 rounded-sm focus-visible:ring-2 focus-visible:outline-none">
              <X className="size-5" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="grid grid-cols-2 gap-4">
              <label className="grid gap-2 text-sm font-medium">
                Provider Type
                <select
                  value={form.providerType}
                  onChange={(event) => {
                    const providerType = event.target.value as ProviderType;
                    const preset = PROVIDER_PRESETS[providerType];
                    onFormChange({
                      ...form,
                      providerType,
                      name:
                        providerType === 'custom' ? form.name : preset.label,
                      apiType: preset.apiType,
                      baseUrl: preset.baseUrl,
                      models: [createModelEntry(preset.testModel)],
                    });
                  }}
                  className="border-input bg-background focus:ring-ring h-10 w-full rounded-md border px-3 font-normal focus:ring-2 focus:outline-none"
                >
                  {PROVIDER_TYPE_ORDER.map((type) => (
                    <option key={type} value={type}>
                      {PROVIDER_PRESETS[type].label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-2 text-sm font-medium">
                API Type
                <select
                  value={form.apiType}
                  onChange={(event) =>
                    onFormChange({
                      ...form,
                      apiType: event.target.value as ApiType,
                    })
                  }
                  className="border-input bg-background focus:ring-ring h-10 w-full rounded-md border px-3 font-normal focus:ring-2 focus:outline-none"
                >
                  {API_TYPE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="grid gap-2 text-sm font-medium">
              Provider Name
              <input
                value={form.name}
                onChange={(event) =>
                  onFormChange({ ...form, name: event.target.value })
                }
                placeholder="My Provider"
                className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring h-10 rounded-md border px-3 font-normal focus:ring-2 focus:outline-none"
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              API Base URL
              <input
                value={form.baseUrl}
                onChange={(event) =>
                  onFormChange({ ...form, baseUrl: event.target.value })
                }
                placeholder="https://api.openai.com/v1"
                className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring h-10 rounded-md border px-3 font-normal focus:ring-2 focus:outline-none"
              />
            </label>

            <label className="grid gap-2 text-sm font-medium">
              API Key
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) =>
                  onFormChange({ ...form, apiKey: event.target.value })
                }
                placeholder={
                  editingProvider ? 'Leave empty to keep current' : 'sk-xxx...'
                }
                className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring h-10 rounded-md border px-3 font-normal focus:ring-2 focus:outline-none"
              />
            </label>

            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Models</span>
                <button
                  type="button"
                  onClick={() =>
                    onFormChange({
                      ...form,
                      models: [...form.models, createModelEntry()],
                    })
                  }
                  className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex items-center gap-1 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none"
                >
                  <Plus className="size-3.5" />
                  Add model
                </button>
              </div>

              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 px-0.5 text-xs font-medium">
                <span>Model ID</span>
                <span>Display Name</span>
                <span className="sr-only">Actions</span>
              </div>

              <div className="grid gap-2">
                {form.models.map((model, index) => {
                  const result = testResults.find(
                    (item) => item.key === model.key
                  );
                  return (
                    <div
                      key={model.key}
                      className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] items-center gap-2"
                    >
                      <div className="relative">
                        <input
                          aria-label={`Model ID ${index + 1}`}
                          value={model.id}
                          onChange={(event) =>
                            onFormChange({
                              ...form,
                              models: form.models.map((item) =>
                                item.key === model.key
                                  ? { ...item, id: event.target.value }
                                  : item
                              ),
                            })
                          }
                          placeholder="gpt-5.5"
                          className={cn(
                            'border-input bg-background placeholder:text-muted-foreground focus:ring-ring h-10 w-full rounded-md border px-3 pr-9 text-sm font-normal focus:ring-2 focus:outline-none',
                            result?.success && 'border-emerald-500/50',
                            result && !result.success && 'border-destructive/50'
                          )}
                        />
                        {result &&
                          (result.success ? (
                            <CheckCircle2 className="absolute top-1/2 right-3 size-4 -translate-y-1/2 text-emerald-500" />
                          ) : (
                            <XCircle className="text-destructive absolute top-1/2 right-3 size-4 -translate-y-1/2" />
                          ))}
                      </div>
                      <input
                        aria-label={`Display Name ${index + 1}`}
                        value={model.displayName}
                        onChange={(event) =>
                          onFormChange({
                            ...form,
                            models: form.models.map((item) =>
                              item.key === model.key
                                ? { ...item, displayName: event.target.value }
                                : item
                            ),
                          })
                        }
                        placeholder={model.id || 'GPT-5.5'}
                        className="border-input bg-background placeholder:text-muted-foreground focus:ring-ring h-10 min-w-0 rounded-md border px-3 text-sm font-normal focus:ring-2 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          onFormChange({
                            ...form,
                            models: form.models.filter(
                              (item) => item.key !== model.key
                            ),
                          })
                        }
                        aria-label={`Delete model ${index + 1}`}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:ring-destructive flex size-8 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {form.models.length === 0 && (
                <div className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-5 text-center text-xs">
                  Add at least one model.
                </div>
              )}

              <span className="text-muted-foreground text-xs leading-relaxed font-normal">
                Test sends one minimal request for every Model ID in parallel.
                Image generation tests produce a real image per model and may
                incur upstream cost.
              </span>
              <span className="text-muted-foreground text-xs font-normal">
                Test endpoint:{' '}
                <span className="font-mono break-all">
                  {testEndpointFor(form)}
                </span>
              </span>
            </div>
          </div>

          <div className="border-border flex min-h-16 items-center gap-2 border-t px-6 py-4">
            <div className="min-w-0 flex-1">
              {testError ? (
                <div className="text-destructive flex items-start gap-1.5">
                  <XCircle className="mt-0.5 size-4 shrink-0" />
                  <span className="max-h-14 overflow-y-auto font-mono text-xs leading-relaxed break-words">
                    {testError}
                  </span>
                </div>
              ) : testResults.length > 0 ? (
                testResults.every((result) => result.success) ? (
                  <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-4" />
                    {testResults.length} models passed
                  </span>
                ) : (
                  <div className="text-destructive flex items-start gap-1.5">
                    <XCircle className="mt-0.5 size-4 shrink-0" />
                    <span className="max-h-14 overflow-y-auto font-mono text-xs leading-relaxed break-words">
                      {testResults.filter((result) => result.success).length} of{' '}
                      {testResults.length} passed.{' '}
                      {testResults.find((result) => !result.success)?.error}
                    </span>
                  </div>
                )
              ) : null}
            </div>
            <button
              type="button"
              onClick={onTest}
              disabled={testing || saving}
              className="border-input bg-background hover:bg-accent focus-visible:ring-ring inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
            >
              {testing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FlaskConical className="size-4" />
              )}
              Test
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || testing}
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ModelSettings({
  settings,
  onSettingsChange,
}: SettingsTabProps) {
  const { t } = useLanguage();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<AIProvider | null>(
    null
  );
  const [form, setForm] = useState<ProviderForm>(createForm);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testResults, setTestResults] = useState<ModelTestResult[]>([]);
  const [testError, setTestError] = useState<string | null>(null);
  const [deleteProvider, setDeleteProvider] = useState<AIProvider | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [page, setPage] = useState(1);

  // grouter only lists provider records that have actually been configured.
  // WorkAny keeps unconfigured legacy presets in settings, so omit those rows.
  const providers = useMemo(
    () => settings.providers.filter((provider) => provider.apiKey),
    [settings.providers]
  );
  const totalPages = Math.max(1, Math.ceil(providers.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const visibleProviders = providers.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE
  );

  const showNotice = (nextNotice: Exclude<Notice, null>) => {
    setNotice(nextNotice);
    window.setTimeout(() => setNotice(null), 3000);
  };

  const openCreateDialog = () => {
    setEditingProvider(null);
    setForm(createForm());
    setTestResults([]);
    setTestError(null);
    setDialogOpen(true);
  };

  const openEditDialog = (provider: AIProvider) => {
    const providerType = inferProviderType(provider);
    setEditingProvider(provider);
    setForm({
      name: provider.name,
      providerType,
      apiType: provider.apiType || PROVIDER_PRESETS[providerType].apiType,
      baseUrl: provider.baseUrl,
      apiKey: '',
      models: provider.modelEntries?.length
        ? provider.modelEntries.map((model) =>
            createModelEntry(model.id, model.displayName)
          )
        : provider.models.length
          ? provider.models.map((model) => createModelEntry(model))
          : [createModelEntry(PROVIDER_PRESETS[providerType].testModel)],
    });
    setTestResults([]);
    setTestError(null);
    setDialogOpen(true);
  };

  const updateSettingsProviders = (nextProviders: AIProvider[]) => {
    let defaultProvider = settings.defaultProvider;
    let defaultModel = settings.defaultModel;
    const selected = nextProviders.find(
      (provider) => provider.id === defaultProvider && provider.enabled
    );

    if (!selected) {
      const fallback = nextProviders.find(
        (provider) => provider.enabled && provider.apiKey && provider.models[0]
      );
      defaultProvider = fallback?.id || '';
      defaultModel = fallback?.defaultModel || fallback?.models[0] || '';
    } else if (!selected.models.includes(defaultModel)) {
      defaultModel = selected.defaultModel || selected.models[0] || '';
    }

    onSettingsChange({
      ...settings,
      providers: nextProviders,
      defaultProvider,
      defaultModel,
    });
  };

  const handleSave = () => {
    if (!form.name.trim()) {
      showNotice({ kind: 'error', message: 'Name is required' });
      return;
    }
    if (!editingProvider && !form.apiKey.trim()) {
      showNotice({ kind: 'error', message: 'Key is required' });
      return;
    }

    const modelEntries = form.models
      .map((model) => ({
        id: model.id.trim(),
        displayName: model.displayName.trim() || model.id.trim(),
      }))
      .filter((model) => model.id);
    if (modelEntries.length === 0) {
      showNotice({
        kind: 'error',
        message: 'At least one Model ID is required',
      });
      return;
    }
    if (
      new Set(modelEntries.map((model) => model.id)).size !==
      modelEntries.length
    ) {
      showNotice({ kind: 'error', message: 'Model IDs must be unique' });
      return;
    }

    setSaving(true);
    const models = modelEntries.map((model) => model.id);

    if (editingProvider) {
      const nextProviders = settings.providers.map((provider) => {
        if (provider.id !== editingProvider.id) return provider;
        return {
          ...provider,
          name: form.name.trim(),
          providerType: form.providerType,
          apiType: form.apiType,
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey || provider.apiKey,
          models,
          modelEntries,
          defaultModel: models.includes(provider.defaultModel || '')
            ? provider.defaultModel
            : models[0],
        };
      });
      updateSettingsProviders(nextProviders);
      showNotice({ kind: 'success', message: 'Provider updated' });
    } else {
      const id = `${form.providerType}-${Date.now()}`;
      const provider: AIProvider = {
        id,
        name: form.name.trim(),
        providerType: form.providerType,
        apiType: form.apiType,
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        enabled: true,
        models,
        modelEntries,
        defaultModel: models[0],
        canDelete: true,
      };
      updateSettingsProviders([...settings.providers, provider]);
      showNotice({ kind: 'success', message: 'Provider created' });
    }

    setSaving(false);
    setDialogOpen(false);
  };

  const handleTest = async () => {
    const models = form.models.filter((model) => model.id.trim());
    const apiKey = form.apiKey || editingProvider?.apiKey || '';
    if (models.length === 0) {
      setTestError('Add at least one Model ID to test');
      return;
    }
    if (!apiKey) {
      setTestError('Key is required to test');
      return;
    }

    setTesting(true);
    setTestResults([]);
    setTestError(null);
    try {
      const results = await Promise.all(
        models.map(async (model): Promise<ModelTestResult> => {
          try {
            const response = await fetch(`${API_BASE_URL}/providers/detect`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                baseUrl: form.baseUrl,
                apiKey,
                model: model.id.trim(),
                apiType: form.apiType,
              }),
            });
            const result = (await response.json()) as TestResponse;
            return {
              key: model.key,
              modelId: model.id.trim(),
              success: response.ok && !!result.success,
              error:
                response.ok && result.success
                  ? undefined
                  : result.error || `HTTP ${response.status}`,
            };
          } catch (error) {
            return {
              key: model.key,
              modelId: model.id.trim(),
              success: false,
              error: error instanceof Error ? error.message : 'Test failed',
            };
          }
        })
      );
      setTestResults(results);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  };

  const handleToggleStatus = (provider: AIProvider) => {
    updateSettingsProviders(
      settings.providers.map((item) =>
        item.id === provider.id ? { ...item, enabled: !item.enabled } : item
      )
    );
    showNotice({
      kind: 'success',
      message: `Provider ${provider.enabled ? 'disabled' : 'enabled'}`,
    });
  };

  const handleDelete = () => {
    if (!deleteProvider) return;
    updateSettingsProviders(
      settings.providers.filter((provider) => provider.id !== deleteProvider.id)
    );
    setDeleteProvider(null);
    showNotice({ kind: 'success', message: 'Provider deleted' });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const persistedSettings = await reloadSettingsAsync();
      onSettingsChange(persistedSettings);
      setPage(1);
      showNotice({ kind: 'success', message: 'Providers refreshed' });
    } catch (error) {
      showNotice({
        kind: 'error',
        message:
          error instanceof Error ? error.message : 'Failed to load providers',
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="flex flex-col">
        <div className="mb-5 flex shrink-0 flex-col items-start justify-between gap-3 sm:flex-row">
          <div className="min-w-0">
            <h3 className="text-foreground text-xl font-semibold">Providers</h3>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Manage upstream API providers and their configurations.
            </p>
          </div>
          <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="border-input bg-background hover:bg-accent focus-visible:ring-ring inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
            >
              <RefreshCw
                className={cn('size-4', refreshing && 'animate-spin')}
              />
              Refresh
            </button>
            <button
              type="button"
              onClick={openCreateDialog}
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <Plus className="size-4" />
              {t.settings.addProvider}
            </button>
          </div>
        </div>

        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-max min-w-full border-collapse text-sm">
            <thead className="bg-background sticky top-0 z-10">
              <tr className="border-border text-muted-foreground border-b text-left font-medium">
                <th className="min-w-48 px-4 py-3 font-medium whitespace-nowrap">
                  Name
                </th>
                <th className="min-w-80 px-4 py-3 font-medium whitespace-nowrap">
                  Base URL
                </th>
                <th className="min-w-28 px-4 py-3 font-medium whitespace-nowrap">
                  Status
                </th>
                <th className="w-20 px-3 py-3 text-right font-medium whitespace-nowrap">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleProviders.map((provider) => (
                <tr
                  key={provider.id}
                  className="border-border hover:bg-muted/30 border-b last:border-b-0"
                >
                  <td className="px-4 py-4 font-medium whitespace-nowrap">
                    {provider.name}
                  </td>
                  <td className="text-muted-foreground px-4 py-4 font-mono text-xs whitespace-nowrap">
                    {provider.baseUrl || 'default'}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => handleToggleStatus(provider)}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
                        provider.enabled
                          ? 'border-emerald-500/25 bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
                          : 'border-border bg-muted text-muted-foreground hover:bg-muted/80'
                      )}
                    >
                      {provider.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </td>
                  <td className="px-3 py-4 whitespace-nowrap">
                    <div className="flex justify-end gap-0.5">
                      <button
                        type="button"
                        onClick={() => openEditDialog(provider)}
                        aria-label={`Edit ${provider.name}`}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring rounded-md p-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteProvider(provider)}
                        aria-label={`Delete ${provider.name}`}
                        className="text-destructive hover:bg-destructive/10 focus-visible:ring-destructive rounded-md p-1.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {providers.length === 0 && (
            <div className="text-muted-foreground flex min-h-32 items-center justify-center px-6 text-center text-sm">
              No providers yet. Click &quot;Add Provider&quot; to create one.
            </div>
          )}
        </div>

        {providers.length > PAGE_SIZE && (
          <div className="mt-4 flex shrink-0 items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {providers.length} providers
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="Previous page"
                disabled={currentPage === 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                className="border-input hover:bg-accent rounded-md border p-1.5 disabled:opacity-40"
              >
                <ChevronLeft className="size-4" />
              </button>
              <span>
                {currentPage} / {totalPages}
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={currentPage === totalPages}
                onClick={() =>
                  setPage((value) => Math.min(totalPages, value + 1))
                }
                className="border-input hover:bg-accent rounded-md border p-1.5 disabled:opacity-40"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <ProviderDialog
        open={dialogOpen}
        editingProvider={editingProvider}
        form={form}
        saving={saving}
        testing={testing}
        testResults={testResults}
        testError={testError}
        onOpenChange={setDialogOpen}
        onFormChange={(nextForm) => {
          setForm(nextForm);
          setTestResults([]);
          setTestError(null);
        }}
        onTest={handleTest}
        onSave={handleSave}
      />

      <DialogPrimitive.Root
        open={!!deleteProvider}
        onOpenChange={(open) => !open && setDeleteProvider(null)}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[110] bg-black/35 backdrop-blur-[1px]" />
          <DialogPrimitive.Content className="bg-background border-border fixed top-1/2 left-1/2 z-[111] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border p-6 shadow-2xl focus:outline-none">
            <DialogPrimitive.Title className="text-lg font-semibold">
              Delete Provider
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-muted-foreground mt-2 text-sm leading-relaxed">
              Are you sure you want to delete &quot;{deleteProvider?.name}
              &quot;? This action cannot be undone.
            </DialogPrimitive.Description>
            <div className="mt-6 flex justify-end gap-2">
              <DialogPrimitive.Close className="border-input hover:bg-accent h-9 rounded-md border px-4 text-sm font-medium">
                Cancel
              </DialogPrimitive.Close>
              <button
                type="button"
                onClick={handleDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 h-9 rounded-md px-4 text-sm font-medium"
              >
                Delete
              </button>
            </div>
            <DialogPrimitive.Close className="text-muted-foreground hover:text-foreground absolute top-4 right-4">
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {notice && (
        <div
          role="status"
          className={cn(
            'fixed right-6 bottom-6 z-[130] rounded-lg border px-4 py-3 text-sm shadow-lg',
            notice.kind === 'success'
              ? 'bg-background border-emerald-500/25 text-emerald-700 dark:text-emerald-400'
              : 'border-destructive/30 bg-background text-destructive'
          )}
        >
          {notice.message}
        </div>
      )}
    </>
  );
}
