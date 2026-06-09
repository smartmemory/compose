/**
 * navigation.jsx — COMP-COCKPIT-8 cross-view navigation context.
 *
 * App.jsx provides the value: { openItem, openGate, openView, openFeature }.
 * Consumers (EntityLink and friends) read it via useNavigation(); the hook
 * returns null when no provider is mounted (tests, mobile shell) so callers
 * can degrade to plain text instead of crashing.
 */
import { createContext, useContext } from 'react';

export const NavigationContext = createContext(null);

export function useNavigation() {
  return useContext(NavigationContext);
}
