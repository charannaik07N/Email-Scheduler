import { useSyncExternalStore } from 'react';

const darkQuery = '(prefers-color-scheme: dark)';
const subscribeToScheme = (onChange: () => void) => {
  const media = window.matchMedia(darkQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/** Follows the OS light/dark setting. */
export const usePrefersDark = () =>
  useSyncExternalStore(
    subscribeToScheme,
    () => window.matchMedia(darkQuery).matches,
    () => false
  );
