import { defineStore } from 'pinia';
import { ref, computed, watch } from 'vue';
import type { CanFrame, DbcMessage, BusStats } from '../types';
import { parseDbc, decodeCanFrame, DEFAULT_DBC_CONTENT } from '../utils/dbc-parser';

let frameIdCounter = 0;

export type FrameFilterKey = 'id' | 'direction' | 'time' | 'signal';

export type FrameDirectionFilter = '' | 'RX' | 'TX';

const FILTER_STORAGE_KEY = 'canbus-frame-filters';

interface PersistedFilters {
  filterId?: string;
  filterDirection?: FrameDirectionFilter;
  filterTimeStart?: string;
  filterTimeEnd?: string;
  filterSignal?: string;
}

function loadPersistedFilters(): PersistedFilters {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseTimeBoundary(value: string): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

export const useCanBusStore = defineStore('canbus', () => {
  const frames = ref<CanFrame[]>([]);
  const signals = ref<Map<string, { name: string; data: { time: number; value: number }[] }>>(new Map());
  const dbcMessages = ref<Map<number, DbcMessage>>(new Map());

  // Filters are restored from localStorage so they survive a page refresh
  const persisted = loadPersistedFilters();
  const filterId = ref(typeof persisted.filterId === 'string' ? persisted.filterId : '');
  const filterDirection = ref<FrameDirectionFilter>(
    persisted.filterDirection === 'RX' || persisted.filterDirection === 'TX' ? persisted.filterDirection : ''
  );
  const filterTimeStart = ref(typeof persisted.filterTimeStart === 'string' ? persisted.filterTimeStart : '');
  const filterTimeEnd = ref(typeof persisted.filterTimeEnd === 'string' ? persisted.filterTimeEnd : '');
  const filterSignal = ref(typeof persisted.filterSignal === 'string' ? persisted.filterSignal : '');

  const isCapturing = ref(false);
  const pollInterval = ref<number | null>(null);

  const busStats = ref<BusStats>({
    totalFrames: 0,
    rxCount: 0,
    txCount: 0,
    errorCount: 0,
    busLoad: 0,
    lastUpdate: Date.now()
  });

  watch(
    [filterId, filterDirection, filterTimeStart, filterTimeEnd, filterSignal],
    () => {
      try {
        localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
          filterId: filterId.value,
          filterDirection: filterDirection.value,
          filterTimeStart: filterTimeStart.value,
          filterTimeEnd: filterTimeEnd.value,
          filterSignal: filterSignal.value
        }));
      } catch {
        // storage unavailable (private mode etc.) — filters just won't persist
      }
    }
  );

  // All active filters are AND-combined; skipKey excludes one filter (used for empty-result diagnosis)
  function applyFilters(skipKey?: FrameFilterKey): CanFrame[] {
    let result = frames.value;

    if (skipKey !== 'id' && filterId.value.trim()) {
      const idFilter = filterId.value.trim().toLowerCase().replace(/^0x/i, '');
      result = result.filter(f =>
        f.arbitrationId.toString(16).toLowerCase().includes(idFilter)
      );
    }

    if (skipKey !== 'direction' && filterDirection.value) {
      const dir = filterDirection.value;
      result = result.filter(f => f.direction === dir);
    }

    if (skipKey !== 'time') {
      const startTs = parseTimeBoundary(filterTimeStart.value);
      const endTs = parseTimeBoundary(filterTimeEnd.value);
      if (startTs !== null) result = result.filter(f => f.timestamp >= startTs);
      if (endTs !== null) result = result.filter(f => f.timestamp <= endTs);
    }

    if (skipKey !== 'signal' && filterSignal.value.trim()) {
      const sigFilter = filterSignal.value.trim().toLowerCase();
      result = result.filter(f =>
        Object.keys(f.decoded).some(key => key.toLowerCase().includes(sigFilter))
      );
    }

    return result;
  }

  const filteredFrames = computed(() => applyFilters());

  const hasActiveFilters = computed(() =>
    filterId.value.trim() !== '' ||
    filterDirection.value !== '' ||
    filterTimeStart.value !== '' ||
    filterTimeEnd.value !== '' ||
    filterSignal.value.trim() !== ''
  );

  // When nothing survives the filters, report each filter whose removal alone
  // would bring results back, so the UI can offer a one-click way to drop it
  const emptyFilterCulprits = computed<Array<{ key: FrameFilterKey; label: string }>>(() => {
    if (frames.value.length === 0 || filteredFrames.value.length > 0) return [];
    const defs: Array<{ key: FrameFilterKey; label: string; active: boolean }> = [
      { key: 'id', label: '标识', active: filterId.value.trim() !== '' },
      { key: 'direction', label: '方向', active: filterDirection.value !== '' },
      { key: 'time', label: '时间段', active: filterTimeStart.value !== '' || filterTimeEnd.value !== '' },
      { key: 'signal', label: '信号名', active: filterSignal.value.trim() !== '' }
    ];
    return defs
      .filter(d => d.active && applyFilters(d.key).length > 0)
      .map(({ key, label }) => ({ key, label }));
  });

  function clearFilter(key: FrameFilterKey) {
    switch (key) {
      case 'id':
        filterId.value = '';
        break;
      case 'direction':
        filterDirection.value = '';
        break;
      case 'time':
        filterTimeStart.value = '';
        filterTimeEnd.value = '';
        break;
      case 'signal':
        filterSignal.value = '';
        break;
    }
  }

  function clearFilters() {
    filterId.value = '';
    filterDirection.value = '';
    filterTimeStart.value = '';
    filterTimeEnd.value = '';
    filterSignal.value = '';
  }

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
    filterTimeStart,
    filterTimeEnd,
    filterSignal,
    busStats,
    isCapturing,
    filteredFrames,
    hasActiveFilters,
    emptyFilterCulprits,
    busLoadPercent,
    addFrame,
    clearFrames,
    clearFilter,
    clearFilters,
    loadMockDbc,
    parseAndLoadDbc,
    startCapture,
    stopCapture,
    decodeFrame,
    exportFrames
  };
});
