import { Platform } from 'react-native';

/** Name of the biometric prompt the user sees on this platform, for UI copy. */
export const BIOMETRY = Platform.OS === 'ios' ? 'Face ID' : 'fingerprint';
