/**
 * COMPOSE-WIKI-TAB-1: a second, scoped Tailwind pass for the `@wiki/components` screens (imported by
 * src/components/cockpit/wiki-tab.css through `@config`). The screens use the wiki's own colour names
 * (`ink`, `ground`, an inverted `neutral` scale, tinted status hues; smart-memory-wiki `ui/tailwind.config.js`).
 * Here those names map to Compose's tokens, and every class is emitted under `.wiki-tab` only, so
 * Compose's own `text-neutral-*`, `bg-blue-*` elsewhere keep Tailwind's defaults.
 */
import path from 'node:path';
import { resolveWikiComponentsDir } from './lib/wiki-components-link.js';

const dir = resolveWikiComponentsDir();
const tok = (name, alpha) => (alpha === undefined ? `hsl(var(--${name}))` : `hsl(var(--${name}) / ${alpha})`);
// A status hue: 50-300 are tints for chip fills and borders, 400 up the solid token for text and accents.
const hue = (name) => ({
  50: tok(name, 0.12), 100: tok(name, 0.18), 200: tok(name, 0.35), 300: tok(name, 0.5),
  400: tok(name), 500: tok(name), 600: tok(name), 700: tok(name), 800: tok(name),
});

export default {
  content: [dir ? path.join(dir, 'src/**/*.{js,jsx}') : './src/lib/wiki-components-stub.js'],
  important: '.wiki-tab',
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        ground: tok('background'), field: tok('card'), white: tok('card'), tile: tok('muted'), tile2: tok('secondary'),
        ink: tok('foreground'), ink2: tok('muted-foreground'), teal: tok('chart-2'), onblue: '#fff',
        // inverted like the wiki's: 50 is a raised tile, 900 is ink
        neutral: {
          50: tok('muted'), 100: tok('muted'), 200: tok('border'), 300: tok('input'), 400: tok('muted-foreground'),
          500: tok('muted-foreground'), 600: tok('muted-foreground'), 700: tok('foreground'), 800: tok('foreground'),
          900: tok('foreground'), 950: tok('foreground'),
        },
        blue: hue('sidebar-ring'), red: hue('destructive'), emerald: hue('success'), amber: hue('warning'),
        violet: hue('artifact'), orange: hue('chart-1'),
      },
      fontFamily: { mono: ["'Berkeley Mono'", "'JetBrains Mono'", 'Menlo', 'monospace'] },
    },
  },
};
