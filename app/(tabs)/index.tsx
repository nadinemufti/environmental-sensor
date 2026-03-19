import { useEffect, useState, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, Animated,
  ActivityIndicator, Platform, StatusBar, Alert, Vibration,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { supabase } from '../../lib/supabase';

// Only register notification handler on native — not available on web
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge:  false,
    }),
  });
}

async function registerNotifications() {
  if (Platform.OS === 'web' || !Device.isDevice) return;
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing !== 'granted') await Notifications.requestPermissionsAsync();
}

async function sendStatusNotification(status: 'warning' | 'poor', row: SensorRow) {
  if (Platform.OS === 'web') return;
  const bad: string[] = [];
  if (tempStatus(row.temperature) !== 'good') bad.push(`Temp ${row.temperature.toFixed(1)}°C`);
  if (humStatus(row.humidity)    !== 'good') bad.push(`Humidity ${row.humidity.toFixed(0)}%`);
  if (aqStatus(row.air_quality)  !== 'good') bad.push('VOC Air Quality');
  await Notifications.scheduleNotificationAsync({
    content: {
      title: status === 'poor' ? 'Poor Air Quality -- Act Now' : 'Air Quality Warning',
      body:  bad.length ? bad.join(' · ') : 'Check classroom conditions.',
      sound: true,
    },
    trigger: null,
  });
}

const TOP_PAD = Platform.OS === 'ios' ? 54 : (StatusBar.currentHeight ?? 24) + 8;
const POLL_MS = 5000;
const OFFLINE_THRESHOLD = 2;
const GAP = 10;

type Status = 'good' | 'warning' | 'poor';

// Per-status accent colors (for cards, borders, numbers)
const ACCENT: Record<Status, string> = {
  good:    '#16A34A',
  warning: '#D97706',
  poor:    '#DC2626',
};

