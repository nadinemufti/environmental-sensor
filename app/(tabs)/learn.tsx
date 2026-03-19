import { useEffect, useState, useCallback, useRef } from 'react';
import {
  StyleSheet, Text, View, ScrollView,
  RefreshControl, ActivityIndicator,
  Platform, StatusBar, Dimensions, Animated,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { supabase } from '../../lib/supabase';

const TOP_PAD    = Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 24) + 8;
const SCREEN_W   = Dimensions.get('window').width;
const CHART_W    = SCREEN_W - 32;
const CHART_H    = 200;
const MAX_POINTS = 48;

type HourlyBucket = {
  label:       string;
  temperature: number;
  humidity:    number;
  air_quality: number;
};

type RawReading = {
  created_at:  string;
  temperature: number;
  humidity:    number;
  air_quality: number;
};

type SensorStats = { min: number; max: number; avg: number; now: number };

function buildHourlyBuckets(rows: RawReading[]): HourlyBucket[] {
  const map: Record<string, RawReading[]> = {};
  for (const r of rows) {
    const key = r.created_at.slice(0, 13);
    if (!map[key]) map[key] = [];
    map[key].push(r);
  }
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-MAX_POINTS)
    .map(([key, group]) => ({
      label:       key.slice(11) + ':00',
      temperature: avg(group.map((r) => r.temperature)),
      humidity:    avg(group.map((r) => r.humidity)),
      air_quality: avg(group.map((r) => r.air_quality)),
    }));
}

function calcStats(rows: RawReading[], key: keyof Omit<RawReading, 'created_at'>): SensorStats {
  const vals = rows.map((r) => r[key] as number).filter(Number.isFinite);
  if (!vals.length) return { min: 0, max: 0, avg: 0, now: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  return { min: Math.min(...vals), max: Math.max(...vals), avg: sum / vals.length, now: vals[0] };
}

function sparseLabels(labels: string[], maxTicks = 5): string[] {
  if (labels.length <= maxTicks) return labels;
  const step = Math.ceil(labels.length / maxTicks);
  return labels.map((l, i) => (i % step === 0 ? l : ''));
}

// ── Animated chart card ───────────────────────────────────────────────────────

type ChartCardProps = {
  title:     string;
  unit:      string;
  color:     string;
  data:      number[];
  labels:    string[];
  stats:     SensorStats;
  idealLow:  number;
  idealHigh: number;
  delay:     number;
};

function ChartCard({ title, unit, color, data, labels, stats, idealLow, idealHigh, delay }: ChartCardProps) {
  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(18)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim,  { toValue: 1, duration: 420, delay, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 420, delay, useNativeDriver: true }),
    ]).start();
  }, []);

  const safeData   = data.length >= 2 ? data : data.length === 1 ? [data[0], data[0]] : [0, 0];
  const safeLabels = sparseLabels(labels.length >= 2 ? labels : ['', '']);

  const nowStatus =
    stats.now >= idealLow && stats.now <= idealHigh ? '#16A34A' :
    Math.abs(stats.now - ((idealLow + idealHigh) / 2)) < (idealHigh - idealLow) ? '#D97706' : '#DC2626';

  return (
    <Animated.View style={[styles.chartCard, { opacity: fadeAnim, transform: [{ translateY: slideAnim }], borderTopColor: color }]}>
      {/* Card header */}
      <View style={styles.chartCardHeader}>
        <View style={[styles.chartAccent, { backgroundColor: color }]} />
        <View style={{ flex: 1 }}>
          <Text style={styles.chartTitle}>{title}</Text>
          <Text style={styles.chartIdeal}>Ideal {idealLow} – {idealHigh} {unit}</Text>
        </View>
        <View style={[styles.nowBadge, { backgroundColor: nowStatus + '18' }]}>
          <Text style={[styles.nowValue, { color: nowStatus }]}>
            {stats.now.toFixed(1)} {unit}
          </Text>
        </View>
      </View>

      {/* Chart */}
      <View style={styles.chartWrap}>
        <LineChart
          data={{
            labels: safeLabels,
            datasets: [{ data: safeData, color: () => color, strokeWidth: 4 }],
          }}
          width={CHART_W + 32}
          height={CHART_H}
          chartConfig={{
            backgroundColor:              color + '08',
            backgroundGradientFrom:       color + '08',
            backgroundGradientTo:         '#FFFFFF',
            decimalPlaces:                1,
            color:                        (opacity = 1) => color,
            labelColor:                   () => '#8E8E93',
            propsForDots:                 { r: '0' },
            propsForBackgroundLines:      { stroke: '#F2F2F7', strokeWidth: 1, strokeDasharray: '3,3' },
            propsForLabels:               { fontSize: 11, fontWeight: '600' },
            fillShadowGradient:           color,
            fillShadowGradientOpacity:    0.45,
            fillShadowGradientFrom:       color,
            fillShadowGradientTo:         '#FFFFFF',
            fillShadowGradientFromOpacity: 0.48,
            fillShadowGradientToOpacity:  0.0,
          }}
          bezier
          withDots={false}
          withShadow={true}
          withInnerLines={true}
          withOuterLines={false}
          withVerticalLabels={true}
          withHorizontalLabels={true}
          style={{ borderRadius: 0, marginLeft: -16, marginRight: -16 }}
        />
      </View>

      {/* Stats row */}
      <View style={styles.statsRow}>
        <StatChip label="MIN"  value={`${stats.min.toFixed(1)}`} unit={unit} />
        <StatChip label="AVG"  value={`${stats.avg.toFixed(1)}`} unit={unit} color={color} />
        <StatChip label="MAX"  value={`${stats.max.toFixed(1)}`} unit={unit} />
        <StatChip label="NOW"  value={`${stats.now.toFixed(1)}`} unit={unit} color={nowStatus} />
      </View>
    </Animated.View>
  );
}

