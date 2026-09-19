<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useCanBusStore } from '../store/canbus';
import type { FilterKey } from '../store/canbus';

const store = useCanBusStore();
const selectedFrameId = ref<string | null>(null);

const selectedFrame = computed(() => {
  if (!selectedFrameId.value) return null;
  return store.frames.find(f => f.id === selectedFrameId.value) || null;
});

// The detail panel must always describe a frame that belongs to the same set
// shown in the table: when filters change (or the frame ages out), drop the
// selection instead of lingering on a frame that is no longer visible.
watch(
  () => store.filteredFrames.map(f => f.id).join(','),
  () => {
    if (selectedFrameId.value && !store.filteredFrames.some(f => f.id === selectedFrameId.value)) {
      selectedFrameId.value = null;
    }
  }
);

// Known decoded signal names, offered as quick-pick suggestions
const signalNameOptions = computed(() => {
  const names = new Set<string>();
  for (const frame of store.frames) {
    for (const key of Object.keys(frame.decoded)) names.add(key);
  }
  return Array.from(names).sort();
});

const FILTER_LABELS: Record<FilterKey, string> = {
  id: '标识',
  direction: '收发方向',
  timeRange: '时间段',
  signal: '信号名'
};

// Human-readable description of an active filter, shown when it empties the list
function describeFilter(key: FilterKey): string {
  if (key === 'id') {
    return `标识含 “${store.filterId.trim()}”`;
  }
  if (key === 'direction') {
    return `方向为 ${store.filterDirection}`;
  }
  if (key === 'timeRange') {
    const parts: string[] = [];
    if (store.filterStartTime) parts.push(`从 ${store.filterStartTime.replace('T', ' ')}`);
    if (store.filterEndTime) parts.push(`到 ${store.filterEndTime.replace('T', ' ')}`);
    return `时间段（${parts.join(' ')}）`;
  }
  return `信号名含 “${store.filterSignal.trim()}”`;
}

const hasFrames = computed(() => store.frames.length > 0);
const activeFilterCount = computed(() => store.activeFilters.length);

function selectFrame(id: string) {
  selectedFrameId.value = selectedFrameId.value === id ? null : id;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + d.getMilliseconds().toString().padStart(3, '0');
}

function formatHexId(id: number): string {
  return '0x' + id.toString(16).toUpperCase().padStart(3, '0');
}

function getSignalPercent(name: string, value: number): number {
  const ranges: Record<string, { min: number; max: number }> = {
    EngineRPM: { min: 0, max: 16383 },
    VehicleSpeed: { min: 0, max: 255 },
    CoolantTemp: { min: -40, max: 215 },
    ThrottlePosition: { min: 0, max: 100 },
    EngineLoad: { min: 0, max: 100 }
  };
  const range = ranges[name];
  if (!range) return 50;
  return Math.max(0, Math.min(100, ((value - range.min) / (range.max - range.min)) * 100));
}

function getSignalColor(name: string): string {
  const colors: Record<string, string> = {
    EngineRPM: 'bg-blue-500',
    VehicleSpeed: 'bg-green-500',
    CoolantTemp: 'bg-red-500',
    ThrottlePosition: 'bg-yellow-500',
    EngineLoad: 'bg-purple-500'
  };
  return colors[name] || 'bg-cyan-500';
}

