import { useEffect, useState, useCallback } from 'react';
import { StyleSheet, Text, View, ScrollView, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '../../lib/supabase';

type Reading = {
  id: string;
  created_at: string;
  temperature: number;
  humidity: number;
  air_quality: number;
  noise: number;
};

type GroupedReadings = {
  date: string;
  label: string;
  readings: Reading[];
};

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(date, today)) return 'Today';
  if (isSameDay(date, yesterday)) return 'Yesterday';

  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getAirQualityLabel(val: number): { text: string; color: string } {
  if (val > 50) return { text: 'good', color: '#00ff99' };
  if (val > 20) return { text: 'mod', color: '#ffcc00' };
  return { text: 'poor', color: '#ff4444' };
}

function groupByDay(readings: Reading[]): GroupedReadings[] {
  const map: Record<string, Reading[]> = {};

  for (const r of readings) {
    const day = r.created_at.slice(0, 10); // YYYY-MM-DD
    if (!map[day]) map[day] = [];
    map[day].push(r);
  }

  return Object.entries(map)
    .sort(([a], [b]) => b.localeCompare(a)) // newest day first
    .map(([date, dayReadings]) => ({
      date,
      label: formatDate(date),
      readings: dayReadings,
    }));
}

function ReadingRow({ reading }: { reading: Reading }) {
  const aq = getAirQualityLabel(reading.air_quality);
  const noisePercent = Math.min((reading.noise / 4095) * 100, 100);

  return (
    <View style={styles.readingRow}>
      <Text style={styles.readingTime}>{formatTime(reading.created_at)}</Text>
      <View style={styles.readingValues}>
        <Text style={styles.readingVal}>
          <Text style={styles.readingValMuted}>🌡 </Text>
          {reading.temperature?.toFixed(1)}°
        </Text>
        <Text style={styles.readingVal}>
          <Text style={styles.readingValMuted}>💧 </Text>
          {reading.humidity?.toFixed(1)}%
        </Text>
        <Text style={[styles.readingVal, { color: aq.color }]}>
          🌿 {reading.air_quality} <Text style={{ fontSize: 10 }}>{aq.text}</Text>
        </Text>
        <View style={styles.noiseCell}>
          <Text style={styles.readingValMuted}>🔊</Text>
          <View style={styles.noiseMini}>
            <View style={[styles.noiseMiniBar, {
              width: `${noisePercent}%`,
              backgroundColor: noisePercent > 70 ? '#ff4444' : noisePercent > 40 ? '#ffcc00' : '#555'
            }]} />
          </View>
        </View>
      </View>
    </View>
  );
}

function DayGroup({ group, expanded, onToggle }: {
  group: GroupedReadings;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={styles.dayGroup}>
      <TouchableOpacity style={styles.dayHeader} onPress={onToggle} activeOpacity={0.7}>
        <View style={styles.dayHeaderLeft}>
          <Text style={styles.dayLabel}>{group.label}</Text>
          <Text style={styles.dayDate}>{group.date}</Text>
        </View>
        <View style={styles.dayHeaderRight}>
          <Text style={styles.dayCount}>{group.readings.length} readings</Text>
          <Ionicons
            name={expanded ? 'chevron-up' : 'chevron-down'}
            size={16}
            color="#555"
          />
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.readingsList}>
          {group.readings.map((r) => (
            <ReadingRow key={r.id} reading={r} />
          ))}
        </View>
      )}
    </View>
  );
}

export default function HistoryScreen() {
  const [groups, setGroups] = useState<GroupedReadings[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  const fetchHistory = useCallback(async () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { data: rows } = await supabase
      .from('sensor_readings')
      .select('*')
      .gte('created_at', sevenDaysAgo.toISOString())
      .order('created_at', { ascending: false });

    if (rows) {
      const grouped = groupByDay(rows);
      setGroups(grouped);
      // Auto-expand today if present
      if (grouped.length > 0 && grouped[0].label === 'Today') {
        setExpandedDays(new Set([grouped[0].date]));
      }
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchHistory();
  };

  const toggleDay = (date: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#00ff99"
          colors={['#00ff99']}
        />
      }
    >
      <Text style={styles.title}>history</Text>
      <Text style={styles.subtitle}>last 7 days of readings</Text>

      {loading ? (
        <ActivityIndicator color="#00ff99" style={{ marginTop: 60 }} />
      ) : groups.length === 0 ? (
        <Text style={styles.empty}>no readings in the last 7 days</Text>
      ) : (
        <View style={styles.list}>
          {groups.map((group) => (
            <DayGroup
              key={group.date}
              group={group}
              expanded={expandedDays.has(group.date)}
              onToggle={() => toggleDay(group.date)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:       { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', paddingTop: 80, paddingBottom: 40 },
  title:           { fontSize: 36, color: '#fff', fontWeight: 'bold', letterSpacing: 2 },
  subtitle:        { fontSize: 14, color: '#555', marginBottom: 32, letterSpacing: 1 },
  list:            { width: '90%', gap: 10 },
  empty:           { color: '#555', fontSize: 16, marginTop: 60 },

  // Day group
  dayGroup:        { backgroundColor: '#1a1a1a', borderRadius: 16, overflow: 'hidden' },
  dayHeader:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 18 },
  dayHeaderLeft:   { gap: 2 },
  dayHeaderRight:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dayLabel:        { fontSize: 17, color: '#fff', fontWeight: '600' },
  dayDate:         { fontSize: 11, color: '#444' },
  dayCount:        { fontSize: 12, color: '#00ff99' },

  // Reading rows
  readingsList:    { borderTopWidth: 1, borderTopColor: '#252525' },
  readingRow:      { paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#252525', gap: 6 },
  readingTime:     { fontSize: 12, color: '#00ff99', fontVariant: ['tabular-nums'] },
  readingValues:   { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  readingVal:      { fontSize: 13, color: '#ccc' },
  readingValMuted: { color: '#555' },
  noiseCell:       { flexDirection: 'row', alignItems: 'center', gap: 6 },
  noiseMini:       { width: 50, height: 3, backgroundColor: '#333', borderRadius: 2 },
  noiseMiniBar:    { height: 3, borderRadius: 2 },
});
