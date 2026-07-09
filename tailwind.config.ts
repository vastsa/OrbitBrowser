import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        white: "rgb(var(--color-white) / <alpha-value>)",
        black: "rgb(var(--color-black) / <alpha-value>)",
        ink: {
          50: "rgb(var(--color-ink-50) / <alpha-value>)",
          100: "rgb(var(--color-ink-100) / <alpha-value>)",
          200: "rgb(var(--color-ink-200) / <alpha-value>)",
          300: "rgb(var(--color-ink-300) / <alpha-value>)",
          400: "rgb(var(--color-ink-400) / <alpha-value>)",
          500: "rgb(var(--color-ink-500) / <alpha-value>)",
          600: "rgb(var(--color-ink-600) / <alpha-value>)",
          700: "rgb(var(--color-ink-700) / <alpha-value>)",
          800: "rgb(var(--color-ink-800) / <alpha-value>)",
          900: "rgb(var(--color-ink-900) / <alpha-value>)",
        },
        line: "rgb(var(--color-line) / <alpha-value>)",
        brand: {
          50: "rgb(var(--color-brand-50) / <alpha-value>)",
          100: "rgb(var(--color-brand-100) / <alpha-value>)",
          200: "rgb(var(--color-brand-200) / <alpha-value>)",
          300: "rgb(var(--color-brand-300) / <alpha-value>)",
          400: "rgb(var(--color-brand-400) / <alpha-value>)",
          500: "rgb(var(--color-brand-500) / <alpha-value>)",
          600: "rgb(var(--color-brand-600) / <alpha-value>)",
          700: "rgb(var(--color-brand-700) / <alpha-value>)",
          800: "rgb(var(--color-brand-800) / <alpha-value>)",
          900: "rgb(var(--color-brand-900) / <alpha-value>)",
        },
        blue: {
          50: "rgb(var(--color-info) / 0.1)",
        },
        green: {
          50: "rgb(var(--color-ok-soft) / 0.14)",
          200: "rgb(var(--color-ok-contrast) / <alpha-value>)",
        },
        amber: {
          50: "rgb(var(--color-warn-soft) / 0.16)",
          200: "rgb(var(--color-warn-contrast) / <alpha-value>)",
        },
        red: {
          50: "rgb(var(--color-danger-soft) / 0.14)",
          700: "rgb(var(--color-danger-strong) / <alpha-value>)",
        },
        teal: {
          50: "rgb(var(--color-brand-800) / 0.14)",
        },
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        ok: "rgb(var(--color-ok) / <alpha-value>)",
        warn: "rgb(var(--color-warn) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        elevated: "var(--shadow-elevated)",
      },
    },
  },
  plugins: [],
};

export default config;
