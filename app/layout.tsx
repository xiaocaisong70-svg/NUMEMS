import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NUMEMS · 席位申请中心",
  description: "自助申请 ChatGPT Business 席位，查看排队进度与使用期限。",
  icons: {
    icon: "/seat-icon.svg",
    shortcut: "/seat-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
