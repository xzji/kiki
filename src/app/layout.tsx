import type { Metadata } from "next";
import localFont from "next/font/local";

import { AppShell } from "@/components/layout/AppShell";
import { AppProviders } from "@/components/providers/app-providers";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Dora Prototype",
  description: "目标驱动型自主 Agent 的高保真前端原型",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} bg-[#F5F6F8] font-sans text-[#1F2328] antialiased`}>
        <AppProviders>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}
