import { useEffect, useState, useCallback } from 'react';
import {
  StyleSheet, Text, View, ScrollView,
  TouchableOpacity, RefreshControl, ActivityIndicator,
  Platform, StatusBar, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';
import { supabase } from '../../lib/supabase';

const TOP_PAD  = Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 24) + 8;
const MAX_ROWS = 500;
const SCREEN_W = Dimensions.get('window').width;

type Reading = {
  id:          string;
  created_at:  string;
  temperature: number;
  humidity:    number;
  air_quality: number;
  noise:       number;
};

type DayGroup = {
  date:     string;
  label:    string;
  readings: Reading[];
};

type Status = 'good' | 'warning' | 'poor';

const C: Record<Status, { fg: string; bg: string }> = {
  good:    { fg: '#16A34A', bg: '#F0FDF4' },
  warning: { fg: '#D97706', bg: '#FFFBEB' },
  poor:    { fg: '#DC2626', bg: '#FFF1F2' },
};

function tempStatus(v: number): Status {
  if (v >= 18 && v <= 28) return 'good';
  if (v >= 15 && v <= 32) return 'warning';
  return 'poor';
}
function humStatus(v: number): Status {
  if (v >= 20 && v <= 60) return 'good';
  if (v >= 10 && v <= 70) return 'warning';
  return 'poor';
}
function aqStatus(v: number): Status {
  if (v > 45)  return 'good';
  if (v >= 25) return 'warning';
  return 'poor';
}
function noiseStatus(v: number): Status {
  if (v < 500)  return 'good';
  if (v <= 1500) return 'warning';
  return 'poor';
}

function dayLabel(iso: string): string {
  const date  = new Date(iso);
  const today = new Date();
  const yday  = new Date(); yday.setDate(today.getDate() - 1);
  const same  = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(date, today)) return 'Today';
  if (same(date, yday))  return 'Yesterday';
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function groupByDay(readings: Reading[]): DayGroup[] {
  const map: Record<string, Reading[]> = {};
  for (const r of readings) {
    const day = r.created_at.slice(0, 10);
    if (!map[day]) map[day] = [];
    map[day].push(r);
  }
  return Object.entries(map)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, rs]) => ({ date, label: dayLabel(date), readings: rs }));
}

function avg(readings: Reading[], key: keyof Reading): number {
  const sum = readings.reduce((s, r) => s + (r[key] as number), 0);
  return sum / readings.length;
}

