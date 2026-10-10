import { useRef, useState } from 'react';
import { Modal, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button } from './Button';

type Props = {
  visible: boolean;
  title: string;
  onScanned: (text: string) => void;
  onClose: () => void;
};

// Loaded lazily: a development build made before expo-camera was added has no
// native camera module, and a top-level import would crash every screen.
let camera: typeof import('expo-camera') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  camera = require('expo-camera') as typeof import('expo-camera');
} catch {
  camera = null;
}

/** Full-screen QR scanner. Reports the first code once, then closes. */
export function QrScanner(props: Props) {
  if (!camera)
    return (
      <Modal
        visible={props.visible}
        animationType="slide"
        onRequestClose={props.onClose}
      >
        <SafeAreaView className="flex-1 bg-ink p-6 gap-4 justify-center">
          <Text className="text-base text-white">
            This build has no camera module. Rebuild the app (npx expo run:ios)
            to scan QR codes.
          </Text>
          {__DEV__ && <DevPasteFallback onScanned={props.onScanned} />}
          <Button label="Close" secondary onPress={props.onClose} />
        </SafeAreaView>
      </Modal>
    );
  return <CameraScanner {...props} cameraModule={camera} />;
}

function CameraScanner({
  visible,
  title,
  onScanned,
  onClose,
  cameraModule,
}: Props & { cameraModule: typeof import('expo-camera') }) {
  const { CameraView, useCameraPermissions } = cameraModule;
  const [permission, requestPermission] = useCameraPermissions();
  const done = useRef(false);
  return (
    <Modal
      visible={visible}
      animationType="slide"
      onShow={() => {
        done.current = false;
      }}
      onRequestClose={onClose}
    >
      <SafeAreaView className="flex-1 bg-ink p-6 gap-4">
        <Text className="text-xl font-bold text-white">{title}</Text>
        {permission?.granted ? (
          <View className="flex-1 overflow-hidden rounded-3xl">
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => {
                if (done.current) return;
                done.current = true;
                onScanned(data);
              }}
            />
          </View>
        ) : (
          <View className="flex-1 justify-center gap-4">
            <Text className="text-base text-white">
              The camera is used only to read Swissquote Wallet QR codes.
            </Text>
            <Button
              label="Allow camera"
              onPress={() => void requestPermission()}
            />
          </View>
        )}
        {__DEV__ && (
          <DevPasteFallback
            onScanned={(text) => {
              if (done.current) return;
              done.current = true;
              onScanned(text);
            }}
          />
        )}
        <Button label="Cancel" secondary onPress={onClose} />
      </SafeAreaView>
    </Modal>
  );
}

/**
 * Development only: simulators have no camera. Paste the QR text that the
 * other device logs to Metro ("[dev] QR content: ...") instead of scanning.
 */
function DevPasteFallback({
  onScanned,
}: {
  onScanned: (text: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel="Paste QR content (dev)"
        className="bg-white rounded-xl px-4 py-3 text-ink"
        placeholder="Dev: paste QR content"
        autoCapitalize="none"
        autoCorrect={false}
        value={text}
        onChangeText={setText}
      />
      <Button
        label="Use pasted code (dev)"
        secondary
        disabled={!text.trim()}
        onPress={() => onScanned(text.trim())}
      />
    </View>
  );
}