function StatChip({ label, value, unit, color }: { label: string; value: string; unit: string; color?: string }) {
  return (
    <View style={styles.statChip}>
      <Text style={styles.statChipLabel}>{label}</Text>
      <Text style={[styles.statChipValue, color ? { color } : {}]}>{value}</Text>
      <Text style={styles.statChipUnit}>{unit}</Text>
    </View>
  );
}

// ── Report Card ───────────────────────────────────────────────────────────────

type Grade = 'A+' | 'A' | 'B' | 'C' | 'F';

type GradeResult = {
  grade:  Grade;
  color:  string;
  tip:    string;
};

const GRADE_COLORS: Record<Grade, string> = {
  'A+': '#16A34A',
  'A':  '#22C55E',
  'B':  '#EAB308',
  'C':  '#F97316',
  'F':  '#DC2626',
};

function gradeTemperature(stats: SensorStats): GradeResult {
  const { avg, min, max } = stats;
  if (avg >= 20 && avg <= 24 && min >= 18 && max <= 26)
    return { grade: 'A+', color: GRADE_COLORS['A+'], tip: 'Temperature was perfect for learning all day.' };
  if (avg >= 18 && avg <= 26)
    return { grade: 'A',  color: GRADE_COLORS['A'],  tip: 'Temperature stayed in the comfortable range.' };
  if (avg >= 16 && avg <= 28)
    return { grade: 'B',  color: GRADE_COLORS['B'],  tip: 'Temperature drifted slightly. Check windows or thermostat.' };
  if (avg >= 14 && avg <= 30)
    return { grade: 'C',  color: GRADE_COLORS['C'],  tip: 'Temperature was frequently outside the ideal range today.' };
  return       { grade: 'F',  color: GRADE_COLORS['F'],  tip: 'Dangerous temperature readings. Check HVAC immediately.' };
}

function gradeHumidity(stats: SensorStats): GradeResult {
  const { avg, min, max } = stats;
  if (avg >= 40 && avg <= 55 && min >= 30 && max <= 60)
    return { grade: 'A+', color: GRADE_COLORS['A+'], tip: 'Humidity was ideal all day — comfortable and healthy.' };
  if (avg >= 30 && avg <= 60)
    return { grade: 'A',  color: GRADE_COLORS['A'],  tip: 'Humidity stayed in the healthy range.' };
  if (avg >= 25 && avg <= 65)
    return { grade: 'B',  color: GRADE_COLORS['B'],  tip: 'Humidity was slightly off. A small humidifier may help.' };
  if (avg >= 20 && avg <= 70)
    return { grade: 'C',  color: GRADE_COLORS['C'],  tip: 'Low or high humidity today. Consider a humidifier or dehumidifier.' };
  return       { grade: 'F',  color: GRADE_COLORS['F'],  tip: 'Extreme humidity levels — this can spread illness or cause mould.' };
}

function gradeAirQuality(stats: SensorStats): GradeResult {
  const { avg } = stats;
  if (avg >= 100)
    return { grade: 'A+', color: GRADE_COLORS['A+'], tip: 'Air quality was excellent today.' };
  if (avg >= 60)
    return { grade: 'A',  color: GRADE_COLORS['A'],  tip: 'Air quality was clean and comfortable.' };
  if (avg >= 40)
    return { grade: 'B',  color: GRADE_COLORS['B'],  tip: 'Air quality was acceptable. Try opening a window mid-day.' };
  if (avg >= 25)
    return { grade: 'C',  color: GRADE_COLORS['C'],  tip: 'Air quality was poor. Ventilate more frequently.' };
  return       { grade: 'F',  color: GRADE_COLORS['F'],  tip: 'Very poor air quality today. Open windows and check ventilation.' };
}

