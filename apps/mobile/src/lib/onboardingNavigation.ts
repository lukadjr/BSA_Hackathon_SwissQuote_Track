import { getSession } from './auth';

export type OnboardingRoute =
  | '/login'
  | '/start'
  | '/kyc'
  | '/setup'
  | '/protect?onboarding=1'
  | '/recover';

// Keep the original screen mounted in the navigation stack. In particular,
// backup words stay only in component memory, never in persistent storage.
let paused: { route: OnboardingRoute; username: string | null } | null = null;

export async function pauseOnboarding(route: OnboardingRoute) {
  const session = await getSession();
  if (route !== '/login' && !session) throw new Error('Please log in again.');
  paused = { route, username: session?.username ?? null };
}

export async function readPausedOnboarding(): Promise<OnboardingRoute | null> {
  if (!paused) return null;
  const session = await getSession();
  if (paused.route === '/login' && !paused.username && !session)
    return '/login';
  if (!session || session.username !== paused.username) return null;
  return paused.route;
}

export function clearPausedOnboarding() {
  paused = null;
}
