import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { CanFrame, DbcMessage, BusStats } from '../types';
import { parseDbc, decodeCanFrame, DEFAULT_DBC_CONTENT } from '../utils/dbc-parser';

let frameIdCounter = 0;

export type FilterDirection = '' | 'RX' | 'TX';
export type FilterKey = 'id' | 'direction' | 'timeRange' | 'signal';

const FILTER_STORAGE_KEY = 'canbus-filters';

interface PersistedFilters {
  filterId: string;
  filterDirection: FilterDirection;
  filterStartTime: string;
  filterEndTime: string;
  filterSignal: string;
}

function loadPersistedFilters(): PersistedFilters {
  const defaults: PersistedFilters = {
    filterId: '',
    filterDirection: '',
    filterStartTime: '',
    filterEndTime: '',
    filterSignal: ''
  };
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PersistedFilters>;
    return {
      filterId: typeof parsed.filterId === 'string' ? parsed.filterId : '',
      filterDirection:
        parsed.filterDirection === 'RX' || parsed.filterDirection === 'TX'
          ? parsed.filterDirection
          : '',
      filterStartTime: typeof parsed.filterStartTime === 'string' ? parsed.filterStartTime : '',
      filterEndTime: typeof parsed.filterEndTime === 'string' ? parsed.filterEndTime : '',
      filterSignal: typeof parsed.filterSignal === 'string' ? parsed.filterSignal : ''
    };
  } catch {
    return defaults;
  }
}

/** datetime-local input value ("YYYY-MM-DDTHH:mm:ss") to epoch ms; NaN when empty/invalid */
function parseDateTimeInput(value: string): number {
  if (!value) return NaN;
  return new Date(value).getTime();
}

