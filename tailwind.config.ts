import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f8fafc",
          100: "#f1f5f9",
          200: "#e2e8f0",
          300: "#cbd5e1",
          500: "#64748b",
          700: "#334155",
          800: "#1e293b",
          900: "#0f172a",
        },
        line: "#dbe4ef",
        brand: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          500: "#0d9488",
          600: "#0f766e",
          700: "#115e59",
        },
        accent: "#f97316",
        ok: "#15803d",
        warn: "#b45309",
        danger: "#b91c1c",
      },
      boxShadow: {
        panel: "0 1px 2px rgba(15, 23, 42, 0.05)",
        elevated: "0 16px 40px rgba(15, 23, 42, 0.07)",
      },
    },
  },
  plugins: [],
};

export default config;
