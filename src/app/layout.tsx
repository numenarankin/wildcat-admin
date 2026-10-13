import type { Metadata } from "next";
import { Figtree, Geist_Mono } from "next/font/google";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { cookies } from "next/headers";
import { ThemeProvider } from "@/components/theme-provider";
import { parseTheme, THEME_CLASSES, THEME_COOKIE } from "@/lib/theme";

const figtree = Figtree({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    template: "%s | WildcatIQ Admin",
    default: "WildcatIQ Admin",
  },
  description: "WildcatIQ admin",
};

/**
 * The admin side is dark unless the viewer switched to light in the profile
 * menu. The theme's classes sit on <html> from the server render (read from
 * the cookie), so nothing, including anything portalled to <body>, ever
 * flashes the other theme.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html
      lang="en"
      className={[figtree.variable, geistMono.variable, ...THEME_CLASSES[theme], "h-full antialiased"].join(" ")}
    >
      <body className="min-h-full">
        <ThemeProvider initialTheme={theme}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