export const useCanBusStore = defineStore('canbus', () => {
  const frames = ref<CanFrame[]>([]);
  const signals = ref<Map<string, { name: string; data: { time: number; value: number }[] }>>(new Map());
  const dbcMessages = ref<Map<number, DbcMessage>>(new Map());

  const persisted = loadPersistedFilters();
  const filterId = ref(persisted.filterId);
  const filterDirection = ref<FilterDirection>(persisted.filterDirection);
  const filterStartTime = ref(persisted.filterStartTime);
  const filterEndTime = ref(persisted.filterEndTime);
  const filterSignal = ref(persisted.filterSignal);

  const isCapturing = ref(false);
  const pollInterval = ref<number | null>(null);

  // Persist filters so they survive a page refresh
  watch(
    [filterId, filterDirection, filterStartTime, filterEndTime, filterSignal],
    () => {
      const snapshot: PersistedFilters = {
        filterId: filterId.value,
        filterDirection: filterDirection.value,
        filterStartTime: filterStartTime.value,
        filterEndTime: filterEndTime.value,
        filterSignal: filterSignal.value
      };
      try {
        localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        // Ignore storage failures (private mode / quota) — filters still work in-session
      }
    },
    { deep: true }
  );

  function matchesIdFilter(frame: CanFrame): boolean {
    const keyword = filterId.value.trim().toLowerCase().replace(/^0x/, '');
    if (!keyword) return true;
    return frame.arbitrationId.toString(16).toLowerCase().includes(keyword);
  }

  function matchesDirectionFilter(frame: CanFrame): boolean {
    if (!filterDirection.value) return true;
    return frame.direction === filterDirection.value;
  }

  function matchesTimeRangeFilter(frame: CanFrame): boolean {
    const start = parseDateTimeInput(filterStartTime.value);
    const end = parseDateTimeInput(filterEndTime.value);
    // An inverted range matches nothing
    if (!Number.isNaN(start) && !Number.isNaN(end) && start > end) return false;
    if (!Number.isNaN(start) && frame.timestamp < start) return false;
    if (!Number.isNaN(end) && frame.timestamp > end) return false;
    return true;
  }

  function matchesSignalFilter(frame: CanFrame): boolean {
    const keyword = filterSignal.value.trim().toLowerCase();
    if (!keyword) return true;
    return Object.keys(frame.decoded).some(key => key.toLowerCase().includes(keyword));
  }

  const filterPredicates: { key: FilterKey; active: () => boolean; test: (f: CanFrame) => boolean }[] = [
    { key: 'id', active: () => filterId.value.trim() !== '', test: matchesIdFilter },
    { key: 'direction', active: () => filterDirection.value !== '', test: matchesDirectionFilter },
    {
      key: 'timeRange',
      active: () => filterStartTime.value !== '' || filterEndTime.value !== '',
      test: matchesTimeRangeFilter
    },
    {
      key: 'signal',
      active: () => filterSignal.value.trim() !== '',
      test: matchesSignalFilter
    }
  ];

  // Active filters AND together: a frame is kept only when every active filter matches
  const filteredFrames = computed(() => {
    const activePredicates = filterPredicates.filter(p => p.active());
    if (activePredicates.length === 0) return frames.value;
    return frames.value.filter(frame => activePredicates.every(p => p.test(frame)));
  });

  const activeFilters = computed<FilterKey[]>(() =>
    filterPredicates.filter(p => p.active()).map(p => p.key)
  );

  // Match count of each active filter applied alone (against the full set)
  const filterMatchCounts = computed<Record<FilterKey, number>>(() => {
    const counts: Record<FilterKey, number> = {
      id: -1,
      direction: -1,
      timeRange: -1,
      signal: -1
    };
    for (const p of filterPredicates) {
      if (p.active()) {
        counts[p.key] = frames.value.filter(frame => p.test(frame)).length;
      }
    }
    return counts;
  });

  // When the combined result is empty, every active filter matching nothing on its
  // own is responsible for emptying the result
  const emptyCulprits = computed<FilterKey[]>(() => {
    if (filteredFrames.value.length > 0 || frames.value.length === 0) return [];
    return filterPredicates
      .filter(p => p.active() && filterMatchCounts.value[p.key] === 0)
      .map(p => p.key);
  });

  function clearFilter(key: FilterKey) {
    if (key === 'id') filterId.value = '';
    else if (key === 'direction') filterDirection.value = '';
    else if (key === 'timeRange') {
      filterStartTime.value = '';
      filterEndTime.value = '';
    } else if (key === 'signal') filterSignal.value = '';
  }

  function clearAllFilters() {
    filterId.value = '';
    filterDirection.value = '';
    filterStartTime.value = '';
    filterEndTime.value = '';
    filterSignal.value = '';
  }

  const busStats = ref<BusStats>({
    totalFrames: 0,
    rxCount: 0,
    txCount: 0,
    errorCount: 0,
    busLoad: 0,
    lastUpdate: Date.now()
  });

  const busLoadPercent = computed(() => {
    return busStats.value.busLoad.toFixed(1);
  });

  function addFrame(frame: CanFrame) {
    frames.value.push(frame);
    if (frames.value.length > 500) {
      frames.value = frames.value.slice(-500);
    }

    busStats.value.totalFrames++;
    if (frame.direction === 'RX') busStats.value.rxCount++;
    else busStats.value.txCount++;
    busStats.value.lastUpdate = Date.now();

    // Update signal history
    const msgDef = dbcMessages.value.get(frame.arbitrationId);
    if (msgDef) {
      const decoded = decodeCanFrame(frame, msgDef);
      frame.decoded = decoded;
      for (const [name, value] of Object.entries(decoded)) {
        if (!signals.value.has(name)) {
          signals.value.set(name, { name, data: [] });
        }
        const sig = signals.value.get(name)!;
        sig.data.push({ time: frame.timestamp, value });
        if (sig.data.length > 100) {
          sig.data = sig.data.slice(-100);
        }
      }
    }

    // Simulate bus load (random 15-45%)
    busStats.value.busLoad = 15 + Math.random() * 30;
  }

  function clearFrames() {
    frames.value = [];
    signals.value = new Map();
    busStats.value = {
      totalFrames: 0,
      rxCount: 0,
      txCount: 0,
      errorCount: 0,
      busLoad: 0,
      lastUpdate: Date.now()
    };
    frameIdCounter = 0;
  }

  function loadMockDbc() {
    parseAndLoadDbc(DEFAULT_DBC_CONTENT);
  }

  function parseAndLoadDbc(text: string) {
    dbcMessages.value = parseDbc(text);
  }

  function generateMockFrame(): CanFrame {
    const messageIds = Array.from(dbcMessages.value.keys());
    const arbId = messageIds.length > 0
      ? messageIds[Math.floor(Math.random() * messageIds.length)]
      : 0x7DF;

    const msgDef = dbcMessages.value.get(arbId);

    // Generate realistic OBD-II values
    const rpm = Math.floor(800 + Math.random() * 5200);
    const speed = Math.floor(Math.random() * 120);
    const temp = Math.floor(70 + Math.random() * 35);
    const throttle = Math.floor(Math.random() * 100);
    const load = Math.floor(Math.random() * 100);

    // Encode values into bytes (simplified encoding for display)
    const rpmRaw = Math.round(rpm / 0.25);
    const rpmLow = rpmRaw & 0xFF;
    const rpmHigh = (rpmRaw >> 8) & 0xFF;
    const speedByte = speed & 0xFF;
    const tempByte = (temp + 40) & 0xFF;
    const throttleByte = Math.round(throttle / 0.392) & 0xFF;
    const loadByte = Math.round(load / 0.392) & 0xFF;

    const dataBytes = [rpmLow, rpmHigh, speedByte, tempByte, throttleByte, loadByte, 0x00, 0x00];
    const dataHex = dataBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

    const frame: CanFrame = {
      id: `frame-${++frameIdCounter}`,
      timestamp: Date.now(),
      arbitrationId: arbId,
      dlc: 8,
      data: dataHex,
      decoded: {},
      direction: Math.random() > 0.3 ? 'RX' : 'TX'
    };

    if (msgDef) {
      frame.decoded = {
        EngineRPM: rpm,
        VehicleSpeed: speed,
        CoolantTemp: temp,
        ThrottlePosition: throttle,
        EngineLoad: load
      };
    }

    return frame;
  }

  function startCapture() {
    if (isCapturing.value) return;
    isCapturing.value = true;

    // Load mock DBC if not loaded
    if (dbcMessages.value.size === 0) {
      loadMockDbc();
    }

    pollInterval.value = window.setInterval(() => {
      const frame = generateMockFrame();
      addFrame(frame);
    }, 200);
  }

  function stopCapture() {
    isCapturing.value = false;
    if (pollInterval.value !== null) {
      clearInterval(pollInterval.value);
      pollInterval.value = null;
    }
  }

  function decodeFrame(frame: CanFrame): Record<string, number> {
    const msgDef = dbcMessages.value.get(frame.arbitrationId);
    if (!msgDef) return {};
    return decodeCanFrame(frame, msgDef);
  }

  function exportFrames(): string {
    const header = 'Timestamp,Direction,CAN_ID,DLC,Data,Decoded\n';
    const rows = frames.value.map(f => {
      const decodedStr = Object.entries(f.decoded)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      return `${f.timestamp},${f.direction},0x${f.arbitrationId.toString(16).toUpperCase()},${f.dlc},"${f.data}","${decodedStr}"`;
    }).join('\n');
    return header + rows;
  }

  return {
    frames,
    signals,
    dbcMessages,
    filterId,
    filterDirection,
    filterStartTime,
    filterEndTime,
    filterSignal,
    busStats,
    isCapturing,
    filteredFrames,
    activeFilters,
    filterMatchCounts,
    emptyCulprits,
    busLoadPercent,
    clearFilter,
    clearAllFilters,
    addFrame,
    clearFrames,
    loadMockDbc,
    parseAndLoadDbc,
    startCapture,
    stopCapture,
    decodeFrame,
    exportFrames
  };
});
