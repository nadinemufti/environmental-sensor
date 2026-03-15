import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://dnvrhloomkjkownjohpv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRudnJobG9vbWtqa293bmpvaHB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1ODMxOTUsImV4cCI6MjA4OTE1OTE5NX0.d_17mkOSDqy0ZtBTETYzCrGTRiPb1ybOPgfW5LYk3tQ'
);

export default function Index() {
  const [data, setData] = useState(null);

  const fetchData = async () => {
    const { data: rows } = await supabase
      .from('sensor_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1);
    if (rows && rows.length > 0) setData(rows[0]);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  const getTempColor = (val) => {
    if (!val) return '#888';
    if (val >= 18 && val <= 24) return '#00ff99';
    if (val >= 15 && val <= 27) return '#ffcc00';
    return '#ff4444';
  };

  const getHumidityColor = (val) => {
    if (!val) return '#888';
    if (val >= 40 && val <= 60) return '#00ff99';
    if (val >= 30 && val <= 70) return '#ffcc00';
    return '#ff4444';
  };

  const getStatus = (val) => {
    if (!val) return { color: '#888', label: 'unknown', desc: 'no data', dot: '#888' };
    if (val > 50) return { color: '#00ff99', label: 'good', desc: 'air quality is healthy', dot: '#00ff99' };
    if (val > 20) return { color: '#ffcc00', label: 'moderate', desc: 'consider opening a window', dot: '#ffcc00' };
    return { color: '#ff4444', label: 'poor', desc: 'ventilate the room now', dot: '#ff4444' };
  };

  const status = getStatus(data?.air_quality);

  // noise bar 0-4095 scaled to 0-100%
  const noisePercent = data ? Math.min((data.noise / 4095) * 100, 100) : 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>classsense</Text>
      <Text style={styles.subtitle}>classroom air monitor</Text>

      {data ? (
        <>
          <View style={styles.grid}>

            {/* temp */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardIcon}>🌡</Text>
                <View style={[styles.dot, { backgroundColor: getTempColor(data.temperature) }]} />
              </View>
              <Text style={styles.cardValue}>{data.temperature?.toFixed(1)}°</Text>
              <Text style={styles.cardLabel}>temperature</Text>
            </View>

            {/* humidity */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardIcon}>💧</Text>
                <View style={[styles.dot, { backgroundColor: getHumidityColor(data.humidity) }]} />
              </View>
              <Text style={styles.cardValue}>{data.humidity?.toFixed(1)}%</Text>
              <Text style={styles.cardLabel}>humidity</Text>
            </View>

            {/* air quality */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardIcon}>🌿</Text>
                <View style={[styles.dot, { backgroundColor: status.dot }]} />
              </View>
              <Text style={styles.cardValue}>{data.air_quality}</Text>
              <Text style={styles.cardLabel}>air quality (kohms)</Text>
            </View>

            {/* noise */}
            <View style={styles.card}>
              <Text style={styles.cardIcon}>🔊</Text>
              <Text style={styles.cardValue}>{data.noise}</Text>
              <Text style={styles.cardLabel}>noise level</Text>
              <View style={styles.noiseBarBg}>
                <View style={[styles.noiseBarFill, { width: `${noisePercent}%`, backgroundColor: noisePercent > 70 ? '#ff4444' : noisePercent > 40 ? '#ffcc00' : '#555' }]} />
              </View>
            </View>

          </View>

          {/* status indicator */}
          <View style={styles.statusCard}>
            <View style={[styles.bigDot, { backgroundColor: status.dot }]} />
            <Text style={[styles.statusLabel, { color: status.color }]}>{status.label}</Text>
            <Text style={styles.statusDesc}>{status.desc}</Text>

            <View style={styles.ledRow}>
              <View style={styles.ledItem}>
                <View style={[styles.led, { backgroundColor: data.air_quality > 50 ? '#00ff99' : '#1a1a1a', borderColor: '#00ff99' }]} />
                <Text style={styles.ledLabel}>good</Text>
              </View>
              <View style={styles.ledItem}>
                <View style={[styles.led, { backgroundColor: data.air_quality > 20 && data.air_quality <= 50 ? '#ffcc00' : '#1a1a1a', borderColor: '#ffcc00' }]} />
                <Text style={styles.ledLabel}>moderate</Text>
              </View>
              <View style={styles.ledItem}>
                <View style={[styles.led, { backgroundColor: data.air_quality <= 20 ? '#ff4444' : '#1a1a1a', borderColor: '#ff4444' }]} />
                <Text style={styles.ledLabel}>poor</Text>
              </View>
            </View>
          </View>
        </>
      ) : (
        <Text style={styles.waiting}>waiting for data...</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container:    { flexGrow: 1, backgroundColor: '#0a0a0a', alignItems: 'center', paddingTop: 80, paddingBottom: 40 },
  title:        { fontSize: 36, color: '#fff', fontWeight: 'bold', letterSpacing: 2 },
  subtitle:     { fontSize: 14, color: '#555', marginBottom: 40, letterSpacing: 1 },
  grid:         { width: '90%', flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, marginBottom: 12 },
  card:         { backgroundColor: '#1a1a1a', borderRadius: 16, padding: 20, width: '47%', alignItems: 'center' },
  cardHeader:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 6 },
  cardIcon:     { fontSize: 24 },
  dot:          { width: 10, height: 10, borderRadius: 5 },
  cardValue:    { fontSize: 26, color: '#fff', fontWeight: 'bold' },
  cardLabel:    { fontSize: 11, color: '#555', marginTop: 4 },
  noiseBarBg:   { width: '100%', height: 4, backgroundColor: '#333', borderRadius: 2, marginTop: 10 },
  noiseBarFill: { height: 4, borderRadius: 2 },
  statusCard:   { width: '90%', backgroundColor: '#1a1a1a', borderRadius: 16, padding: 28, alignItems: 'center' },
  bigDot:       { width: 60, height: 60, borderRadius: 30, marginBottom: 16 },
  statusLabel:  { fontSize: 32, fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: 3 },
  statusDesc:   { fontSize: 13, color: '#555', marginTop: 6, marginBottom: 24 },
  ledRow:       { flexDirection: 'row', gap: 24 },
  ledItem:      { alignItems: 'center', gap: 6 },
  led:          { width: 24, height: 24, borderRadius: 12, borderWidth: 2 },
  ledLabel:     { fontSize: 11, color: '#555' },
  waiting:      { color: '#555', fontSize: 16, marginTop: 40 },
});
