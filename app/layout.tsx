import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dream Walk Scores",
  description:
    "Walk, Bike and Transit scores for any US address, computed from OpenStreetMap, GTFS and open Census data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
