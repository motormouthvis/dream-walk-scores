import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Shared with the sibling Dream products so widgets sit together without clashing.
        brand: {
          DEFAULT: "#1fa55f",
          dark: "#17804a",
          light: "#e8f6ee",
        },
        ink: {
          DEFAULT: "#111827",
          muted: "#6b7280",
          faint: "#9ca3af",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
