import qrcode from 'qrcode-generator';
import { useEffect, useMemo } from 'react';
import { View } from 'react-native';

/** Pure-JS QR code drawn with Views (no native module). */
export function QrCode({
  value,
  size = 260,
}: {
  value: string;
  size?: number;
}) {
  useEffect(() => {
    // Development only: simulators have no camera, so the paired simulator
    // pastes this text into the scanner's dev fallback instead.
    if (__DEV__) console.log(`[dev] QR content: ${value}`);
  }, [value]);
  const rows = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const result: { start: number; length: number }[][] = [];
    for (let r = 0; r < count; r++) {
      const runs: { start: number; length: number }[] = [];
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) continue;
        const last = runs[runs.length - 1];
        if (last && last.start + last.length === c) last.length++;
        else runs.push({ start: c, length: 1 });
      }
      result.push(runs);
    }
    return { count, result };
  }, [value]);
  const quiet = 4;
  const cell = Math.floor(size / (rows.count + quiet * 2));
  const inner = cell * rows.count;
  return (
    <View
      accessibilityLabel="QR code"
      style={{
        backgroundColor: '#FFFFFF',
        padding: cell * quiet,
        alignSelf: 'center',
        borderRadius: 16,
      }}
    >
      <View style={{ width: inner, height: inner }}>
        {rows.result.map((runs, r) =>
          runs.map((run) => (
            <View
              key={`${r}-${run.start}`}
              style={{
                position: 'absolute',
                top: r * cell,
                left: run.start * cell,
                width: run.length * cell,
                height: cell,
                backgroundColor: '#000000',
              }}
            />
          )),
        )}
      </View>
    </View>
  );
}
