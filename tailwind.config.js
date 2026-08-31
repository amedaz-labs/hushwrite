// Tailwind 3 can only apply an opacity modifier (`bg-x/30`) to a color it can
// parse, and it cannot parse a bare `var(--x)` — those classes silently emit
// no CSS at all. Handing it a *function* takes the `typeof color === 'function'`
// branch instead, where we get to build the value ourselves.
//
// `calc(${opacityValue} * 100%)` rather than `${opacityValue * 100}%` on
// purpose: `withAlphaVariable` passes the *string* `var(--tw-bg-opacity)`, and
// arithmetic on that yields NaN. calc() handles a literal and a var alike.
//
// HARD BROWSER FLOOR: `color-mix()` is now on the critical path for every
// colour in the vault palette, not just the opacity variants — a browser that
// can't parse it drops the whole declaration and renders the PWA effectively
// unstyled. That means Safari 16.2+, Chrome/Edge 111+, Firefox 113+ (iOS: any
// browser on iOS 16.2+, since they all use WebKit). Anything older is not
// supported. Do not "just add one more colour" here without accepting that.
const tint =
  (v) =>
  ({ opacityValue } = {}) =>
    opacityValue === undefined
      ? `var(${v})`
      : `color-mix(in srgb, var(${v}) calc(${opacityValue} * 100%), transparent)`;

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        // Existing semantic tokens (kept so shadcn primitives keep working)
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar))",
          foreground: "hsl(var(--sidebar-foreground))",
          border: "hsl(var(--sidebar-border))",
          muted: "hsl(var(--sidebar-muted))",
          item: "hsl(var(--sidebar-item))",
          "item-hover": "hsl(var(--sidebar-item-hover))",
        },

        // Vault palette — CSS-var backed so light/dark can swap via :root class
        "surface": tint("--v-surface"),
        "surface-dim": tint("--v-surface"),
        "surface-container-lowest": tint("--v-surface-container-lowest"),
        "surface-container-low": tint("--v-surface-container-low"),
        "surface-container": tint("--v-surface-container"),
        "surface-container-high": tint("--v-surface-container-high"),
        "surface-container-highest": tint("--v-surface-container-highest"),
        "surface-variant": tint("--v-surface-container-highest"),
        "on-surface": tint("--v-on-surface"),
        "on-background": tint("--v-on-surface"),
        "on-surface-variant": tint("--v-on-surface-variant"),
        "outline": tint("--v-outline"),
        "outline-variant": tint("--v-outline-variant"),
        "vault-primary": tint("--v-primary"),
        "primary-container": tint("--v-primary-container"),
        "on-primary-fixed": tint("--v-on-primary-fixed"),
        "tertiary": tint("--v-tertiary"),
        "error-container": tint("--v-error-container"),
        "on-error": tint("--v-on-error"),
        // Semantic status tones. `error` in particular had 41 usages and no
        // key behind it — every one of them painted nothing until now.
        "ok": tint("--v-ok"),
        "warn": tint("--v-warn"),
        "error": tint("--v-error"),
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        headline: ["Inter", "sans-serif"],
        body: ["Inter", "sans-serif"],
        label: ["Inter", "sans-serif"],
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "20%, 60%": { transform: "translateX(-6px)" },
          "40%, 80%": { transform: "translateX(6px)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        shake: "shake 0.4s ease-in-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
