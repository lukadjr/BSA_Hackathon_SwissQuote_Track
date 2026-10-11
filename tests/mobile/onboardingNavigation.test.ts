import { beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => vi.fn());
vi.mock('../../apps/mobile/src/lib/auth', () => ({ getSession: session }));
import {
  clearPausedOnboarding,
  pauseOnboarding,
  readPausedOnboarding,
} from '../../apps/mobile/src/lib/onboardingNavigation';

beforeEach(() => {
  clearPausedOnboarding();
  session.mockReset();
  session.mockResolvedValue({ username: 'alice', token: 'alice-session' });
});

it('resumes guardian setup after visiting the public guardian flow', async () => {
  await pauseOnboarding('/protect?onboarding=1');
  expect(await readPausedOnboarding()).toBe('/protect?onboarding=1');
  // Public screens do not replace the paused owner route.
  expect(await readPausedOnboarding()).toBe('/protect?onboarding=1');
});

it.each(['/start', '/kyc', '/setup'] as const)(
  'returns to the unfinished %s step',
  async (route) => {
    await pauseOnboarding(route);
    expect(await readPausedOnboarding()).toBe(route);
  },
);

it('cannot resume another account or advance without login', async () => {
  await pauseOnboarding('/protect?onboarding=1');
  session.mockResolvedValue({ username: 'bob', token: 'bob-session' });
  expect(await readPausedOnboarding()).toBeNull();
  session.mockResolvedValue(null);
  expect(await readPausedOnboarding()).toBeNull();
  await expect(pauseOnboarding('/setup')).rejects.toThrow(
    'Please log in again',
  );
});

it('preserves the login screen before authentication', async () => {
  session.mockResolvedValue(null);
  await pauseOnboarding('/login');
  expect(await readPausedOnboarding()).toBe('/login');
});

it('forgets paused screens after a reset or logout', async () => {
  await pauseOnboarding('/kyc');
  clearPausedOnboarding();
  expect(await readPausedOnboarding()).toBeNull();
});