function getSignalUnit(name: string): string {
  const units: Record<string, string> = {
    EngineRPM: 'rpm',
    VehicleSpeed: 'km/h',
    CoolantTemp: '°C',
    ThrottlePosition: '%',
    EngineLoad: '%'
  };
  return units[name] || '';
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Bus Stats Header -->
    <div class="flex items-center gap-4 px-4 py-2 bg-gray-800 border-b border-gray-700 text-sm">
      <div class="flex items-center gap-1">
        <span class="text-gray-400">总帧数:</span>
        <span class="text-cyan-400 font-mono font-bold">{{ store.busStats.totalFrames }}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="text-gray-400">RX:</span>
        <span class="text-green-400 font-mono font-bold">{{ store.busStats.rxCount }}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="text-gray-400">TX:</span>
        <span class="text-blue-400 font-mono font-bold">{{ store.busStats.txCount }}</span>
      </div>
      <div class="flex items-center gap-1">
        <span class="text-gray-400">总线负载:</span>
        <span class="text-yellow-400 font-mono font-bold">{{ store.busLoadPercent }}%</span>
      </div>
    </div>

    <!-- Filters: 标识 / 收发方向 / 时间段 / 信号名 (AND-combined) -->
    <div class="px-4 py-2 bg-gray-800 border-b border-gray-700">
      <div class="flex flex-wrap items-center gap-2">
        <!-- 标识 -->
        <div class="flex items-center gap-1">
          <label class="text-xs text-gray-400 whitespace-nowrap">标识</label>
          <input
            v-model="store.filterId"
            type="text"
            placeholder="如 7DF"
            class="w-28 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          />
        </div>

        <!-- 收发方向 -->
        <div class="flex items-center gap-1">
          <label class="text-xs text-gray-400 whitespace-nowrap">方向</label>
          <select
            v-model="store.filterDirection"
            class="px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs focus:outline-none focus:border-cyan-500"
          >
            <option value="">全部</option>
            <option value="RX">RX</option>
            <option value="TX">TX</option>
          </select>
        </div>

        <!-- 时间段 -->
        <div class="flex items-center gap-1">
          <label class="text-xs text-gray-400 whitespace-nowrap">时间</label>
          <input
            v-model="store.filterStartTime"
            type="datetime-local"
            step="1"
            class="px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs focus:outline-none focus:border-cyan-500 [color-scheme:dark]"
          />
          <span class="text-gray-500 text-xs">~</span>
          <input
            v-model="store.filterEndTime"
            type="datetime-local"
            step="1"
            class="px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs focus:outline-none focus:border-cyan-500 [color-scheme:dark]"
          />
        </div>

        <!-- 信号名 -->
        <div class="flex items-center gap-1">
          <label class="text-xs text-gray-400 whitespace-nowrap">信号名</label>
          <input
            v-model="store.filterSignal"
            type="text"
            list="signal-name-suggestions"
            placeholder="如 EngineRPM"
            class="w-36 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          />
          <datalist id="signal-name-suggestions">
            <option v-for="name in signalNameOptions" :key="name" :value="name" />
          </datalist>
        </div>

        <button
          v-if="activeFilterCount > 0"
          @click="store.clearAllFilters()"
          class="ml-auto px-2 py-1 text-xs text-gray-300 bg-gray-700 hover:bg-gray-600 rounded border border-gray-600 transition-colors whitespace-nowrap"
        >
          清除全部筛选 ({{ activeFilterCount }})
        </button>
      </div>
    </div>

    <!-- Empty result: identify which filter(s) emptied the set -->
    <div
      v-if="hasFrames && store.filteredFrames.length === 0"
      class="px-4 py-2 bg-red-950/40 border-b border-red-900/60 text-xs"
    >
      <template v-if="store.emptyCulprits.length > 0">
        <span class="text-red-300">
          没有帧满足当前筛选 —
          {{ store.emptyCulprits.length === 1 ? '该筛选' : '以下筛选' }}单独已匹配 0 帧：
        </span>
        <span class="inline-flex flex-wrap gap-1.5 mt-1">
          <span
            v-for="key in store.emptyCulprits"
            :key="key"
            class="inline-flex items-center gap-1 bg-red-900/50 border border-red-800 rounded px-1.5 py-0.5"
          >
            <span class="text-red-200">{{ describeFilter(key) }}</span>
            <button
              @click="store.clearFilter(key)"
              :title="`去掉${FILTER_LABELS[key]}筛选`"
              class="text-red-300 hover:text-white font-bold leading-none"
            >
              ✕
            </button>
          </span>
        </span>
      </template>
      <template v-else>
        <span class="text-amber-300">
          没有帧同时满足全部 {{ activeFilterCount }} 个筛选（单个筛选均有匹配，但叠加后交集为空）。
        </span>
        <button
          @click="store.clearAllFilters()"
          class="ml-2 text-cyan-400 hover:text-cyan-300 underline"
        >
          清除全部筛选
        </button>
      </template>
    </div>

    <!-- Frame Table -->
    <div class="flex-1 overflow-auto">
      <table class="w-full text-sm font-mono">
        <thead class="sticky top-0 bg-gray-800 z-10">
          <tr class="text-gray-400 text-left">
            <th class="px-3 py-2 font-medium">时间戳</th>
            <th class="px-3 py-2 font-medium w-12">方向</th>
            <th class="px-3 py-2 font-medium w-20">CAN ID</th>
            <th class="px-3 py-2 font-medium w-10">DLC</th>
            <th class="px-3 py-2 font-medium">数据 (Hex)</th>
            <th class="px-3 py-2 font-medium">解码信号</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="frame in store.filteredFrames"
            :key="frame.id"
            @click="selectFrame(frame.id)"
            class="border-b border-gray-800 cursor-pointer transition-colors"
            :class="[
              selectedFrameId === frame.id
                ? 'bg-cyan-900/30 border-l-2 border-l-cyan-500'
                : 'hover:bg-gray-800/50'
            ]"
          >
            <td class="px-3 py-1.5 text-gray-300 whitespace-nowrap">{{ formatTimestamp(frame.timestamp) }}</td>
            <td class="px-3 py-1.5">
              <span
                class="px-1.5 py-0.5 rounded text-xs font-bold"
                :class="frame.direction === 'RX' ? 'bg-green-900/50 text-green-400' : 'bg-blue-900/50 text-blue-400'"
              >
                {{ frame.direction }}
              </span>
            </td>
            <td class="px-3 py-1.5 text-cyan-400 font-bold">{{ formatHexId(frame.arbitrationId) }}</td>
            <td class="px-3 py-1.5 text-gray-400">{{ frame.dlc }}</td>
            <td class="px-3 py-1.5 text-gray-300 whitespace-nowrap">{{ frame.data }}</td>
            <td class="px-3 py-1.5 text-gray-400">
              <span v-for="(val, key) in frame.decoded" :key="String(key)" class="inline-block mr-2">
                <span class="text-gray-500">{{ key }}:</span>
                <span class="text-yellow-300">{{ typeof val === 'number' ? val.toFixed(1) : val }}</span>
              </span>
            </td>
          </tr>
          <tr v-if="store.filteredFrames.length === 0">
            <td colspan="6" class="px-3 py-8 text-center text-gray-500">
              <template v-if="!hasFrames">
                暂无数据 — 点击"开始捕获"以模拟接收CAN帧
              </template>
              <template v-else>
                当前筛选条件下没有匹配的帧
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Detail Panel -->
    <div
      v-if="selectedFrame"
      class="border-t border-gray-700 bg-gray-850 p-4"
      style="background-color: #1a2234;"
    >
      <h3 class="text-sm font-semibold text-gray-300 mb-3">
        帧详情 — {{ formatHexId(selectedFrame.arbitrationId) }}
        <span class="text-gray-500 font-normal ml-2">{{ selectedFrame.id }}</span>
      </h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="(value, name) in selectedFrame.decoded"
          :key="String(name)"
          class="bg-gray-800 rounded-lg p-3"
        >
          <div class="flex justify-between items-center mb-1.5">
            <span class="text-sm text-gray-400">{{ name }}</span>
            <span class="text-sm font-bold text-gray-100">
              {{ typeof value === 'number' ? value.toFixed(1) : value }} {{ getSignalUnit(String(name)) }}
            </span>
          </div>
          <div class="w-full bg-gray-700 rounded-full h-2">
            <div
              class="h-2 rounded-full transition-all duration-300"
              :class="getSignalColor(String(name))"
              :style="{ width: getSignalPercent(String(name), value as number) + '%' }"
            ></div>
          </div>
        </div>
      </div>
      <div v-if="Object.keys(selectedFrame.decoded).length === 0" class="text-gray-500 text-sm">
        无DBC定义 — 无法解码此帧信号
      </div>
    </div>
  </div>
</template>