function sampleReadings(readings: Reading[], max: number): Reading[] {
  if (readings.length <= max) return readings;
  const step = readings.length / max;
  return Array.from({ length: max }, (_, i) => readings[Math.floor(i * step)]);
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

const CHART_W = SCREEN_W - 32 - 2;
const CHART_H = 56;

function Sparkline({
  readings,
  dataKey,
  color,
}: {
  readings: Reading[];
  dataKey:  'temperature' | 'humidity' | 'air_quality';
  color:    string;
}) {
  const sampled = sampleReadings([...readings].reverse(), 24);
  const vals    = sampled.map((r) => r[dataKey]);
  if (vals.length < 2) return null;

  return (
    <LineChart
      data={{ labels: [], datasets: [{ data: vals, color: () => color, strokeWidth: 2 }] }}
      width={CHART_W}
      height={CHART_H}
      chartConfig={{
        backgroundColor:        '#FFFFFF',
        backgroundGradientFrom: '#FFFFFF',
        backgroundGradientTo:   '#FFFFFF',
        decimalPlaces:          1,
        color:                  () => color,
        labelColor:             () => 'transparent',
        propsForDots:           { r: '0' },
        propsForBackgroundLines: { stroke: '#F2F2F7', strokeDasharray: '' },
      }}
      bezier
      withDots={false}
      withShadow={false}
      withInnerLines={false}
      withOuterLines={false}
      withVerticalLabels={false}
      withHorizontalLabels={false}
      style={{ borderRadius: 0, marginLeft: -16 }}
    />
  );
}

// ── Reading row ───────────────────────────────────────────────────────────────

function ReadingRow({ r }: { r: Reading }) {
  const tS = tempStatus(r.temperature);
  const hS = humStatus(r.humidity);
  const aS = aqStatus(r.air_quality);
  const nS = noiseStatus(r.noise);
  const noisePct = Math.min((r.noise / 4095) * 100, 100);

  return (
    <View style={styles.row}>
      <Text style={styles.rowTime}>{formatTime(r.created_at)}</Text>
      <View style={styles.chips}>
        <View style={[styles.chip, { backgroundColor: C[tS].bg }]}>
          <Text style={[styles.chipTxt, { color: C[tS].fg }]}>{r.temperature?.toFixed(1)}°</Text>
        </View>
        <View style={[styles.chip, { backgroundColor: C[hS].bg }]}>
          <Text style={[styles.chipTxt, { color: C[hS].fg }]}>{r.humidity?.toFixed(0)}%</Text>
        </View>
        <View style={[styles.chip, { backgroundColor: C[aS].bg }]}>
          <Text style={[styles.chipTxt, { color: C[aS].fg }]}>{r.air_quality?.toFixed(0)} kΩ</Text>
        </View>
        <View style={[styles.chip, { backgroundColor: C[nS].bg, paddingHorizontal: 8, paddingVertical: 5 }]}>
          <View style={styles.noiseBar}>
            <View style={[styles.noiseFill, { width: `${noisePct}%`, backgroundColor: C[nS].fg }]} />
          </View>
        </View>
      </View>
    </View>
  );
}

// ── Day group card ────────────────────────────────────────────────────────────

function DayGroupCard({
  group, expanded, onToggle,
}: {
  group:    DayGroup;
  expanded: boolean;
  onToggle: () => void;
}) {
  const avgTemp  = avg(group.readings, 'temperature');
  const avgHum   = avg(group.readings, 'humidity');
  const avgAq    = avg(group.readings, 'air_quality');
  const avgNoise = avg(group.readings, 'noise');

  const tS = tempStatus(avgTemp);
  const hS = humStatus(avgHum);
  const aS = aqStatus(avgAq);
  const nS = noiseStatus(avgNoise);

  return (
    <View style={styles.dayCard}>

      {/* Header row */}
      <TouchableOpacity style={styles.dayHeader} onPress={onToggle} activeOpacity={0.7}>
        <View style={{ flex: 1 }}>
          <Text style={styles.dayLabel}>{group.label}</Text>
          <View style={styles.avgRow}>
            <Text style={[styles.avgChip, { color: C[tS].fg, backgroundColor: C[tS].bg }]}>
              {avgTemp.toFixed(1)} °C
            </Text>
            <Text style={[styles.avgChip, { color: C[hS].fg, backgroundColor: C[hS].bg }]}>
              {avgHum.toFixed(0)} %
            </Text>
            <Text style={[styles.avgChip, { color: C[aS].fg, backgroundColor: C[aS].bg }]}>
              {avgAq.toFixed(0)} kΩ
            </Text>
            <Text style={[styles.avgChip, { color: C[nS].fg, backgroundColor: C[nS].bg }]}>
              {avgNoise < 500 ? 'Quiet' : avgNoise <= 1500 ? 'Moderate' : 'Loud'}
            </Text>
          </View>
        </View>
        <View style={styles.dayRight}>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{group.readings.length}</Text>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color="#C7C7CC" />
        </View>
      </TouchableOpacity>

      {/* Sparklines */}
      <View style={styles.chartsWrap}>
        <View style={styles.chartRow}>
          <Text style={[styles.chartLabel, { color: C[tS].fg }]}>Temp</Text>
          <View style={styles.chartArea}>
            <Sparkline readings={group.readings} dataKey="temperature" color={C[tS].fg} />
          </View>
        </View>
        <View style={styles.chartRow}>
          <Text style={[styles.chartLabel, { color: '#6366F1' }]}>Humidity</Text>
          <View style={styles.chartArea}>
            <Sparkline readings={group.readings} dataKey="humidity" color="#6366F1" />
          </View>
        </View>
        <View style={styles.chartRow}>
          <Text style={[styles.chartLabel, { color: C[aS].fg }]}>Air</Text>
          <View style={styles.chartArea}>
            <Sparkline readings={group.readings} dataKey="air_quality" color={C[aS].fg} />
          </View>
        </View>
      </View>

      {/* Expanded readings list */}
      {expanded && (
        <View style={styles.readingsList}>
          {group.readings.map((r) => (
            <ReadingRow key={r.id} r={r} />
          ))}
        </View>
      )}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function HistoryScreen() {
  const [groups, setGroups]         = useState<DayGroup[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded]     = useState<Set<string>>(new Set());

  const fetchHistory = useCallback(async () => {
    const since = new Date();
    since.setDate(since.getDate() - 7);
    const { data, error } = await supabase
      .from('sensor_readings')
      .select('id, created_at, temperature, humidity, air_quality, noise')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS);
    if (!error && data) {
      const grouped = groupByDay(data as Reading[]);
      setGroups(grouped);
      if (grouped.length > 0 && grouped[0].label === 'Today')
        setExpanded(new Set([grouped[0].date]));
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  const onRefresh = () => { setRefreshing(true); fetchHistory(); };

  const toggle = (date: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>History</Text>
        <Text style={styles.headerSub}>Last 7 days</Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#16A34A"
            colors={['#16A34A']}
          />
        }
      >
        {loading ? (
          <ActivityIndicator color="#16A34A" size="large" style={{ marginTop: 60 }} />
        ) : groups.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="time" size={40} color="#C7C7CC" />
            <Text style={styles.emptyText}>No readings in the last 7 days</Text>
          </View>
        ) : (
          <View style={styles.list}>
            {groups.map((g) => (
              <DayGroupCard
                key={g.date}
                group={g}
                expanded={expanded.has(g.date)}
                onToggle={() => toggle(g.date)}
              />
            ))}
          </View>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#F2F2F7' },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 24 },

  // Header
  header: {
    paddingTop: TOP_PAD,
    paddingHorizontal: 20,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#C6C6C8',
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#000000', letterSpacing: -0.3 },
  headerSub:   { fontSize: 13, color: '#8E8E93' },

  list: { gap: 12 },

  // Day card
  dayCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  dayHeader: {
    flexDirection: 'row', alignItems: 'center',
    padding: 16, paddingBottom: 10,
  },
  dayLabel: { fontSize: 15, fontWeight: '700', color: '#000000', marginBottom: 6 },
  avgRow:   { flexDirection: 'row', alignItems: 'center', gap: 5, flexWrap: 'wrap' },
  avgChip: {
    fontSize: 11, fontWeight: '600',
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: 6,
  },
  dayRight:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  countBadge: {
    backgroundColor: '#F2F2F7',
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 20,
  },
  countText: { fontSize: 11, fontWeight: '600', color: '#8E8E93' },

  // Sparklines
  chartsWrap: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#F2F2F7',
  },
  chartRow:   { flexDirection: 'row', alignItems: 'center', height: 56 },
  chartLabel: { fontSize: 10, fontWeight: '600', width: 52, letterSpacing: 0.2 },
  chartArea:  { flex: 1, overflow: 'hidden', height: 56 },

  // Reading rows
  readingsList: { paddingBottom: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F2F2F7',
    gap: 10,
  },
  rowTime: {
    fontSize: 11, fontWeight: '500', color: '#8E8E93',
    width: 42, fontVariant: ['tabular-nums'],
  },
  chips:     { flexDirection: 'row', flexWrap: 'wrap', gap: 5, alignItems: 'center', flex: 1 },
  chip:      { paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6 },
  chipTxt:   { fontSize: 11, fontWeight: '600' },
  noiseBar:  { width: 40, height: 3, backgroundColor: '#F2F2F7', borderRadius: 2, overflow: 'hidden' },
  noiseFill: { height: '100%', borderRadius: 2 },

  // Empty
  empty:     { alignItems: 'center', marginTop: 80, gap: 12 },
  emptyText: { color: '#8E8E93', fontSize: 15 },
});
