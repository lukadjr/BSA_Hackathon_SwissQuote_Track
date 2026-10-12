import { useEffect, useState, type PropsWithChildren } from 'react';
import {
  Dimensions,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';

/**
 * Android draws edge-to-edge, so the window no longer shrinks for the keyboard
 * and KeyboardAvoidingView mis-measures it: pad by the keyboard height instead.
 */
function useAndroidKeyboardInset() {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setInset(
        Math.max(0, Dimensions.get('screen').height - e.endCoordinates.screenY),
      ),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return inset;
}

/** Flex container that keeps its bottom content (actions, inputs) above the keyboard. */
export function KeyboardAware({
  children,
  className,
}: PropsWithChildren<{ className?: string }>) {
  const androidInset = useAndroidKeyboardInset();
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className={className ?? 'flex-1'}
      style={{ paddingBottom: androidInset }}
    >
      {children}
    </KeyboardAvoidingView>
  );
}
