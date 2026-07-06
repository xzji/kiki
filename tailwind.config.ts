import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        ink: {
          DEFAULT: "var(--color-text-primary)",
          strong: "var(--color-text-strong)",
          soft: "var(--color-text-secondary)",
          faint: "var(--color-text-tertiary)",
        },
        line: {
          DEFAULT: "var(--color-border-default)",
          strong: "var(--color-border-strong)",
          muted: "var(--color-border-muted)",
        },
        surface: {
          DEFAULT: "var(--color-surface-base)",
          hover: "var(--color-surface-hover)",
          subtle: "var(--color-surface-subtle)",
        },
        brand: {
          DEFAULT: "var(--color-brand)",
          soft: "var(--color-brand-soft)",
          surface: "var(--color-brand-surface)",
          bg: "var(--color-brand-bg)",
          border: "var(--color-brand-border)",
        },
        danger: {
          DEFAULT: "var(--color-danger)",
          hover: "var(--color-danger-hover)",
          strong: "var(--color-danger-strong)",
          bg: "var(--color-danger-bg)",
          border: "var(--color-danger-border)",
        },
        success: {
          DEFAULT: "var(--color-success)",
          strong: "var(--color-success-strong)",
          bg: "var(--color-success-bg)",
          border: "var(--color-success-border)",
        },
        warning: {
          DEFAULT: "var(--color-warning)",
          strong: "var(--color-warning-strong)",
          bg: "var(--color-warning-bg)",
          border: "var(--color-warning-border)",
        },
        info: {
          DEFAULT: "var(--color-info)",
          strong: "var(--color-info-strong)",
          bg: "var(--color-info-bg)",
          border: "var(--color-info-border)",
        },
        badge: "var(--color-badge)",
      },
    },
  },
  plugins: [],
};
export default config;