const GRADE_ORDER: Grade[] = ['A+', 'A', 'B', 'C', 'F'];

function overallGrade(grades: Grade[]): Grade {
  const worst = grades.reduce((w, g) =>
    GRADE_ORDER.indexOf(g) > GRADE_ORDER.indexOf(w) ? g : w
  , 'A+' as Grade);
  const avgIdx = Math.round(
    grades.reduce((s, g) => s + GRADE_ORDER.indexOf(g), 0) / grades.length
  );
  return GRADE_ORDER[Math.min(GRADE_ORDER.indexOf(worst), avgIdx + 1)];
}

type ReportCardProps = {
  tempStats: SensorStats;
  humStats:  SensorStats;
  aqStats:   SensorStats;
};

function ReportCard({ tempStats, humStats, aqStats }: ReportCardProps) {
  const temp = gradeTemperature(tempStats);
  const hum  = gradeHumidity(humStats);
  const aq   = gradeAirQuality(aqStats);
  const overall = overallGrade([temp.grade, hum.grade, aq.grade]);

  return (
    <View style={rcStyles.card}>
      <View style={rcStyles.cardHeader}>
        <Text style={rcStyles.cardTitle}>REPORT CARD</Text>
        <View style={[rcStyles.overallBadge, { backgroundColor: GRADE_COLORS[overall] }]}>
          <Text style={rcStyles.overallGrade}>{overall}</Text>
        </View>
      </View>

      <GradeRow label="Temperature" result={temp}  accent="#EF4444" />
      <GradeRow label="Humidity"    result={hum}   accent="#6366F1" />
      <GradeRow label="Air Quality" result={aq}    accent="#16A34A" />
    </View>
  );
}

function GradeRow({ label, result, accent }: { label: string; result: GradeResult; accent: string }) {
  return (
    <View style={rcStyles.row}>
      <View style={[rcStyles.rowAccent, { backgroundColor: accent }]} />
      <View style={{ flex: 1 }}>
        <Text style={rcStyles.rowLabel}>{label}</Text>
        <Text style={rcStyles.rowTip}>{result.tip}</Text>
      </View>
      <Text style={[rcStyles.gradeLetter, { color: result.color }]}>{result.grade}</Text>
    </View>
  );
}

const rcStyles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF', borderRadius: 16, marginBottom: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
    overflow: 'hidden',
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F2F2F7',
  },
  cardTitle: {
    fontSize: 11, fontWeight: '800', color: '#000000',
    letterSpacing: 1.5,
  },
  overallBadge: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  overallGrade: { fontSize: 18, fontWeight: '900', color: '#FFFFFF' },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#F2F2F7',
  },
  rowAccent:  { width: 3, height: 36, borderRadius: 2, flexShrink: 0 },
  rowLabel:   { fontSize: 12, fontWeight: '700', color: '#000000', marginBottom: 3 },
  rowTip:     { fontSize: 12, color: '#8E8E93', lineHeight: 16 },
  gradeLetter: { fontSize: 32, fontWeight: '900', letterSpacing: -1, minWidth: 40, textAlign: 'right' },
});

// ── Screen ────────────────────────────────────────────────────────────────────

