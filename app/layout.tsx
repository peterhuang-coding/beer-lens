import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Beer Lens",
  description: "拍下酒单，找到今晚最值得喝的那杯。"
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f1f18"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      {/* suppressHydrationWarning: tolerates browser extensions
          (Grammarly adds data-gr-ext-installed / data-new-gr-c-s-check-loaded,
          Loom adds data-loom...) that mutate <body> before React loads. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
