<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useCanBusStore } from '../store/canbus';

const store = useCanBusStore();
const selectedFrameId = ref<string | null>(null);

// Detail panel must stay on the same set as the filtered list: once the
// selected frame is filtered out, drop the selection instead of keeping it
const selectedFrame = computed(() => {
  if (!selectedFrameId.value) return null;
  return store.filteredFrames.find(f => f.id === selectedFrameId.value) || null;
});

watch(() => store.filteredFrames, (list) => {
  if (selectedFrameId.value && !list.some(f => f.id === selectedFrameId.value)) {
    selectedFrameId.value = null;
  }
});

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

    <!-- Filter Bar -->
    <div class="px-4 py-2 bg-gray-800 border-b border-gray-700">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="flex items-center gap-1.5">
          <label class="text-xs text-gray-400 shrink-0">标识</label>
          <input
            v-model="store.filterId"
            type="text"
            placeholder="如 0x1F4"
            class="w-24 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs font-mono placeholder-gray-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-xs text-gray-400 shrink-0">方向</label>
          <select
            v-model="store.filterDirection"
            class="px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs focus:outline-none focus:border-cyan-500"
          >
            <option value="">全部</option>
            <option value="RX">RX</option>
            <option value="TX">TX</option>
          </select>
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-xs text-gray-400 shrink-0">时间段</label>
          <input
            v-model="store.filterTimeStart"
            type="datetime-local"
            step="1"
            style="color-scheme: dark;"
            class="px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs focus:outline-none focus:border-cyan-500"
          />
          <span class="text-gray-500 text-xs">至</span>
          <input
            v-model="store.filterTimeEnd"
            type="datetime-local"
            step="1"
            style="color-scheme: dark;"
            class="px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs focus:outline-none focus:border-cyan-500"
          />
        </div>
        <div class="flex items-center gap-1.5">
          <label class="text-xs text-gray-400 shrink-0">信号名</label>
          <input
            v-model="store.filterSignal"
            type="text"
            placeholder="如 EngineRPM"
            class="w-32 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-gray-100 text-xs placeholder-gray-600 focus:outline-none focus:border-cyan-500"
          />
        </div>
        <button
          v-if="store.hasActiveFilters"
          @click="store.clearFilters()"
          class="px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded border border-gray-600 transition-colors"
        >
          清除筛选
        </button>
      </div>

      <!-- Empty-result diagnosis: name the filter(s) that emptied the list -->
      <div
        v-if="store.frames.length > 0 && store.filteredFrames.length === 0 && store.hasActiveFilters"
        class="mt-2 px-3 py-2 bg-yellow-900/30 border border-yellow-700/50 rounded flex flex-wrap items-center gap-2 text-xs"
      >
        <span class="text-yellow-200">没有帧同时满足当前筛选条件。</span>
        <template v-if="store.emptyFilterCulprits.length > 0">
          <span class="text-yellow-400">导致筛空的条件:</span>
          <button
            v-for="culprit in store.emptyFilterCulprits"
            :key="culprit.key"
            @click="store.clearFilter(culprit.key)"
            class="px-2 py-0.5 bg-yellow-800/50 hover:bg-yellow-700/60 border border-yellow-600/60 rounded text-yellow-100 transition-colors"
            :title="`去掉${culprit.label}筛选`"
          >
            {{ culprit.label }} ✕
          </button>
        </template>
        <span v-else class="text-yellow-400">去掉任意单个条件都无法恢复，请调整条件或清除全部筛选。</span>
        <button
          @click="store.clearFilters()"
          class="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 border border-gray-600 rounded text-gray-200 transition-colors"
        >
          清除全部筛选
        </button>
      </div>
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
              <span v-if="store.frames.length === 0">暂无数据 — 点击"开始捕获"以模拟接收CAN帧</span>
              <span v-else>当前筛选条件下没有匹配的帧</span>
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