export default function TeacherDashboard() {
  const [buckets, setBuckets]       = useState<HourlyBucket[]>([]);
  const [rawRows, setRawRows]       = useState<RawReading[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    const since = new Date();
    since.setHours(since.getHours() - 24);
    const { data, error } = await supabase
      .from('sensor_readings')
      .select('created_at, temperature, humidity, air_quality')
      .gte('created_at', since.toISOString())
      .order('created_at', { ascending: false })
      .limit(1000);
    if (!error && data) {
      const rows = data as RawReading[];
      setRawRows(rows);
      setBuckets(buildHourlyBuckets([...rows].reverse()));
      setLastUpdated(new Date());
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);
  const onRefresh = () => { setRefreshing(true); fetchData(); };

  const tempStats = calcStats(rawRows, 'temperature');
  const humStats  = calcStats(rawRows, 'humidity');
  const aqStats   = calcStats(rawRows, 'air_quality');

  const tempData = buckets.map((b) => b.temperature);
  const humData  = buckets.map((b) => b.humidity);
  const aqData   = buckets.map((b) => b.air_quality);
  const labels   = buckets.map((b) => b.label);

  const updatedStr = lastUpdated
    ? lastUpdated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />

      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>Analytics</Text>
          <Text style={styles.headerSub}>24-hour environmental data</Text>
        </View>
        {updatedStr && <Text style={styles.headerTime}>{updatedStr}</Text>}
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh}
            tintColor="#16A34A" colors={['#16A34A']} />
        }
      >
        {loading ? (
          <ActivityIndicator color="#16A34A" size="large" style={{ marginTop: 60 }} />
        ) : rawRows.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No data in the last 24 hours</Text>
          </View>
        ) : (
          <>
            {/* Summary strip */}
            <View style={styles.summaryStrip}>
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryVal, { color: '#DC2626' }]}>{tempStats.avg.toFixed(1)}°C</Text>
                <Text style={styles.summaryLbl}>Avg temp</Text>
              </View>
              <View style={styles.summarySep} />
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryVal, { color: '#6366F1' }]}>{humStats.avg.toFixed(1)}%</Text>
                <Text style={styles.summaryLbl}>Avg humidity</Text>
              </View>
              <View style={styles.summarySep} />
              <View style={styles.summaryItem}>
                <Text style={[styles.summaryVal, { color: '#16A34A' }]}>{aqStats.avg.toFixed(1)} kΩ</Text>
                <Text style={styles.summaryLbl}>Avg air quality</Text>
              </View>
            </View>

            <ReportCard tempStats={tempStats} humStats={humStats} aqStats={aqStats} />

            <ChartCard
              title="Temperature" unit="°C" color="#EF4444"
              data={tempData} labels={labels} stats={tempStats}
              idealLow={18} idealHigh={28} delay={0}
            />
            <ChartCard
              title="Humidity" unit="%" color="#6366F1"
              data={humData} labels={labels} stats={humStats}
              idealLow={20} idealHigh={60} delay={80}
            />
            <ChartCard
              title="VOC Air Quality" unit="kΩ" color="#16A34A"
              data={aqData} labels={labels} stats={aqStats}
              idealLow={45} idealHigh={200} delay={160}
            />

            <Text style={styles.footnote}>
              {rawRows.length} readings over 24 h · hourly averages · pull to refresh
            </Text>
          </>
        )}
        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#F2F2F7' },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 28 },

  header: {
    paddingTop: TOP_PAD, paddingHorizontal: 20, paddingBottom: 14,
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#C6C6C8',
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: '#000000', letterSpacing: -0.3 },
  headerSub:   { fontSize: 12, color: '#8E8E93', marginTop: 2 },
  headerTime:  { fontSize: 12, color: '#8E8E93' },

  // Summary strip
  summaryStrip: {
    flexDirection: 'row', backgroundColor: '#FFFFFF',
    borderRadius: 16, marginBottom: 14, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 4, elevation: 2,
  },
  summaryItem:  { flex: 1, alignItems: 'center', paddingVertical: 16 },
  summaryVal:   { fontSize: 16, fontWeight: '700', letterSpacing: -0.3 },
  summaryLbl:   { fontSize: 10, color: '#8E8E93', marginTop: 3 },
  summarySep:   { width: StyleSheet.hairlineWidth, backgroundColor: '#F2F2F7', marginVertical: 12 },

  // Chart card
  chartCard: {
    backgroundColor: '#FFFFFF', borderRadius: 16,
    marginBottom: 14, overflow: 'hidden',
    borderTopWidth: 3,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
  },
  chartCardHeader: {
    flexDirection: 'row', alignItems: 'center',
    gap: 10, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10,
  },
  chartAccent: { width: 3, height: 20, borderRadius: 2 },
  chartTitle:  { fontSize: 14, fontWeight: '700', color: '#000000' },
  chartIdeal:  { fontSize: 11, color: '#8E8E93', marginTop: 1 },
  nowBadge:    { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  nowValue:    { fontSize: 13, fontWeight: '700' },
  chartWrap:   { paddingHorizontal: 16, paddingBottom: 4 },

  // Stats row
  statsRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#F2F2F7',
  },
  statChip:      { alignItems: 'center', flex: 1 },
  statChipLabel: { fontSize: 9, fontWeight: '700', color: '#C7C7CC', letterSpacing: 0.6, marginBottom: 3 },
  statChipValue: { fontSize: 14, fontWeight: '700', color: '#000000', letterSpacing: -0.3 },
  statChipUnit:  { fontSize: 10, color: '#8E8E93', marginTop: 1 },

  footnote: { fontSize: 12, color: '#C7C7CC', textAlign: 'center', marginTop: 8 },
  empty:     { alignItems: 'center', marginTop: 80 },
  emptyText: { color: '#8E8E93', fontSize: 15 },
});