type SensorRow = {
  temperature:       number;
  humidity:          number;
  air_quality:       number;
  noise:             number;
  iaq_score:         number | null;
  ml_classification: string | null;
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
function iaqStatus(iaq: number): Status {
  if (iaq < 100) return 'good';
  if (iaq < 200) return 'warning';
  return 'poor';
}
function noiseStatus(v: number): Status {
  if (v < 1000)  return 'good';
  if (v <= 3000) return 'warning';
  return 'poor';
}
function overallStatus(row: SensorRow): Status {
  // Use iaq_score from DB if available (matches what the card shows).
  // Fall back to kOhmToIAQ only if the column hasn't been posted yet.
  const iaq = row.iaq_score != null ? row.iaq_score : kOhmToIAQ(row.air_quality);

  // Extreme override -- auto-poor regardless of count
  if (iaq >= 400 || row.temperature < 10 || row.temperature > 38 ||
      row.humidity < 5 || row.humidity > 85) return 'poor';

  // 2+ sensors bad = poor, 1 bad = warning (noise excluded entirely)
  const tS = tempStatus(row.temperature);
  const hS = humStatus(row.humidity);
  const aS = iaqStatus(iaq);   // same path as the card -- no more kOhm mismatch

  const badCount = (tS === 'poor' ? 1 : 0) + (hS === 'poor' ? 1 : 0) + (aS === 'poor' ? 1 : 0);
  if (badCount >= 2) return 'poor';
  if (badCount === 1) return 'warning';

  if (tS === 'warning' || hS === 'warning' || aS === 'warning') return 'warning';
  return 'good';
}

function kOhmToIAQ(kOhm: number): number {
  if (kOhm > 45)  return Math.round(50  * Math.max(0, 1 - (kOhm - 45) / 155));
  if (kOhm >= 25) return Math.round(50  + 50  * (1 - (kOhm - 25) / 20));
  return               Math.round(100 + 200 * (1 - Math.max(0, kOhm) / 25));
}

type AnomalyStats = { mean: number; std: number };
type SensorStats  = Record<'temperature' | 'humidity' | 'air_quality' | 'noise', AnomalyStats>;

function calcStats(rows: SensorRow[], key: keyof SensorRow): AnomalyStats {
  const vals = rows.map((r) => r[key] as number).filter(Number.isFinite);
  if (!vals.length) return { mean: 0, std: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std  = Math.sqrt(vals.map((v) => (v - mean) ** 2).reduce((a, b) => a + b, 0) / vals.length);
  return { mean, std };
}

function isAnomalous(value: number, s: AnomalyStats): boolean {
  return s.std > 0.5 && Math.abs(value - s.mean) > 2 * s.std;
}

const ANTHROPIC_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY ?? '';

async function fetchAdvice(row: SensorRow, status: Status): Promise<string> {
  if (!ANTHROPIC_KEY) return '';
  const prompt =
    `Classroom: ${row.temperature.toFixed(1)}C, ${row.humidity.toFixed(1)}% humidity, ` +
    `status ${status}. One short practical tip for the teacher. Max 12 words.`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5', max_tokens: 60,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return '';
    const json = await res.json();
    const text = json?.content?.[0]?.text;
    return typeof text === 'string' ? text.trim().slice(0, 100) : '';
  } catch { return ''; }
  finally { clearTimeout(timeout); }
}

// ── Sensor card ───────────────────────────────────────────────────────────────

type CardProps = {
  label:    string;
  value:    string;
  unit:     string;
  status:   Status;
  progress: number;
  range:    string;
  anomaly:  boolean;
};

function SensorCard({ label, value, unit, status, progress, range, anomaly }: CardProps) {
  const accent = ACCENT[status];
  const p = Math.min(Math.max(progress, 0), 1);
  return (
    <View style={[styles.card, { borderTopColor: anomaly ? '#F59E0B' : accent }]}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardLabel}>{label.toUpperCase()}</Text>
        {anomaly && <Ionicons name="warning" size={10} color="#F59E0B" />}
      </View>
      <View style={styles.cardValueWrap}>
        <Text style={[styles.cardNum, { color: accent }]} adjustsFontSizeToFit numberOfLines={1}>
          {value}
        </Text>
        {unit ? <Text style={[styles.cardUnit, { color: accent }]}>{unit}</Text> : null}
      </View>
      <View>
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${p * 100}%`, backgroundColor: accent }]} />
        </View>
        <Text style={styles.rangeText}>{range}</Text>
      </View>
    </View>
  );
}

// ── Info bar ──────────────────────────────────────────────────────────────────

const ML_COLOR: Record<string, string> = {
  Good: '#16A34A', Moderate: '#D97706', Poor: '#DC2626',
};

function InfoBar({
  classification, anomalyResult, advice,
}: {
  classification: string | null;
  anomalyResult:  'normal' | 'anomaly' | 'loading';
  advice:         string;
}) {
  const mlColor = classification ? (ML_COLOR[classification] ?? '#8E8E93') : '#8E8E93';
  const anColor = anomalyResult === 'anomaly' ? '#D97706' : anomalyResult === 'normal' ? '#16A34A' : '#8E8E93';
  const anLabel = anomalyResult === 'anomaly' ? 'Anomaly' : anomalyResult === 'normal' ? 'Normal' : '--';
  return (
    <View style={styles.infoBar}>
      <View style={styles.infoChip}>
        <Ionicons name="hardware-chip" size={11} color="#8E8E93" />
        <Text style={styles.infoChipLabel}>ML</Text>
        <View style={[styles.infoDot, { backgroundColor: mlColor }]} />
        <Text style={[styles.infoChipVal, { color: mlColor }]}>{classification ?? '--'}</Text>
      </View>
      <View style={styles.infoSep} />
      <View style={styles.infoChip}>
        <Ionicons name="analytics" size={11} color="#8E8E93" />
        <Text style={styles.infoChipLabel}>Stats</Text>
        <View style={[styles.infoDot, { backgroundColor: anColor }]} />
        <Text style={[styles.infoChipVal, { color: anColor }]}>{anLabel}</Text>
      </View>
      {advice ? (
        <>
          <View style={styles.infoSep} />
          <View style={[styles.infoChip, { flex: 1 }]}>
            <Ionicons name="bulb" size={11} color="#7C3AED" />
            <Text style={styles.adviceText} numberOfLines={1}>{advice}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

const SCREEN_BG: Record<Status, string> = {
  good:    '#FFFFFF',
  warning: '#FFFBEB',
  poor:    '#DC2626',
};

export default function DashboardScreen() {
  const [data, setData]           = useState<SensorRow | null>(null);
  const [advice, setAdvice]       = useState('');
  const [secsAgo, setSecsAgo]     = useState<number | null>(null);
  const [loading, setLoading]     = useState(true);
  const [offline, setOffline]     = useState(false);
  const [stats, setStats]         = useState<SensorStats | null>(null);
  const [anomalyResult, setAnomalyResult] = useState<'normal' | 'anomaly' | 'loading'>('loading');

  const lastFetched     = useRef<number | null>(null);
  const lastStatus      = useRef<Status | ''>('');
  const lastAlertStatus = useRef<Status | ''>('');
  const lastNotifStatus = useRef<Status | ''>('');
  const missedFetches   = useRef(0);
  const pulse           = useRef(new Animated.Value(1)).current;
  const flashAnim       = useRef(new Animated.Value(0)).current;

  useEffect(() => { registerNotifications(); }, []);

  const loadStats = useCallback(async () => {
    const { data: rows, error } = await supabase
      .from('sensor_readings')
      .select('temperature, humidity, air_quality, noise')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error || !rows?.length) return;
    const r = rows as SensorRow[];
    setStats({
      temperature: calcStats(r, 'temperature'),
      humidity:    calcStats(r, 'humidity'),
      air_quality: calcStats(r, 'air_quality'),
      noise:       calcStats(r, 'noise'),
    });
  }, []);

  useEffect(() => {
    loadStats();
    const id = setInterval(loadStats, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [loadStats]);

  // Live dot pulse
  useEffect(() => {
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1.6, duration: 1000, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1.0, duration: 1000, useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, []);

  // Seconds-ago counter
  useEffect(() => {
    const id = setInterval(() => {
      if (lastFetched.current != null)
        setSecsAgo(Math.floor((Date.now() - lastFetched.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const fetchLatest = useCallback(async () => {
    let rows: SensorRow[] | null = null;
    try {
      const { data: d, error } = await supabase
        .from('sensor_readings')
        .select('temperature, humidity, air_quality, noise, iaq_score, ml_classification')
        .order('created_at', { ascending: false })
        .limit(1);
      if (!error && d?.length) rows = d as SensorRow[];
      else if (error) {
        const { data: fb, error: fe } = await supabase
          .from('sensor_readings')
          .select('temperature, humidity, air_quality, noise')
          .order('created_at', { ascending: false })
          .limit(1);
        if (!fe && fb)
          rows = (fb as Omit<SensorRow, 'ml_classification' | 'iaq_score'>[]).map(
            (r) => ({ ...r, iaq_score: null, ml_classification: null }),
          );
      }
    } catch { rows = null; }

    if (!rows?.length) {
      missedFetches.current += 1;
      if (missedFetches.current >= OFFLINE_THRESHOLD) setOffline(true);
      setLoading(false);
      return;
    }

    missedFetches.current = 0;
    setOffline(false);
    const row = rows[0];
    setData(row);
    lastFetched.current = Date.now();
    setSecsAgo(0);

    setStats((cur) => {
      if (cur) {
        const flagged =
          isAnomalous(row.temperature, cur.temperature) ||
          isAnomalous(row.humidity,    cur.humidity)    ||
          isAnomalous(row.air_quality, cur.air_quality) ||
          isAnomalous(row.noise,       cur.noise);
        setAnomalyResult(flagged ? 'anomaly' : 'normal');
      }
      return cur;
    });

    const status = overallStatus(row);

    if (status === 'poor' && lastAlertStatus.current !== 'poor') {
      if (Platform.OS !== 'web') Vibration.vibrate([0, 500, 200, 500]);
      Alert.alert('Poor Air Quality', 'Open windows and check the room immediately.', [{ text: 'OK' }]);
    }
    lastAlertStatus.current = status;

    if ((status === 'poor' || status === 'warning') && status !== lastNotifStatus.current) {
      sendStatusNotification(status, row);
    }
    lastNotifStatus.current = status;

    if (status !== lastStatus.current) {
      lastStatus.current = status;
      fetchAdvice(row, status).then(setAdvice);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchLatest();
    const id = setInterval(fetchLatest, POLL_MS);
    return () => clearInterval(id);
  }, [fetchLatest]);

  const status  = data ? overallStatus(data) : 'good';
  const isPoor  = status === 'poor';
  const screenBg = SCREEN_BG[status];

  // Flash animation when poor
  useEffect(() => {
    if (isPoor) {
      const anim = Animated.loop(Animated.sequence([
        Animated.timing(flashAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
        Animated.timing(flashAnim, { toValue: 0, duration: 350, useNativeDriver: true }),
      ]));
      anim.start();
      return () => { anim.stop(); flashAnim.setValue(0); };
    }
    flashAnim.setValue(0);
  }, [isPoor]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#16A34A" />
        <Text style={styles.loadingText}>Connecting...</Text>
      </View>
    );
  }

  const timeText = secsAgo == null ? '--' : secsAgo === 0 ? 'Just now' : `${secsAgo}s ago`;
  const iaq = data
    ? (data.iaq_score != null ? data.iaq_score : kOhmToIAQ(data.air_quality))
    : null;

  const tempAnomaly = data && stats ? isAnomalous(data.temperature, stats.temperature) : false;
  const humAnomaly  = data && stats ? isAnomalous(data.humidity,    stats.humidity)    : false;
  const aqAnomaly   = data && stats ? isAnomalous(data.air_quality, stats.air_quality) : false;
  const nzAnomaly   = data && stats ? isAnomalous(data.noise,       stats.noise)       : false;

  const headline  = isPoor ? 'POOR AIR QUALITY -- Act Now' : status === 'warning' ? 'Check Required' : 'All Clear';
  const mins      = secsAgo != null ? Math.floor(secsAgo / 60) : null;

  return (
    <View style={[styles.root, { backgroundColor: screenBg }]}>
      <StatusBar
        barStyle={isPoor ? 'light-content' : 'dark-content'}
        backgroundColor={screenBg}
      />

      {/* Header */}
      <View style={[styles.header, isPoor && styles.headerPoor]}>
        <Text style={[styles.appName, isPoor && styles.onRed]}>Celsius</Text>
        <View style={styles.headerRight}>
          <Animated.View style={[
            styles.liveDot,
            { transform: [{ scale: pulse }] },
            isPoor && { backgroundColor: '#FCA5A5' },
          ]} />
          <Text style={[styles.liveTime, isPoor && styles.onRed]}>{timeText}</Text>
          {offline && (
            <>
              <Ionicons name="cloud-offline" size={12} color={isPoor ? '#FCA5A5' : '#8E8E93'} />
              {mins != null && mins > 0 && (
                <Text style={[styles.liveTime, isPoor && styles.onRed]}>{mins}m ago</Text>
              )}
            </>
          )}
        </View>
      </View>

      {/* Status banner */}
      {isPoor ? (
        <View style={styles.poorBanner}>
          <Text style={styles.poorBannerText}>POOR AIR QUALITY</Text>
          <Text style={styles.poorBannerSub}>Act now -- open windows immediately</Text>
        </View>
      ) : (
        <View style={[styles.statusStrip, {
          backgroundColor: status === 'warning' ? '#FEF3C7' : '#F0FDF4',
          borderBottomColor: status === 'warning' ? '#FDE68A' : '#BBF7D0',
        }]}>
          <View style={[styles.statusDot, { backgroundColor: ACCENT[status] }]} />
          <Text style={[styles.statusTitle, { color: ACCENT[status] }]}>{headline}</Text>
          {offline && (
            <Text style={[styles.statusTitle, { color: '#8E8E93', marginLeft: 'auto' as any }]}>
              Offline
            </Text>
          )}
        </View>
      )}

      {/* 2x2 grid */}
      {data ? (
        <View style={[styles.grid, offline && styles.gridFaded]}>
          <View style={styles.gridRow}>
            <SensorCard
              label="Temperature"
              value={data.temperature.toFixed(1)}
              unit="°C"
              status={tempStatus(data.temperature)}
              progress={data.temperature / 50}
              range="18 -- 28 °C"
              anomaly={tempAnomaly}
            />
            <SensorCard
              label="Humidity"
              value={data.humidity.toFixed(1)}
              unit="%"
              status={humStatus(data.humidity)}
              progress={data.humidity / 100}
              range="20 -- 60 %"
              anomaly={humAnomaly}
            />
          </View>
          <View style={styles.gridRow}>
            <SensorCard
              label="VOC Air Quality"
              value={iaq != null ? String(iaq) : data.air_quality.toFixed(1)}
              unit={iaq != null ? 'IAQ' : 'kOhm'}
              status={iaq != null ? iaqStatus(iaq) : aqStatus(data.air_quality)}
              progress={iaq != null ? iaq / 500 : data.air_quality / 100}
              range="IAQ 0-100 good"
              anomaly={aqAnomaly}
            />
            <SensorCard
              label="Noise"
              value={data.noise < 1000 ? 'Quiet' : data.noise < 3000 ? 'Moderate' : 'Loud'}
              unit=""
              status={noiseStatus(data.noise)}
              progress={data.noise / 4095}
              range="< 1,000 quiet"
              anomaly={nzAnomaly}
            />
          </View>
        </View>
      ) : (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, isPoor && styles.onRed]}>Waiting for sensor data...</Text>
        </View>
      )}

      {/* Info bar */}
      {data && (
        <InfoBar
          classification={data.ml_classification}
          anomalyResult={anomalyResult}
          advice={advice}
        />
      )}

      {/* Poor state flash overlay — touch-transparent, on top of everything */}
      {isPoor && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: '#FFFFFF', opacity: flashAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.12] }) },
          ]}
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root:        { flex: 1 },
  loading:     { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#F2F2F7', gap: 12 },
  loadingText: { color: '#8E8E93', fontSize: 14 },

  // Header
  header: {
    paddingTop: TOP_PAD,
    paddingHorizontal: 20,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#C6C6C8',
  },
  headerPoor:  { backgroundColor: 'transparent', borderBottomWidth: 0 },
  appName:     { fontSize: 17, fontWeight: '700', color: '#000000', letterSpacing: -0.3 },
  onRed:       { color: '#FFFFFF' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveDot:     { width: 7, height: 7, borderRadius: 3.5, backgroundColor: '#34C759' },
  liveTime:    { fontSize: 13, color: '#8E8E93' },

  // Status strip (good / warning)
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 11,
    gap: 8,
    borderBottomWidth: 1,
  },
  statusDot:   { width: 8, height: 8, borderRadius: 4 },
  statusTitle: { fontSize: 14, fontWeight: '600' },

  // Poor banner
  poorBanner: {
    paddingHorizontal: 20,
    paddingVertical: 18,
    alignItems: 'center',
  },
  poorBannerText: {
    fontSize: 22,
    fontWeight: '900',
    color: '#FFFFFF',
    letterSpacing: 0.4,
    textAlign: 'center',
  },
  poorBannerSub: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.82)',
    marginTop: 5,
    textAlign: 'center',
  },

  // Grid
  grid:      { flex: 1, padding: GAP, gap: GAP },
  gridRow:   { flex: 1, flexDirection: 'row', gap: GAP },
  gridFaded: { opacity: 0.45 },

  // Card
  card: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 16,
    borderTopWidth: 3,
    justifyContent: 'space-between',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.10,
    shadowRadius: 8,
    elevation: 4,
  },
  cardHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  cardLabel:     { fontSize: 9, fontWeight: '700', color: '#8E8E93', letterSpacing: 0.8 },
  cardValueWrap: { flex: 1, justifyContent: 'center' },
  cardNum:       { fontSize: 48, fontWeight: '800', letterSpacing: -1, lineHeight: 56 },
  cardUnit:      { fontSize: 13, fontWeight: '600', opacity: 0.75, marginTop: 2 },
  bar:           { height: 3, backgroundColor: '#F2F2F7', borderRadius: 1.5, overflow: 'hidden', marginBottom: 4 },
  barFill:       { height: '100%', borderRadius: 1.5 },
  rangeText:     { fontSize: 9, color: '#C7C7CC' },

  // Info bar
  infoBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#C6C6C8',
  },
  infoChip:      { flexDirection: 'row', alignItems: 'center', gap: 5 },
  infoChipLabel: { fontSize: 10, fontWeight: '600', color: '#C7C7CC', letterSpacing: 0.3 },
  infoChipVal:   { fontSize: 11, fontWeight: '600' },
  infoDot:       { width: 5, height: 5, borderRadius: 2.5 },
  infoSep:       { width: StyleSheet.hairlineWidth, height: 16, backgroundColor: '#C6C6C8', marginHorizontal: 12 },
  adviceText:    { fontSize: 11, color: '#5856D6', flex: 1, lineHeight: 16 },

  // Empty
  empty:     { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: 15, color: '#8E8E93' },
});
