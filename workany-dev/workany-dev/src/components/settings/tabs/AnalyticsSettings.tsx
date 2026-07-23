/**
 * Analytics Settings - Usage statistics and activity visualization
 */

import { useEffect, useMemo, useState } from 'react';
import {
  getAnalyticsHeatmap,
  getAnalyticsStats,
  getAnalyticsToolUsage,
  getAnalyticsTrend,
  type HeatmapDay,
  type AnalyticsStats,
  type ToolUsageItem,
  type TrendDay,
} from '@/shared/db/database';
import { cn } from '@/shared/lib/utils';
import { useLanguage } from '@/shared/providers/language-provider';
import {
  Activity,
  BarChart3,
  Clock,
  DollarSign,
  FileText,
  MessageSquare,
  TrendingUp,
} from 'lucide-react';

type LoadState = 'loading' | 'success' | 'error' | 'empty';

function getHeatmapLevel(count: number): number {
  if (count === 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  return 3;
}

const HEATMAP_COLORS = [
  'bg-muted',
  'bg-orange-200 dark:bg-orange-900/40',
  'bg-orange-400 dark:bg-orange-700/60',
  'bg-orange-600 dark:bg-orange-500',
];

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}/${day}`;
}

// Build a 7x13 grid (91 days) ending today
function buildHeatmapGrid(data: HeatmapDay[]): {
  date: string;
  count: number;
}[][] {
  const map = new Map<string, number>();
  for (const d of data) {
    map.set(d.date, d.count);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Find the Sunday of the week 90 days ago
  const start = new Date(today);
  start.setDate(start.getDate() - 90);
  // Align to Sunday
  start.setDate(start.getDate() - start.getDay());

  const weeks: { date: string; count: number }[][] = [];
  let cursor = new Date(start);
  while (cursor <= today) {
    const week: { date: string; count: number }[] = [];
    for (let day = 0; day < 7; day++) {
      const dateStr = cursor.toISOString().slice(0, 10);
      const inRange = cursor <= today;
      week.push({
        date: dateStr,
        count: inRange ? (map.get(dateStr) || 0) : 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function HeatmapTooltip({
  day,
  x,
  y,
}: {
  day: { date: string; count: number };
  x: number;
  y: number;
}) {
  return (
    <div
      className="bg-foreground text-background pointer-events-none absolute z-50 rounded-md px-2 py-1 text-xs whitespace-nowrap shadow-lg"
      style={{ left: x, top: y }}
    >
      {day.count} {day.count === 1 ? 'task' : 'tasks'} · {formatDateLabel(day.date)}
    </div>
  );
}

function ActivityHeatmap({ data }: { data: HeatmapDay[] }) {
  const { t } = useLanguage();
  const [hovered, setHovered] = useState<{
    day: { date: string; count: number };
    x: number;
    y: number;
  } | null>(null);

  const grid = useMemo(() => buildHeatmapGrid(data), [data]);
  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <div>
      <div className="flex items-end gap-2">
        {/* Day labels */}
        <div className="flex flex-col gap-[3px] pt-5">
          {dayLabels.map((label, i) => (
            <div
              key={i}
              className="text-muted-foreground h-[12px] text-[10px] leading-[12px]"
            >
              {i % 2 === 1 ? label : ''}
            </div>
          ))}
        </div>
        {/* Grid */}
        <div className="flex gap-[3px] overflow-x-auto">
          {grid.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((day, di) => {
                const level = getHeatmapLevel(day.count);
                const isFuture = new Date(day.date + 'T00:00:00') > new Date();
                return (
                  <div
                    key={di}
                    className={cn(
                      'size-[12px] rounded-sm transition-colors',
                      HEATMAP_COLORS[level],
                      isFuture && 'opacity-0',
                      !isFuture && 'hover:ring-1 hover:ring-foreground/40'
                    )}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const containerRect = e.currentTarget.closest('.relative')
                        ?.getBoundingClientRect();
                      setHovered({
                        day,
                        x: rect.left - (containerRect?.left || 0) + 16,
                        y: rect.top - (containerRect?.top || 0) - 28,
                      });
                    }}
                    onMouseLeave={() => setHovered(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center gap-1.5">
        <span className="text-muted-foreground text-xs">
          {t.settings.analyticsLess}
        </span>
        {HEATMAP_COLORS.map((color, i) => (
          <div key={i} className={cn('size-[12px] rounded-sm', color)} />
        ))}
        <span className="text-muted-foreground text-xs">
          {t.settings.analyticsMore}
        </span>
      </div>

      {hovered && (
        <HeatmapTooltip day={hovered.day} x={hovered.x} y={hovered.y} />
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <div className="text-muted-foreground">{icon}</div>
        <span className="text-muted-foreground text-xs">{label}</span>
      </div>
      <span className="text-foreground text-2xl font-semibold">{value}</span>
    </div>
  );
}

function ToolUsageChart({ data }: { data: ToolUsageItem[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);

  if (data.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {data.map((item) => (
        <div key={item.tool} className="flex items-center gap-3">
          <div className="text-muted-foreground w-32 shrink-0 truncate text-right text-xs">
            {item.tool}
          </div>
          <div className="bg-muted h-5 flex-1 overflow-hidden rounded">
            <div
              className="bg-primary h-full rounded transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
              style={{ width: `${(item.count / max) * 100}%` }}
            />
          </div>
          <span className="text-muted-foreground w-10 shrink-0 text-xs">
            {item.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function TrendLineChart({ data }: { data: TrendDay[] }) {
  const width = 320;
  const height = 120;
  const padding = { top: 10, right: 10, bottom: 24, left: 30 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Build full 7-day range (fill missing days with 0)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days: TrendDay[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const found = data.find((x) => x.date === dateStr);
    days.push({ date: dateStr, count: found?.count || 0 });
  }

  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const stepX = chartWidth / (days.length - 1);

  const points = days.map((d, i) => {
    const x = padding.left + i * stepX;
    const y = padding.top + chartHeight - (d.count / maxCount) * chartHeight;
    return { x, y, ...d };
  });

  const pathD = points
    .map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`))
    .join(' ');

  const areaD =
    `${pathD} L ${points[points.length - 1].x} ${padding.top + chartHeight} ` +
    `L ${points[0].x} ${padding.top + chartHeight} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ maxWidth: '100%' }}
    >
      <defs>
        <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor="hsl(var(--primary))"
            stopOpacity="0.3"
          />
          <stop
            offset="100%"
            stopColor="hsl(var(--primary))"
            stopOpacity="0"
          />
        </linearGradient>
      </defs>
      {/* Y-axis grid lines */}
      {[0, 0.5, 1].map((ratio) => {
        const y = padding.top + chartHeight - ratio * chartHeight;
        return (
          <line
            key={ratio}
            x1={padding.left}
            y1={y}
            x2={width - padding.right}
            y2={y}
            className="stroke-border"
            strokeWidth="1"
            strokeDasharray={ratio === 0 ? '0' : '2 4'}
          />
        );
      })}
      {/* Area */}
      <path d={areaD} fill="url(#trendGradient)" />
      {/* Line */}
      <path
        d={pathD}
        fill="none"
        className="stroke-primary"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Points */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          className="fill-primary"
        />
      ))}
      {/* X-axis labels */}
      {points.map((p, i) => (
        <text
          key={i}
          x={p.x}
          y={height - 6}
          textAnchor="middle"
          className="fill-muted-foreground"
          fontSize="10"
        >
          {formatDateLabel(p.date)}
        </text>
      ))}
      {/* Y-axis labels */}
      <text
        x={padding.left - 6}
        y={padding.top + 4}
        textAnchor="end"
        className="fill-muted-foreground"
        fontSize="10"
      >
        {maxCount}
      </text>
      <text
        x={padding.left - 6}
        y={padding.top + chartHeight}
        textAnchor="end"
        className="fill-muted-foreground"
        fontSize="10"
      >
        0
      </text>
    </svg>
  );
}

export function AnalyticsSettings() {
  const { t } = useLanguage();
  const [state, setState] = useState<LoadState>('loading');
  const [stats, setStats] = useState<AnalyticsStats | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapDay[]>([]);
  const [toolUsage, setToolUsage] = useState<ToolUsageItem[]>([]);
  const [trend, setTrend] = useState<TrendDay[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [s, h, tu, tr] = await Promise.all([
          getAnalyticsStats(),
          getAnalyticsHeatmap(),
          getAnalyticsToolUsage(),
          getAnalyticsTrend(),
        ]);
        if (cancelled) return;
        setStats(s);
        setHeatmap(h);
        setToolUsage(tu);
        setTrend(tr);
        const isEmpty =
          s.totalTasks === 0 &&
          s.totalMessages === 0 &&
          s.totalFiles === 0;
        setState(isEmpty ? 'empty' : 'success');
      } catch (error) {
        console.error('[Analytics] Failed to load:', error);
        if (!cancelled) setState('error');
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground text-sm">
          {t.settings.analyticsLoading}
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-red-500 text-sm">{t.settings.analyticsFailed}</div>
      </div>
    );
  }

  const formatDuration = (ms: number): string => {
    if (!ms) return '0' + t.settings.analyticsSeconds;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + t.settings.analyticsSeconds;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    return hours + 'h ' + (minutes % 60) + 'm';
  };

  return (
    <div className="space-y-6">
      {/* Description */}
      <p className="text-muted-foreground text-sm">
        {t.settings.analyticsDescription}
      </p>

      {state === 'empty' && (
        <div className="border-border flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <BarChart3 className="text-muted-foreground/50 size-10" />
          <p className="text-muted-foreground mt-3 text-sm">
            {t.settings.analyticsNoData}
          </p>
        </div>
      )}

      {state === 'success' && stats && (
        <>
          {/* Stats Cards */}
          <div>
            <h3 className="text-foreground mb-3 text-sm font-medium">
              {t.settings.analyticsStatsCards}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard
                icon={<Activity className="size-4" />}
                label={t.settings.analyticsTotalTasks}
                value={String(stats.totalTasks)}
              />
              <StatCard
                icon={<MessageSquare className="size-4" />}
                label={t.settings.analyticsTotalMessages}
                value={String(stats.totalMessages)}
              />
              <StatCard
                icon={<FileText className="size-4" />}
                label={t.settings.analyticsTotalFiles}
                value={String(stats.totalFiles)}
              />
              <StatCard
                icon={<DollarSign className="size-4" />}
                label={t.settings.analyticsTotalCost}
                value={`$${stats.totalCost.toFixed(4)}`}
              />
              <StatCard
                icon={<Clock className="size-4" />}
                label={t.settings.analyticsTotalDuration}
                value={formatDuration(stats.totalDuration)}
              />
            </div>
          </div>

          {/* Activity Heatmap */}
          <div className="border-border rounded-lg border p-4">
            <div className="mb-3">
              <h3 className="text-foreground text-sm font-medium">
                {t.settings.analyticsActivityHeatmap}
              </h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t.settings.analyticsActivityHeatmapDescription}
              </p>
            </div>
            <div className="relative overflow-x-auto">
              <ActivityHeatmap data={heatmap} />
            </div>
          </div>

          {/* Tool Usage & Trend */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Tool Usage */}
            <div className="border-border rounded-lg border p-4">
              <div className="mb-3">
                <h3 className="text-foreground text-sm font-medium">
                  {t.settings.analyticsToolUsage}
                </h3>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t.settings.analyticsToolUsageDescription}
                </p>
              </div>
              {toolUsage.length > 0 ? (
                <ToolUsageChart data={toolUsage} />
              ) : (
                <p className="text-muted-foreground py-4 text-center text-xs">
                  {t.settings.analyticsNoData}
                </p>
              )}
            </div>

            {/* 7-Day Trend */}
            <div className="border-border rounded-lg border p-4">
              <div className="mb-3">
                <h3 className="text-foreground flex items-center gap-1.5 text-sm font-medium">
                  <TrendingUp className="size-4" />
                  {t.settings.analyticsRecentTrend}
                </h3>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t.settings.analyticsRecentTrendDescription}
                </p>
              </div>
              <TrendLineChart data={trend} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
